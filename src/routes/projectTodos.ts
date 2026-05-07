/**
 * Project Todos Routes
 * Endpoints for managing project todos and todo categories
 */

import { Router, Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import { query } from '../database/config.js';
import { authenticateToken } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

const router = Router();

// Types
interface TodoCategoryRow {
  id: number;
  proyecto_id: number;
  nombre: string;
  color: string;
  activo: boolean;
  created_at: Date;
  updated_at: Date;
}

interface TodoRow {
  id: number;
  proyecto_id: number;
  titulo: string;
  descripcion?: string;
  categoria_id?: number;
  asignado_a?: number;
  fecha_limite?: Date;
  prioridad: 'alta' | 'media' | 'baja';
  estado: 'pendiente' | 'completado';
  creado_por: number;
  completado_por?: number;
  completado_at?: Date;
  created_at: Date;
  updated_at: Date;
  // Joined fields
  categoria_nombre?: string;
  categoria_color?: string;
  creador_nombre?: string;
  completado_por_nombre?: string;
  asignado_nombre?: string;
  asignado_tipo?: string;
}

interface TodoStatsRow {
  total: string;
  pendientes: string;
  completados: string;
  alta_prioridad: string;
}

interface TodoCommentRow {
  id: number;
  tarea_id: number;
  user_id: number;
  contenido: string;
  created_at: Date;
  usuario_nombre?: string;
}

interface QueryParams {
  estado?: string;
  prioridad?: string;
  asignado_a?: string;
  categoria_id?: string;
}

interface CreateCategoryBody {
  nombre: string;
  color?: string;
}

interface CreateTodoBody {
  titulo: string;
  descripcion?: string;
  categoria_id?: number;
  asignado_a?: number;
  fecha_limite?: string;
  prioridad?: 'alta' | 'media' | 'baja';
}

interface CommentBody {
  contenido: string;
}

// ============================================
// TODO CATEGORIES ENDPOINTS
// ============================================

// GET /api/project-todos/projects/:projectId/categories - List categories for a project
router.get(
  '/projects/:projectId/categories',
  authenticateToken,
  asyncHandler(
    async (
      req: Request<{ projectId: string }>,
      res: Response,
    ): Promise<void> => {
      const { projectId } = req.params;

      const result = await query<TodoCategoryRow>(
        `
    SELECT * FROM proyecto_categorias_tareas
    WHERE proyecto_id = $1 AND activo = true
    ORDER BY nombre
  `,
        [projectId],
      );

      res.json({
        success: true,
        categories: result.rows,
      });
    },
  ),
);

// POST /api/project-todos/projects/:projectId/categories - Create category
router.post(
  '/projects/:projectId/categories',
  authenticateToken,
  [
    body('nombre').trim().notEmpty().withMessage('Nombre es requerido'),
    body('color').optional().trim(),
  ],
  asyncHandler(
    async (
      req: Request<{ projectId: string }, object, CreateCategoryBody>,
      res: Response,
    ): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({ success: false, errors: errors.array() });
        return;
      }

      const { projectId } = req.params;
      const { nombre, color } = req.body;

      // Check if an inactive category with this name exists (soft-deleted)
      const existing = await query<TodoCategoryRow>(
        `
    SELECT * FROM proyecto_categorias_tareas
    WHERE proyecto_id = $1 AND nombre = $2 AND activo = false
  `,
        [projectId, nombre],
      );

      let result;
      if (existing.rows.length > 0) {
        // Reactivate the soft-deleted category
        result = await query<TodoCategoryRow>(
          `
      UPDATE proyecto_categorias_tareas
      SET activo = true, color = $1, updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
      RETURNING *
    `,
          [color || '#6b7280', existing.rows[0].id],
        );
      } else {
        // Create new category
        result = await query<TodoCategoryRow>(
          `
      INSERT INTO proyecto_categorias_tareas (proyecto_id, nombre, color)
      VALUES ($1, $2, $3)
      RETURNING *
    `,
          [projectId, nombre, color || '#6b7280'],
        );
      }

      res.status(201).json({
        success: true,
        category: result.rows[0],
      });
    },
    {
      duplicateMessage: 'Ya existe una categoría con ese nombre',
    },
  ),
);

// PUT /api/project-todos/categories/:id - Update category
router.put(
  '/categories/:id',
  authenticateToken,
  [
    body('nombre').optional().trim().notEmpty(),
    body('color').optional().trim(),
  ],
  asyncHandler(
    async (
      req: Request<{ id: string }, object, CreateCategoryBody>,
      res: Response,
    ): Promise<void> => {
      const { id } = req.params;
      const { nombre, color } = req.body;

      const result = await query<TodoCategoryRow>(
        `
    UPDATE proyecto_categorias_tareas
    SET nombre = COALESCE($1, nombre),
        color = COALESCE($2, color),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = $3
    RETURNING *
  `,
        [nombre, color, id],
      );

      if (result.rows.length === 0) {
        res
          .status(404)
          .json({ success: false, message: 'Categoría no encontrada' });
        return;
      }

      res.json({
        success: true,
        category: result.rows[0],
      });
    },
  ),
);

// DELETE /api/project-todos/categories/:id - Soft delete category
router.delete(
  '/categories/:id',
  authenticateToken,
  asyncHandler(
    async (req: Request<{ id: string }>, res: Response): Promise<void> => {
      const { id } = req.params;

      await query(
        `
    UPDATE proyecto_categorias_tareas
    SET activo = false, updated_at = CURRENT_TIMESTAMP
    WHERE id = $1
  `,
        [id],
      );

      // Set categoria_id to null for todos using this category
      await query(
        `
    UPDATE proyecto_tareas
    SET categoria_id = NULL
    WHERE categoria_id = $1
  `,
        [id],
      );

      res.json({ success: true, message: 'Categoría eliminada' });
    },
  ),
);

// ============================================
// TODOS ENDPOINTS
// ============================================

// GET /api/project-todos/projects/:projectId - List todos for a project
router.get(
  '/projects/:projectId',
  authenticateToken,
  asyncHandler(
    async (
      req: Request<{ projectId: string }, object, object, QueryParams>,
      res: Response,
    ): Promise<void> => {
      const { projectId } = req.params;
      const { estado, prioridad, asignado_a, categoria_id } = req.query;

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
    FROM proyecto_tareas t
    LEFT JOIN proyecto_categorias_tareas c ON t.categoria_id = c.id
    LEFT JOIN users u ON t.creado_por = u.id
    LEFT JOIN users uc ON t.completado_por = uc.id
    LEFT JOIN project_members pm ON t.asignado_a = pm.id
    LEFT JOIN users usr ON pm.user_id = usr.id AND pm.tipo_miembro = 'usuario'
    LEFT JOIN external_contacts ec ON pm.external_contact_id = ec.id AND pm.tipo_miembro = 'externo'
    WHERE t.proyecto_id = $1
  `;

      const params: unknown[] = [projectId];
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

      if (categoria_id) {
        sql += ` AND t.categoria_id = $${paramIndex}`;
        params.push(categoria_id);
        paramIndex++;
      }

      sql += ` ORDER BY
    CASE t.estado WHEN 'pendiente' THEN 0 ELSE 1 END,
    CASE t.prioridad WHEN 'alta' THEN 0 WHEN 'media' THEN 1 ELSE 2 END,
    t.fecha_limite NULLS LAST,
    t.created_at DESC
  `;

      const result = await query<TodoRow>(sql, params);

      // Get stats
      const statsResult = await query<TodoStatsRow>(
        `
    SELECT
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE estado = 'pendiente') as pendientes,
      COUNT(*) FILTER (WHERE estado = 'completado') as completados,
      COUNT(*) FILTER (WHERE prioridad = 'alta' AND estado = 'pendiente') as alta_prioridad
    FROM proyecto_tareas
    WHERE proyecto_id = $1
  `,
        [projectId],
      );

      res.json({
        success: true,
        todos: result.rows,
        stats: statsResult.rows[0],
      });
    },
  ),
);

// POST /api/project-todos/projects/:projectId - Create todo
router.post(
  '/projects/:projectId',
  authenticateToken,
  [
    body('titulo').trim().notEmpty().withMessage('Título es requerido'),
    body('descripcion').optional({ nullable: true }).trim(),
    body('categoria_id').optional({ nullable: true }),
    body('asignado_a').optional({ nullable: true }),
    body('fecha_limite').optional({ nullable: true }),
    body('prioridad')
      .optional({ nullable: true })
      .isIn(['alta', 'media', 'baja']),
  ],
  asyncHandler(
    async (
      req: Request<{ projectId: string }, object, CreateTodoBody>,
      res: Response,
    ): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({ success: false, errors: errors.array() });
        return;
      }

      const { projectId } = req.params;
      const {
        titulo,
        descripcion,
        categoria_id,
        asignado_a,
        fecha_limite,
        prioridad,
      } = req.body;
      const userId = req.user!.id;

      const result = await query<TodoRow>(
        `
    INSERT INTO proyecto_tareas (
      proyecto_id, titulo, descripcion, categoria_id, asignado_a,
      fecha_limite, prioridad, creado_por
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING *
  `,
        [
          projectId,
          titulo,
          descripcion || null,
          categoria_id || null,
          asignado_a || null,
          fecha_limite || null,
          prioridad || 'media',
          userId,
        ],
      );

      res.status(201).json({
        success: true,
        todo: result.rows[0],
      });
    },
  ),
);

// PUT /api/project-todos/:id - Update todo
router.put(
  '/:id',
  authenticateToken,
  [
    body('titulo').optional({ nullable: true }).trim().notEmpty(),
    body('descripcion').optional({ nullable: true }).trim(),
    body('categoria_id').optional({ nullable: true }),
    body('asignado_a').optional({ nullable: true }),
    body('fecha_limite').optional({ nullable: true }),
    body('prioridad')
      .optional({ nullable: true })
      .isIn(['alta', 'media', 'baja']),
  ],
  asyncHandler(
    async (
      req: Request<{ id: string }, object, CreateTodoBody>,
      res: Response,
    ): Promise<void> => {
      const { id } = req.params;
      const {
        titulo,
        descripcion,
        categoria_id,
        asignado_a,
        fecha_limite,
        prioridad,
      } = req.body;

      const result = await query<TodoRow>(
        `
    UPDATE proyecto_tareas
    SET titulo = COALESCE($1, titulo),
        descripcion = COALESCE($2, descripcion),
        categoria_id = $3,
        asignado_a = $4,
        fecha_limite = $5,
        prioridad = COALESCE($6, prioridad),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = $7
    RETURNING *
  `,
        [
          titulo,
          descripcion,
          categoria_id || null,
          asignado_a || null,
          fecha_limite || null,
          prioridad,
          id,
        ],
      );

      if (result.rows.length === 0) {
        res
          .status(404)
          .json({ success: false, message: 'Tarea no encontrada' });
        return;
      }

      res.json({
        success: true,
        todo: result.rows[0],
      });
    },
  ),
);

// PATCH /api/project-todos/:id/toggle - Toggle todo status
router.patch(
  '/:id/toggle',
  authenticateToken,
  asyncHandler(
    async (req: Request<{ id: string }>, res: Response): Promise<void> => {
      const { id } = req.params;
      const userId = req.user!.id;

      // Get current state
      const current = await query<{ estado: string }>(
        'SELECT estado FROM proyecto_tareas WHERE id = $1',
        [id],
      );
      if (current.rows.length === 0) {
        res
          .status(404)
          .json({ success: false, message: 'Tarea no encontrada' });
        return;
      }

      const isCompleting = current.rows[0].estado === 'pendiente';
      const nuevoEstado = isCompleting ? 'completado' : 'pendiente';

      // Calculate values in JS to avoid PostgreSQL type inference issues
      const result = await query<TodoRow>(
        `
    UPDATE proyecto_tareas
    SET estado = $1,
        completado_at = $2,
        completado_por = $3,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = $4
    RETURNING *
  `,
        [
          nuevoEstado,
          isCompleting ? new Date() : null,
          isCompleting ? userId : null,
          id,
        ],
      );

      res.json({
        success: true,
        todo: result.rows[0],
      });
    },
  ),
);

// DELETE /api/project-todos/:id - Delete todo
router.delete(
  '/:id',
  authenticateToken,
  asyncHandler(
    async (req: Request<{ id: string }>, res: Response): Promise<void> => {
      const { id } = req.params;

      const result = await query<{ id: number }>(
        'DELETE FROM proyecto_tareas WHERE id = $1 RETURNING id',
        [id],
      );

      if (result.rows.length === 0) {
        res
          .status(404)
          .json({ success: false, message: 'Tarea no encontrada' });
        return;
      }

      res.json({ success: true, message: 'Tarea eliminada' });
    },
  ),
);

// ============================================
// COMMENTS ENDPOINTS
// ============================================

// GET /api/project-todos/:todoId/comments - List comments for a todo
router.get(
  '/:todoId/comments',
  authenticateToken,
  asyncHandler(
    async (req: Request<{ todoId: string }>, res: Response): Promise<void> => {
      const { todoId } = req.params;

      const result = await query<TodoCommentRow>(
        `
    SELECT
      c.*,
      u.nombre as usuario_nombre
    FROM proyecto_tareas_comentarios c
    JOIN users u ON c.user_id = u.id
    WHERE c.tarea_id = $1
    ORDER BY c.created_at ASC
  `,
        [todoId],
      );

      res.json({
        success: true,
        comments: result.rows,
      });
    },
  ),
);

// POST /api/project-todos/:todoId/comments - Add a comment
router.post(
  '/:todoId/comments',
  authenticateToken,
  [
    body('contenido')
      .trim()
      .notEmpty()
      .withMessage('El comentario no puede estar vacío'),
  ],
  asyncHandler(
    async (
      req: Request<{ todoId: string }, object, CommentBody>,
      res: Response,
    ): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({ success: false, errors: errors.array() });
        return;
      }

      const { todoId } = req.params;
      const { contenido } = req.body;
      const userId = req.user!.id;

      const result = await query<TodoCommentRow>(
        `
    INSERT INTO proyecto_tareas_comentarios (tarea_id, user_id, contenido)
    VALUES ($1, $2, $3)
    RETURNING *
  `,
        [todoId, userId, contenido],
      );

      // Get user name for the response
      const userResult = await query<{ nombre: string }>(
        'SELECT nombre FROM users WHERE id = $1',
        [userId],
      );

      res.status(201).json({
        success: true,
        comment: {
          ...result.rows[0],
          usuario_nombre: userResult.rows[0]?.nombre,
        },
      });
    },
  ),
);

// DELETE /api/project-todos/comments/:commentId - Delete a comment
router.delete(
  '/comments/:commentId',
  authenticateToken,
  asyncHandler(
    async (
      req: Request<{ commentId: string }>,
      res: Response,
    ): Promise<void> => {
      const { commentId } = req.params;
      const userId = req.user!.id;

      // Only allow deleting own comments
      const result = await query<{ id: number }>(
        'DELETE FROM proyecto_tareas_comentarios WHERE id = $1 AND user_id = $2 RETURNING id',
        [commentId, userId],
      );

      if (result.rows.length === 0) {
        res.status(404).json({
          success: false,
          message:
            'Comentario no encontrado o no tienes permiso para eliminarlo',
        });
        return;
      }

      res.json({ success: true, message: 'Comentario eliminado' });
    },
  ),
);

export default router;
