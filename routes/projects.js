const express = require('express');
const { body, validationResult, param } = require('express-validator');
const { query } = require('../database/config');
const { authenticateToken, requireManager } = require('../middleware/auth');

const router = express.Router();

// Obtener todos los proyectos
router.get('/', authenticateToken, async (req, res) => {
  try {
    console.log('=== PROJECTS QUERY ===');
    console.log('📊 Environment:', process.env.NODE_ENV);
    console.log('🔍 User ID:', req.user?.id);

    const { page = 1, limit = 10, estado, search } = req.query;
    const offset = (page - 1) * limit;

    let whereClause = 'WHERE 1=1';
    const queryParams = [];
    let paramCounter = 1;

    // Filtros
    if (estado) {
      whereClause += ` AND p.estado = $${paramCounter}`;
      queryParams.push(estado);
      paramCounter++;
    }

    if (search) {
      whereClause += ` AND (
        p.nombre ILIKE $${paramCounter} OR 
        p.nombre_corto ILIKE $${paramCounter} OR 
        p.codigo_proyecto ILIKE $${paramCounter} OR
        p.contratista ILIKE $${paramCounter} OR
        c.nombre ILIKE $${paramCounter}
      )`;
      queryParams.push(`%${search}%`);
      paramCounter++;
    }

    let result;
    try {
      // Try with new budget fields
      result = await query(`
        SELECT 
          p.id,
          p.nombre,
          p.nombre_corto,
          p.cliente_id,
          p.fecha_inicio,
          p.fecha_fin_estimada,
          p.estado,
          p.contratista,
          p.ingeniero_residente,
          p.codigo_proyecto,
          p.contrato,
          p.acto_publico,
          p.monto_contrato_original,
          COALESCE(p.presupuesto_base, 0) as presupuesto_base,
          COALESCE(p.itbms, 0) as itbms,
          COALESCE(p.monto_total, p.monto_contrato_original) as monto_total,
          p.datos_adicionales,
          p.created_at,
          p.updated_at,
          c.nombre as cliente_nombre,
          c.abreviatura as cliente_abreviatura
        FROM proyectos p
        LEFT JOIN clientes c ON p.cliente_id = c.id
        ${whereClause.replace('WHERE 1=1', 'WHERE 1=1')}
        ORDER BY p.created_at DESC
        LIMIT $${paramCounter} OFFSET $${paramCounter + 1}
      `, [...queryParams, limit, offset]);
    } catch (queryError) {
      console.log('⚠️  New budget fields not available, using fallback query');
      // Fallback query without new budget fields
      result = await query(`
        SELECT 
          p.id,
          p.nombre,
          p.nombre_corto,
          p.cliente_id,
          p.fecha_inicio,
          p.fecha_fin_estimada,
          p.estado,
          p.contratista,
          p.ingeniero_residente,
          p.codigo_proyecto,
          p.contrato,
          p.acto_publico,
          p.monto_contrato_original,
          0 as presupuesto_base,
          0 as itbms,
          p.monto_contrato_original as monto_total,
          p.datos_adicionales,
          p.created_at,
          p.updated_at,
          c.nombre as cliente_nombre,
          c.abreviatura as cliente_abreviatura
        FROM proyectos p
        LEFT JOIN clientes c ON p.cliente_id = c.id
        ${whereClause.replace('WHERE 1=1', 'WHERE 1=1')}
        ORDER BY p.created_at DESC
        LIMIT $${paramCounter} OFFSET $${paramCounter + 1}
      `, [...queryParams, limit, offset]);
    }

    // Contar total para paginación
    const countResult = await query(`
      SELECT COUNT(*) as total
      FROM proyectos p
      LEFT JOIN clientes c ON p.cliente_id = c.id
      ${whereClause}
    `, queryParams);

    const total = parseInt(countResult.rows[0].total);

    console.log('Found projects:', result.rows.length);
    
    // Debug: Log first project structure
    if (result.rows.length > 0) {
      console.log('📋 First project keys:', Object.keys(result.rows[0]));
      console.log('💰 First project budget fields:', {
        monto_contrato_original: result.rows[0].monto_contrato_original,
        presupuesto_base: result.rows[0].presupuesto_base,
        itbms: result.rows[0].itbms,
        monto_total: result.rows[0].monto_total
      });
    }

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
    console.error('❌ Projects query error:', error);
    console.error('❌ Error code:', error.code);
    console.error('❌ Error message:', error.message);
    console.error('❌ Error detail:', error.detail);
    
    // If core tables don't exist, return empty results
    if (error.message.includes('does not exist')) {
      console.log('⚠️ Core project tables not found, returning empty results');
      return res.json({
        success: true,
        proyectos: [],
        pagination: {
          current_page: 1,
          total_pages: 0,
          total_records: 0,
          per_page: parseInt(req.query.limit || 10)
        }
      });
    }
    
    res.status(500).json({
      success: false,
      message: 'Error de conexión al cargar proyectos',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
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
  body('cliente_id').optional({ nullable: true }).isInt().withMessage('Cliente ID debe ser un número'),
  body('fecha_inicio').optional({ nullable: true }).isISO8601().withMessage('Fecha de inicio inválida'),
  body('fecha_fin_estimada').optional({ nullable: true }).isISO8601().withMessage('Fecha fin estimada inválida'),
  body('estado').optional().isIn(['planificacion', 'en_curso', 'pausado', 'completado', 'cancelado']).withMessage('Estado inválido'),
  body('contratista').optional().trim(),
  body('ingeniero_residente').optional().trim(),
  body('codigo_proyecto').optional().trim(),
  body('contrato').optional().trim(),
  body('acto_publico').optional().trim(),
  body('monto_contrato_original').optional({ nullable: true }).isNumeric().withMessage('Monto contrato debe ser un número'),
  body('presupuesto_base').optional({ nullable: true }).isNumeric().withMessage('Presupuesto base debe ser un número'),
  body('itbms').optional({ nullable: true }).isNumeric().withMessage('ITBMS debe ser un número'),
  body('monto_total').optional({ nullable: true }).isNumeric().withMessage('Monto total debe ser un número'),
  body('datos_adicionales').optional().isObject().withMessage('Datos adicionales debe ser un objeto JSON'),
  authenticateToken,
  requireManager
], async (req, res) => {
  try {
    console.log('📝 Project creation request body:', JSON.stringify(req.body, null, 2));
    
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('❌ Project validation errors:', errors.array());
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
      presupuesto_base,
      itbms,
      monto_total,
      datos_adicionales = {}
    } = req.body;

    let result;
    try {
      // Try with new budget fields
      result = await query(`
        INSERT INTO proyectos (
          nombre, nombre_corto, cliente_id, fecha_inicio, fecha_fin_estimada, 
          estado, contratista, ingeniero_residente, codigo_proyecto,
          contrato, acto_publico, monto_contrato_original, presupuesto_base, itbms, monto_total, datos_adicionales
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
        RETURNING *
      `, [
        nombre, nombre_corto, cliente_id, fecha_inicio, fecha_fin_estimada,
        estado, contratista, ingeniero_residente, codigo_proyecto,
        contrato, acto_publico, monto_contrato_original, presupuesto_base, itbms, monto_total, JSON.stringify(datos_adicionales)
      ]);
    } catch (budgetError) {
      console.log('⚠️ Budget fields not available in proyectos, using fallback create');
      // Fallback without budget fields
      result = await query(`
        INSERT INTO proyectos (
          nombre, nombre_corto, cliente_id, fecha_inicio, fecha_fin_estimada, 
          estado, contratista, ingeniero_residente, codigo_proyecto,
          contrato, acto_publico, monto_contrato_original, datos_adicionales
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        RETURNING *
      `, [
        nombre, nombre_corto, cliente_id, fecha_inicio, fecha_fin_estimada,
        estado, contratista, ingeniero_residente, codigo_proyecto,
        contrato, acto_publico, monto_contrato_original, JSON.stringify(datos_adicionales)
      ]);
    }

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
  body('cliente_id').optional({ nullable: true }).isInt().withMessage('Cliente ID debe ser un número'),
  body('fecha_inicio').optional({ nullable: true }).isISO8601().withMessage('Fecha de inicio inválida'),
  body('fecha_fin_estimada').optional({ nullable: true }).isISO8601().withMessage('Fecha fin estimada inválida'),
  body('estado').optional().isIn(['planificacion', 'en_curso', 'pausado', 'completado', 'cancelado']).withMessage('Estado inválido'),
  body('contratista').optional().trim(),
  body('ingeniero_residente').optional().trim(),
  body('codigo_proyecto').optional().trim(),
  body('contrato').optional().trim(),
  body('acto_publico').optional().trim(),
  body('monto_contrato_original').optional({ nullable: true }).isNumeric().withMessage('Monto contrato debe ser un número'),
  body('presupuesto_base').optional({ nullable: true }).isNumeric().withMessage('Presupuesto base debe ser un número'),
  body('itbms').optional({ nullable: true }).isNumeric().withMessage('ITBMS debe ser un número'),
  body('monto_total').optional({ nullable: true }).isNumeric().withMessage('Monto total debe ser un número'),
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
        COALESCE(SUM(COALESCE(monto_total, monto_contrato_original)), 0) as monto_contratos_total
      FROM proyectos
    `);

    res.json({
      success: true,
      stats: statsResult.rows[0]
    });

  } catch (error) {
    console.error('Error obteniendo estadísticas:', error);
    
    // If proyectos table doesn't exist, return zero stats
    if (error.message.includes('does not exist')) {
      console.log('⚠️ Proyectos table not found, returning zero stats');
      return res.json({
        success: true,
        stats: {
          proyectos_activos: 0,
          proyectos_planificacion: 0,
          proyectos_completados: 0,
          total_proyectos: 0,
          monto_contratos_total: 0
        }
      });
    }
    
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