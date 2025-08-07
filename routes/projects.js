const express = require('express');
const { body, validationResult, param } = require('express-validator');
const { query } = require('../database/config');
const { authenticateToken, requireManager } = require('../middleware/auth');

const router = express.Router();

// Obtener todos los proyectos
router.get('/', authenticateToken, async (req, res) => {
  try {

    console.log('=== DEBUG GET PROJECTS ===');
    console.log('User:', req.user);
    console.log('Query params:', req.query);

    const { estado, manager_id, page = 1, limit = 10 } = req.query;

    let whereClause = 'WHERE p.activo = true';
    const queryParams = [];
    let paramCounter = 1;

    console.log('Initial whereClause:', whereClause);

    // Filtros opcionales
    if (estado) {
      whereClause += ` AND p.estado = $${paramCounter}`;
      queryParams.push(estado);
      paramCounter++;
    }

    if (manager_id) {
      whereClause += ` AND p.manager_id = $${paramCounter}`;
      queryParams.push(manager_id);
      paramCounter++;
    }

    // Si no es admin, solo ver proyectos asignados
    if (req.user.rol !== 'admin') {
      whereClause += ` AND (p.manager_id = $${paramCounter} OR pu.user_id = $${paramCounter})`;
      queryParams.push(req.user.id);
      paramCounter++;
    }

    // Paginación
    const offset = (page - 1) * limit;
    queryParams.push(limit, offset);
    paramCounter += 2;

    console.log('Final whereClause:', whereClause);
    console.log('Query params array:', queryParams);
    console.log('Param counter:', paramCounter);


    const result = await query(`
        SELECT
            p.*,
            c.nombre as cliente_nombre,
            u.nombre as manager_nombre,
            COUNT(DISTINCT pu.user_id) as usuarios_asignados
        FROM proyectos p
                 LEFT JOIN clientes c ON p.cliente_id = c.id
                 LEFT JOIN users u ON p.manager_id = u.id
                 LEFT JOIN proyecto_usuarios pu ON p.id = pu.proyecto_id
            ${whereClause}
        GROUP BY p.id, c.nombre, u.nombre
        ORDER BY p.created_at DESC
            LIMIT $${paramCounter} OFFSET $${paramCounter + 1}
    `, queryParams);

    // Contar total para paginación
    const countResult = await query(`
        SELECT COUNT(DISTINCT p.id) as total
        FROM proyectos p
                 LEFT JOIN proyecto_usuarios pu ON p.id = pu.proyecto_id
            ${whereClause.replace(/LIMIT.*OFFSET.*/, '')}
    `, queryParams.slice(0, -2));

    res.json({
      success: true,
      proyectos: result.rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: parseInt(countResult.rows[0].total),
        totalPages: Math.ceil(countResult.rows[0].total / limit)
      }
    });

  } catch (error) {
    console.error('Error obteniendo proyectos:', error);
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor'
    });
  }
});

// Obtener proyecto específico
router.get('/:id', [
  param('id').isInt().withMessage('ID debe ser un número'),
  authenticateToken
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'ID inválido',
        errors: errors.array()
      });
    }

    const { id } = req.params;

    const result = await query(`
      SELECT 
        p.*,
        c.nombre as cliente_nombre,
        c.contacto as cliente_contacto,
        c.telefono as cliente_telefono,
        c.email as cliente_email,
        u.nombre as manager_nombre
      FROM proyectos p
      LEFT JOIN clientes c ON p.cliente_id = c.id
      LEFT JOIN users u ON p.manager_id = u.id
      WHERE p.id = $1 AND p.activo = true
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Proyecto no encontrado'
      });
    }

    const proyecto = result.rows[0];

    // Verificar permisos
    if (req.user.rol !== 'admin' && req.user.rol !== 'project_manager') {
      // Verificar si está asignado al proyecto
      const assignmentResult = await query(
        'SELECT 1 FROM proyecto_usuarios WHERE proyecto_id = $1 AND user_id = $2',
        [id, req.user.id]
      );

      if (assignmentResult.rows.length === 0 && proyecto.manager_id !== req.user.id) {
        return res.status(403).json({
          success: false,
          message: 'No tienes permisos para ver este proyecto'
        });
      }
    }

    // Obtener usuarios asignados
    const usuariosResult = await query(`
      SELECT u.id, u.nombre, u.email, pu.rol_proyecto
      FROM proyecto_usuarios pu
      JOIN users u ON pu.user_id = u.id
      WHERE pu.proyecto_id = $1 AND u.activo = true
    `, [id]);

    proyecto.usuarios_asignados = usuariosResult.rows;

    res.json({
      success: true,
      proyecto
    });

  } catch (error) {
    console.error('Error obteniendo proyecto:', error);
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor'
    });
  }
});

// Crear nuevo proyecto
router.post('/', [
  body('nombre').trim().isLength({ min: 2 }).withMessage('Nombre debe tener al menos 2 caracteres'),
  body('descripcion').optional().trim(),
  body('cliente_id').optional().isInt().withMessage('Cliente ID debe ser un número'),
  body('ubicacion').optional().trim(),
  body('fecha_inicio').optional().isDate().withMessage('Fecha de inicio inválida'),
  body('fecha_fin_estimada').optional().isDate().withMessage('Fecha fin estimada inválida'),
  body('presupuesto_inicial').optional().isNumeric().withMessage('Presupuesto inicial debe ser un número'),
  body('manager_id').optional().isInt().withMessage('Manager ID debe ser un número'),
  authenticateToken,
  requireManager
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Datos inválidos',
        errors: errors.array()
      });
    }

    const {
      nombre,
      descripcion,
      cliente_id,
      ubicacion,
      fecha_inicio,
      fecha_fin_estimada,
      presupuesto_inicial,
      manager_id
    } = req.body;

    // Si no es admin, asignarse a sí mismo como manager
    const finalManagerId = req.user.rol === 'admin' ? (manager_id || req.user.id) : req.user.id;

    const result = await query(`
      INSERT INTO proyectos (
        nombre, descripcion, cliente_id, ubicacion, 
        fecha_inicio, fecha_fin_estimada, presupuesto_inicial, 
        presupuesto_actual, manager_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8)
      RETURNING *
    `, [
      nombre, descripcion, cliente_id, ubicacion,
      fecha_inicio, fecha_fin_estimada, presupuesto_inicial,
      finalManagerId
    ]);

    const newProject = result.rows[0];

    res.status(201).json({
      success: true,
      message: 'Proyecto creado exitosamente',
      proyecto: newProject
    });

  } catch (error) {
    console.error('Error creando proyecto:', error);
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor'
    });
  }
});

// Actualizar proyecto
router.put('/:id', [
  param('id').isInt().withMessage('ID debe ser un número'),
  body('nombre').optional().trim().isLength({ min: 2 }).withMessage('Nombre debe tener al menos 2 caracteres'),
  body('descripcion').optional().trim(),
  body('cliente_id').optional().isInt().withMessage('Cliente ID debe ser un número'),
  body('ubicacion').optional().trim(),
  body('fecha_inicio').optional().isDate().withMessage('Fecha de inicio inválida'),
  body('fecha_fin_estimada').optional().isDate().withMessage('Fecha fin estimada inválida'),
  body('fecha_fin_real').optional().isDate().withMessage('Fecha fin real inválida'),
  body('presupuesto_inicial').optional().isNumeric().withMessage('Presupuesto inicial debe ser un número'),
  body('presupuesto_actual').optional().isNumeric().withMessage('Presupuesto actual debe ser un número'),
  body('estado').optional().isIn(['planificacion', 'en_curso', 'pausado', 'completado', 'cancelado']).withMessage('Estado inválido'),
  body('manager_id').optional().isInt().withMessage('Manager ID debe ser un número'),
  authenticateToken,
  requireManager
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Datos inválidos',
        errors: errors.array()
      });
    }

    const { id } = req.params;
    const updateData = req.body;

    // Verificar que el proyecto existe
    const projectResult = await query(
      'SELECT * FROM proyectos WHERE id = $1 AND activo = true',
      [id]
    );

    if (projectResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Proyecto no encontrado'
      });
    }

    const proyecto = projectResult.rows[0];

    // Verificar permisos
    if (req.user.rol !== 'admin' && proyecto.manager_id !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'No tienes permisos para editar este proyecto'
      });
    }

    // Construir query dinámico
    const updateFields = [];
    const updateValues = [];
    let paramCounter = 1;

    Object.keys(updateData).forEach(key => {
      if (updateData[key] !== undefined) {
        updateFields.push(`${key} = $${paramCounter}`);
        updateValues.push(updateData[key]);
        paramCounter++;
      }
    });

    if (updateFields.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No hay datos para actualizar'
      });
    }

    updateFields.push(`updated_at = CURRENT_TIMESTAMP`);
    updateValues.push(id);

    const result = await query(`
      UPDATE proyectos 
      SET ${updateFields.join(', ')}
      WHERE id = $${paramCounter}
      RETURNING *
    `, updateValues);

    res.json({
      success: true,
      message: 'Proyecto actualizado exitosamente',
      proyecto: result.rows[0]
    });

  } catch (error) {
    console.error('Error actualizando proyecto:', error);
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor'
    });
  }
});

// Eliminar proyecto (soft delete)
router.delete('/:id', [
  param('id').isInt().withMessage('ID debe ser un número'),
  authenticateToken,
  requireManager
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'ID inválido',
        errors: errors.array()
      });
    }

    const { id } = req.params;

    // Verificar que el proyecto existe
    const projectResult = await query(
      'SELECT * FROM proyectos WHERE id = $1 AND activo = true',
      [id]
    );

    if (projectResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Proyecto no encontrado'
      });
    }

    const proyecto = projectResult.rows[0];

    // Solo admin puede eliminar proyectos
    if (req.user.rol !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Solo administradores pueden eliminar proyectos'
      });
    }

    await query(
      'UPDATE proyectos SET activo = false, updated_at = CURRENT_TIMESTAMP WHERE id = $1',
      [id]
    );

    res.json({
      success: true,
      message: 'Proyecto eliminado exitosamente'
    });

  } catch (error) {
    console.error('Error eliminando proyecto:', error);
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor'
    });
  }
});

// Asignar usuario a proyecto
router.post('/:id/usuarios', [
  param('id').isInt().withMessage('ID debe ser un número'),
  body('user_id').isInt().withMessage('User ID debe ser un número'),
  body('rol_proyecto').optional().isIn(['supervisor', 'operario']).withMessage('Rol de proyecto inválido'),
  authenticateToken,
  requireManager
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Datos inválidos',
        errors: errors.array()
      });
    }

    const { id } = req.params;
    const { user_id, rol_proyecto = 'operario' } = req.body;

    // Verificar que el proyecto existe
    const projectResult = await query(
      'SELECT * FROM proyectos WHERE id = $1 AND activo = true',
      [id]
    );

    if (projectResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Proyecto no encontrado'
      });
    }

    // Verificar que el usuario existe
    const userResult = await query(
      'SELECT * FROM users WHERE id = $1 AND activo = true',
      [user_id]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Usuario no encontrado'
      });
    }

    // Asignar usuario al proyecto
    await query(`
      INSERT INTO proyecto_usuarios (proyecto_id, user_id, rol_proyecto)
      VALUES ($1, $2, $3)
      ON CONFLICT (proyecto_id, user_id) 
      DO UPDATE SET rol_proyecto = $3, created_at = CURRENT_TIMESTAMP
    `, [id, user_id, rol_proyecto]);

    res.json({
      success: true,
      message: 'Usuario asignado al proyecto exitosamente'
    });

  } catch (error) {
    console.error('Error asignando usuario:', error);
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor'
    });
  }
});

// Estadísticas de proyectos
router.get('/stats/dashboard', authenticateToken, async (req, res) => {
  try {
    let whereClause = 'WHERE p.activo = true';
    const queryParams = [];

    // Si no es admin, solo ver proyectos asignados
    if (req.user.rol !== 'admin') {
      whereClause += ' AND (p.manager_id = $1 OR pu.user_id = $1)';
      queryParams.push(req.user.id);
    }

    const statsResult = await query(`
      SELECT 
        COUNT(CASE WHEN p.estado = 'en_curso' THEN 1 END) as proyectos_activos,
        COUNT(CASE WHEN p.estado = 'planificacion' THEN 1 END) as proyectos_planificacion,
        COUNT(CASE WHEN p.estado = 'completado' THEN 1 END) as proyectos_completados,
        COUNT(*) as total_proyectos,
        COALESCE(SUM(p.presupuesto_inicial), 0) as presupuesto_total,
        COALESCE(SUM(p.presupuesto_actual), 0) as presupuesto_actual_total
      FROM proyectos p
      LEFT JOIN proyecto_usuarios pu ON p.id = pu.proyecto_id
      ${whereClause}
    `, queryParams);

    res.json({
      success: true,
      stats: statsResult.rows[0]
    });

  } catch (error) {
    console.error('Error obteniendo estadísticas:', error);
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor'
    });
  }
});

module.exports = router;