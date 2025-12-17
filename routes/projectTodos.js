/**
 * Project Todos Routes
 * Endpoints for managing project todos and todo categories
 */

const express = require('express');
const router = express.Router();
const { query } = require('../database/config');
const { authenticateToken } = require('../middleware/auth');
const { body, param, validationResult } = require('express-validator');

// ============================================
// TODO CATEGORIES ENDPOINTS
// ============================================

// GET /api/project-todos/projects/:projectId/categories - List categories for a project
router.get('/projects/:projectId/categories', authenticateToken, async (req, res) => {
  try {
    const { projectId } = req.params;

    const result = await query(`
      SELECT * FROM project_todo_categories
      WHERE project_id = $1 AND activo = true
      ORDER BY nombre
    `, [projectId]);

    res.json({
      success: true,
      categories: result.rows
    });
  } catch (error) {
    console.error('Error fetching todo categories:', error);
    res.status(500).json({ success: false, message: 'Error al obtener categorías' });
  }
});

// POST /api/project-todos/projects/:projectId/categories - Create category
router.post('/projects/:projectId/categories', authenticateToken, [
  body('nombre').trim().notEmpty().withMessage('Nombre es requerido'),
  body('color').optional().trim()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { projectId } = req.params;
    const { nombre, color } = req.body;

    // Check if an inactive category with this name exists (soft-deleted)
    const existing = await query(`
      SELECT * FROM project_todo_categories
      WHERE project_id = $1 AND nombre = $2 AND activo = false
    `, [projectId, nombre]);

    let result;
    if (existing.rows.length > 0) {
      // Reactivate the soft-deleted category
      result = await query(`
        UPDATE project_todo_categories
        SET activo = true, color = $1, updated_at = CURRENT_TIMESTAMP
        WHERE id = $2
        RETURNING *
      `, [color || '#6b7280', existing.rows[0].id]);
    } else {
      // Create new category
      result = await query(`
        INSERT INTO project_todo_categories (project_id, nombre, color)
        VALUES ($1, $2, $3)
        RETURNING *
      `, [projectId, nombre, color || '#6b7280']);
    }

    res.status(201).json({
      success: true,
      category: result.rows[0]
    });
  } catch (error) {
    if (error.code === '23505') { // Unique violation
      return res.status(400).json({ success: false, message: 'Ya existe una categoría con ese nombre' });
    }
    console.error('Error creating todo category:', error);
    res.status(500).json({ success: false, message: 'Error al crear categoría' });
  }
});

// PUT /api/project-todos/categories/:id - Update category
router.put('/categories/:id', authenticateToken, [
  body('nombre').optional().trim().notEmpty(),
  body('color').optional().trim()
], async (req, res) => {
  try {
    const { id } = req.params;
    const { nombre, color } = req.body;

    const result = await query(`
      UPDATE project_todo_categories
      SET nombre = COALESCE($1, nombre),
          color = COALESCE($2, color),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $3
      RETURNING *
    `, [nombre, color, id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Categoría no encontrada' });
    }

    res.json({
      success: true,
      category: result.rows[0]
    });
  } catch (error) {
    console.error('Error updating todo category:', error);
    res.status(500).json({ success: false, message: 'Error al actualizar categoría' });
  }
});

// DELETE /api/project-todos/categories/:id - Soft delete category
router.delete('/categories/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    await query(`
      UPDATE project_todo_categories
      SET activo = false, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
    `, [id]);

    // Set category_id to null for todos using this category
    await query(`
      UPDATE project_todos
      SET category_id = NULL
      WHERE category_id = $1
    `, [id]);

    res.json({ success: true, message: 'Categoría eliminada' });
  } catch (error) {
    console.error('Error deleting todo category:', error);
    res.status(500).json({ success: false, message: 'Error al eliminar categoría' });
  }
});

// ============================================
// TODOS ENDPOINTS
// ============================================

// GET /api/project-todos/projects/:projectId - List todos for a project
router.get('/projects/:projectId', authenticateToken, async (req, res) => {
  try {
    const { projectId } = req.params;
    const { estado, prioridad, asignado_a, category_id } = req.query;

    let sql = `
      SELECT
        t.*,
        c.nombre as categoria_nombre,
        c.color as categoria_color,
        u.nombre as creador_nombre,
        uc.nombre as completado_por_nombre,
        CASE
          WHEN pm.tipo_miembro = 'usuario' THEN usr.nombre
          WHEN pm.tipo_miembro = 'externo' THEN ec.nombre
          ELSE NULL
        END as asignado_nombre,
        pm.tipo_miembro as asignado_tipo
      FROM project_todos t
      LEFT JOIN project_todo_categories c ON t.category_id = c.id
      LEFT JOIN users u ON t.created_by = u.id
      LEFT JOIN users uc ON t.completado_por = uc.id
      LEFT JOIN project_members pm ON t.asignado_a = pm.id
      LEFT JOIN users usr ON pm.user_id = usr.id AND pm.tipo_miembro = 'usuario'
      LEFT JOIN external_contacts ec ON pm.external_contact_id = ec.id AND pm.tipo_miembro = 'externo'
      WHERE t.project_id = $1
    `;

    const params = [projectId];
    let paramIndex = 2;

    if (estado) {
      sql += ` AND t.estado = $${paramIndex}`;
      params.push(estado);
      paramIndex++;
    }

    if (prioridad) {
      sql += ` AND t.prioridad = $${paramIndex}`;
      params.push(prioridad);
      paramIndex++;
    }

    if (asignado_a) {
      sql += ` AND t.asignado_a = $${paramIndex}`;
      params.push(asignado_a);
      paramIndex++;
    }

    if (category_id) {
      sql += ` AND t.category_id = $${paramIndex}`;
      params.push(category_id);
      paramIndex++;
    }

    sql += ` ORDER BY
      CASE t.estado WHEN 'pendiente' THEN 0 ELSE 1 END,
      CASE t.prioridad WHEN 'alta' THEN 0 WHEN 'media' THEN 1 ELSE 2 END,
      t.fecha_limite NULLS LAST,
      t.created_at DESC
    `;

    const result = await query(sql, params);

    // Get stats
    const statsResult = await query(`
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE estado = 'pendiente') as pendientes,
        COUNT(*) FILTER (WHERE estado = 'completado') as completados,
        COUNT(*) FILTER (WHERE prioridad = 'alta' AND estado = 'pendiente') as alta_prioridad
      FROM project_todos
      WHERE project_id = $1
    `, [projectId]);

    res.json({
      success: true,
      todos: result.rows,
      stats: statsResult.rows[0]
    });
  } catch (error) {
    console.error('Error fetching todos:', error);
    res.status(500).json({ success: false, message: 'Error al obtener tareas' });
  }
});

// POST /api/project-todos/projects/:projectId - Create todo
router.post('/projects/:projectId', authenticateToken, [
  body('titulo').trim().notEmpty().withMessage('Título es requerido'),
  body('descripcion').optional({ nullable: true }).trim(),
  body('category_id').optional({ nullable: true }),
  body('asignado_a').optional({ nullable: true }),
  body('fecha_limite').optional({ nullable: true }),
  body('prioridad').optional({ nullable: true }).isIn(['alta', 'media', 'baja'])
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { projectId } = req.params;
    const { titulo, descripcion, category_id, asignado_a, fecha_limite, prioridad } = req.body;
    const userId = req.user.id;

    const result = await query(`
      INSERT INTO project_todos (
        project_id, titulo, descripcion, category_id, asignado_a,
        fecha_limite, prioridad, created_by
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `, [
      projectId, titulo, descripcion || null, category_id || null,
      asignado_a || null, fecha_limite || null, prioridad || 'media', userId
    ]);

    res.status(201).json({
      success: true,
      todo: result.rows[0]
    });
  } catch (error) {
    console.error('Error creating todo:', error);
    res.status(500).json({ success: false, message: 'Error al crear tarea' });
  }
});

// PUT /api/project-todos/:id - Update todo
router.put('/:id', authenticateToken, [
  body('titulo').optional({ nullable: true }).trim().notEmpty(),
  body('descripcion').optional({ nullable: true }).trim(),
  body('category_id').optional({ nullable: true }),
  body('asignado_a').optional({ nullable: true }),
  body('fecha_limite').optional({ nullable: true }),
  body('prioridad').optional({ nullable: true }).isIn(['alta', 'media', 'baja'])
], async (req, res) => {
  try {
    const { id } = req.params;
    const { titulo, descripcion, category_id, asignado_a, fecha_limite, prioridad } = req.body;

    const result = await query(`
      UPDATE project_todos
      SET titulo = COALESCE($1, titulo),
          descripcion = COALESCE($2, descripcion),
          category_id = $3,
          asignado_a = $4,
          fecha_limite = $5,
          prioridad = COALESCE($6, prioridad),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $7
      RETURNING *
    `, [titulo, descripcion, category_id || null, asignado_a || null, fecha_limite || null, prioridad, id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Tarea no encontrada' });
    }

    res.json({
      success: true,
      todo: result.rows[0]
    });
  } catch (error) {
    console.error('Error updating todo:', error);
    res.status(500).json({ success: false, message: 'Error al actualizar tarea' });
  }
});

// PATCH /api/project-todos/:id/toggle - Toggle todo status
router.patch('/:id/toggle', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    // Get current state
    const current = await query('SELECT estado FROM project_todos WHERE id = $1', [id]);
    if (current.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Tarea no encontrada' });
    }

    const isCompleting = current.rows[0].estado === 'pendiente';
    const nuevoEstado = isCompleting ? 'completado' : 'pendiente';

    // Calculate values in JS to avoid PostgreSQL type inference issues
    const result = await query(`
      UPDATE project_todos
      SET estado = $1,
          completado_at = $2,
          completado_por = $3,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $4
      RETURNING *
    `, [
      nuevoEstado,
      isCompleting ? new Date() : null,
      isCompleting ? userId : null,
      id
    ]);

    res.json({
      success: true,
      todo: result.rows[0]
    });
  } catch (error) {
    console.error('Error toggling todo:', error);
    res.status(500).json({ success: false, message: 'Error al cambiar estado' });
  }
});

// DELETE /api/project-todos/:id - Delete todo
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await query('DELETE FROM project_todos WHERE id = $1 RETURNING id', [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Tarea no encontrada' });
    }

    res.json({ success: true, message: 'Tarea eliminada' });
  } catch (error) {
    console.error('Error deleting todo:', error);
    res.status(500).json({ success: false, message: 'Error al eliminar tarea' });
  }
});

// ============================================
// COMMENTS ENDPOINTS
// ============================================

// GET /api/project-todos/:todoId/comments - List comments for a todo
router.get('/:todoId/comments', authenticateToken, async (req, res) => {
  try {
    const { todoId } = req.params;

    const result = await query(`
      SELECT
        c.*,
        u.nombre as usuario_nombre
      FROM project_todo_comments c
      JOIN users u ON c.user_id = u.id
      WHERE c.todo_id = $1
      ORDER BY c.created_at ASC
    `, [todoId]);

    res.json({
      success: true,
      comments: result.rows
    });
  } catch (error) {
    console.error('Error fetching comments:', error);
    res.status(500).json({ success: false, message: 'Error al obtener comentarios' });
  }
});

// POST /api/project-todos/:todoId/comments - Add a comment
router.post('/:todoId/comments', authenticateToken, [
  body('contenido').trim().notEmpty().withMessage('El comentario no puede estar vacío')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { todoId } = req.params;
    const { contenido } = req.body;
    const userId = req.user.id;

    const result = await query(`
      INSERT INTO project_todo_comments (todo_id, user_id, contenido)
      VALUES ($1, $2, $3)
      RETURNING *
    `, [todoId, userId, contenido]);

    // Get user name for the response
    const userResult = await query('SELECT nombre FROM users WHERE id = $1', [userId]);

    res.status(201).json({
      success: true,
      comment: {
        ...result.rows[0],
        usuario_nombre: userResult.rows[0]?.nombre
      }
    });
  } catch (error) {
    console.error('Error adding comment:', error);
    res.status(500).json({ success: false, message: 'Error al agregar comentario' });
  }
});

// DELETE /api/project-todos/comments/:commentId - Delete a comment
router.delete('/comments/:commentId', authenticateToken, async (req, res) => {
  try {
    const { commentId } = req.params;
    const userId = req.user.id;

    // Only allow deleting own comments
    const result = await query(
      'DELETE FROM project_todo_comments WHERE id = $1 AND user_id = $2 RETURNING id',
      [commentId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Comentario no encontrado o no tienes permiso para eliminarlo'
      });
    }

    res.json({ success: true, message: 'Comentario eliminado' });
  } catch (error) {
    console.error('Error deleting comment:', error);
    res.status(500).json({ success: false, message: 'Error al eliminar comentario' });
  }
});

module.exports = router;
