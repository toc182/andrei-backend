const express = require('express');
const { body, validationResult, param } = require('express-validator');
const { query } = require('../database/config');
const { authenticateToken, requireManager } = require('../middleware/auth');

const router = express.Router();

// Obtener todos los proyectos
router.get('/', authenticateToken, async (req, res) => {
  try {
    console.log('=== PROJECTS QUERY ===');

    const { page = 1, limit = 10, estado, search } = req.query;
    const offset = (page - 1) * limit;

    let whereClause = 'WHERE 1=1';
    const queryParams = [];
    let paramCounter = 1;

    // Filtros
    if (estado) {
      whereClause += ` AND estado = $${paramCounter}`;
      queryParams.push(estado);
      paramCounter++;
    }

    if (search) {
      whereClause += ` AND (
        nombre ILIKE $${paramCounter} OR 
        nombre_corto ILIKE $${paramCounter} OR 
        codigo_proyecto ILIKE $${paramCounter} OR
        contratista ILIKE $${paramCounter}
      )`;
      queryParams.push(`%${search}%`);
      paramCounter++;
    }

    const result = await query(`
      SELECT 
        id,
        nombre,
        nombre_corto,
        cliente_id,
        fecha_inicio,
        fecha_fin_estimada,
        estado,
        contratista,
        ingeniero_residente,
        codigo_proyecto,
        contrato,
        acto_publico,
        monto_contrato_original,
        datos_adicionales,
        created_at,
        updated_at
      FROM proyectos 
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT $${paramCounter} OFFSET $${paramCounter + 1}
    `, [...queryParams, limit, offset]);

    // Contar total para paginación
    const countResult = await query(`
      SELECT COUNT(*) as total
      FROM proyectos 
      ${whereClause}
    `, queryParams);

    const total = parseInt(countResult.rows[0].total);

    console.log('Found projects:', result.rows.length);

    res.json({
      success: true,
      proyectos: result.rows,
      pagination: {
        current_page: parseInt(page),
        total_pages: Math.ceil(total / limit),
        total_records: total,
        per_page: parseInt(limit)
      }
    });

  } catch (error) {
    console.error('Projects query error:', error);
    res.status(500).json({
      success: false,
      message: error.message
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
            c.email as cliente_email
        FROM proyectos p
                 LEFT JOIN clientes c ON p.cliente_id = c.id
        WHERE p.id = $1
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Proyecto no encontrado'
      });
    }

    const proyecto = result.rows[0];

    // Obtener usuarios asignados (si existe la tabla)
    try {
      const usuariosResult = await query(`
        SELECT u.id, u.nombre, u.email, pu.rol_proyecto
        FROM proyecto_usuarios pu
        JOIN users u ON pu.user_id = u.id
        WHERE pu.proyecto_id = $1
      `, [id]);

      proyecto.usuarios_asignados = usuariosResult.rows;
    } catch (error) {
      // Si no existe la tabla proyecto_usuarios, continuar sin usuarios
      proyecto.usuarios_asignados = [];
    }

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
  body('nombre_corto').optional().trim().isLength({ max: 255 }).withMessage('Nombre corto máximo 255 caracteres'),
  body('cliente_id').optional().isInt().withMessage('Cliente ID debe ser un número'),
  body('fecha_inicio').optional().isDate().withMessage('Fecha de inicio inválida'),
  body('fecha_fin_estimada').optional().isDate().withMessage('Fecha fin estimada inválida'),
  body('estado').optional().isIn(['planificacion', 'en_curso', 'pausado', 'completado', 'cancelado']).withMessage('Estado inválido'),
  body('contratista').optional().trim(),
  body('ingeniero_residente').optional().trim(),
  body('codigo_proyecto').optional().trim(),
  body('contrato').optional().trim(),
  body('acto_publico').optional().trim(),
  body('monto_contrato_original').optional().isNumeric().withMessage('Monto contrato debe ser un número'),
  body('datos_adicionales').optional().isObject().withMessage('Datos adicionales debe ser un objeto JSON'),
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
      nombre_corto,
      cliente_id,
      fecha_inicio,
      fecha_fin_estimada,
      estado = 'planificacion',
      contratista,
      ingeniero_residente,
      codigo_proyecto,
      contrato,
      acto_publico,
      monto_contrato_original,
      datos_adicionales = {}
    } = req.body;

    const result = await query(`
      INSERT INTO proyectos (
        nombre, nombre_corto, cliente_id, fecha_inicio, fecha_fin_estimada, 
        estado, contratista, ingeniero_residente, codigo_proyecto,
        contrato, acto_publico, monto_contrato_original, datos_adicionales
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING *
    `, [
      nombre, nombre_corto, cliente_id, fecha_inicio, fecha_fin_estimada,
      estado, contratista, ingeniero_residente, codigo_proyecto,
      contrato, acto_publico, monto_contrato_original, JSON.stringify(datos_adicionales)
    ]);

    const newProject = result.rows[0];

    res.status(201).json({
      success: true,
      message: 'Proyecto creado exitosamente',
      proyecto: newProject
    });

  } catch (error) {
    console.error('Error creando proyecto:', error);
    if (error.code === '23505') { // Duplicate key error
      res.status(400).json({
        success: false,
        message: 'El código de proyecto ya existe'
      });
    } else {
      res.status(500).json({
        success: false,
        message: 'Error interno del servidor'
      });
    }
  }
});

// Actualizar proyecto
router.put('/:id', [
  param('id').isInt().withMessage('ID debe ser un número'),
  body('nombre').optional().trim().isLength({ min: 2 }).withMessage('Nombre debe tener al menos 2 caracteres'),
  body('nombre_corto').optional().trim().isLength({ max: 255 }).withMessage('Nombre corto máximo 255 caracteres'),
  body('cliente_id').optional().isInt().withMessage('Cliente ID debe ser un número'),
  body('fecha_inicio').optional().isDate().withMessage('Fecha de inicio inválida'),
  body('fecha_fin_estimada').optional().isDate().withMessage('Fecha fin estimada inválida'),
  body('estado').optional().isIn(['planificacion', 'en_curso', 'pausado', 'completado', 'cancelado']).withMessage('Estado inválido'),
  body('contratista').optional().trim(),
  body('ingeniero_residente').optional().trim(),
  body('codigo_proyecto').optional().trim(),
  body('contrato').optional().trim(),
  body('acto_publico').optional().trim(),
  body('monto_contrato_original').optional().isNumeric().withMessage('Monto contrato debe ser un número'),
  body('datos_adicionales').optional().isObject().withMessage('Datos adicionales debe ser un objeto JSON'),
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
      'SELECT * FROM proyectos WHERE id = $1',
      [id]
    );

    if (projectResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Proyecto no encontrado'
      });
    }

    // Construir query dinámico
    const updateFields = [];
    const updateValues = [];
    let paramCounter = 1;

    Object.keys(updateData).forEach(key => {
      if (updateData[key] !== undefined) {
        if (key === 'datos_adicionales') {
          updateFields.push(`${key} = $${paramCounter}`);
          updateValues.push(JSON.stringify(updateData[key]));
        } else {
          updateFields.push(`${key} = $${paramCounter}`);
          updateValues.push(updateData[key]);
        }
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
    if (error.code === '23505') { // Duplicate key error
      res.status(400).json({
        success: false,
        message: 'El código de proyecto ya existe'
      });
    } else {
      res.status(500).json({
        success: false,
        message: 'Error interno del servidor'
      });
    }
  }
});

// Eliminar proyecto (soft delete - si quieres mantener esta funcionalidad)
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
      'SELECT * FROM proyectos WHERE id = $1',
      [id]
    );

    if (projectResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Proyecto no encontrado'
      });
    }

    // Solo admin puede eliminar proyectos
    if (req.user.rol !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Solo administradores pueden eliminar proyectos'
      });
    }

    // Como eliminamos el campo 'activo', hacemos delete real
    await query('DELETE FROM proyectos WHERE id = $1', [id]);

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

// Estadísticas básicas
router.get('/stats/dashboard', authenticateToken, async (req, res) => {
  try {
    const statsResult = await query(`
      SELECT 
        COUNT(CASE WHEN estado = 'en_curso' THEN 1 END) as proyectos_activos,
        COUNT(CASE WHEN estado = 'planificacion' THEN 1 END) as proyectos_planificacion,
        COUNT(CASE WHEN estado = 'completado' THEN 1 END) as proyectos_completados,
        COUNT(*) as total_proyectos,
        COALESCE(SUM(monto_contrato_original), 0) as monto_contratos_total
      FROM proyectos
    `);

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

// Nueva ruta: Agregar/actualizar datos adicionales
router.patch('/:id/datos-adicionales', [
  param('id').isInt().withMessage('ID debe ser un número'),
  body('datos').isObject().withMessage('Datos debe ser un objeto JSON'),
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
    const { datos } = req.body;

    // Obtener datos actuales
    const currentResult = await query(
      'SELECT datos_adicionales FROM proyectos WHERE id = $1',
      [id]
    );

    if (currentResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Proyecto no encontrado'
      });
    }

    // Merge con datos existentes
    const currentData = currentResult.rows[0].datos_adicionales || {};
    const mergedData = { ...currentData, ...datos };

    const result = await query(`
      UPDATE proyectos 
      SET datos_adicionales = $1, updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
      RETURNING datos_adicionales
    `, [JSON.stringify(mergedData), id]);

    res.json({
      success: true,
      message: 'Datos adicionales actualizados',
      datos_adicionales: result.rows[0].datos_adicionales
    });

  } catch (error) {
    console.error('Error actualizando datos adicionales:', error);
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor'
    });
  }
});

module.exports = router;