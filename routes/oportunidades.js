const express = require('express');
const { body, param, validationResult } = require('express-validator');
const { query } = require('../database/config');
const { authenticateToken, requireManager } = require('../middleware/auth');

const router = express.Router();

// Obtener todas las oportunidades
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { estado, assigned_to, page = 1, limit = 10 } = req.query;
    const offset = (page - 1) * limit;

    let whereClause = 'WHERE 1=1';
    const queryParams = [];
    let paramCounter = 1;

    if (estado) {
      whereClause += ` AND estado_oportunidad = $${paramCounter}`;
      queryParams.push(estado);
      paramCounter++;
    }

    if (assigned_to) {
      whereClause += ` AND assigned_to = $${paramCounter}`;
      queryParams.push(assigned_to);
      paramCounter++;
    }

    const result = await query(`
      SELECT 
        o.*,
        u1.nombre as created_by_name,
        u2.nombre as assigned_to_name,
        CASE WHEN p.id IS NOT NULL THEN true ELSE false END as tiene_proyecto_asociado,
        p.id as proyecto_id
      FROM oportunidades o
      LEFT JOIN users u1 ON o.created_by = u1.id
      LEFT JOIN users u2 ON o.assigned_to = u2.id
      LEFT JOIN proyectos p ON o.id = p.oportunidad_id
      ${whereClause}
      ORDER BY o.fecha_siguiente_seguimiento ASC, o.created_at DESC
      LIMIT $${paramCounter} OFFSET $${paramCounter + 1}
    `, [...queryParams, limit, offset]);

    const countResult = await query(`
      SELECT COUNT(*) as total FROM oportunidades o ${whereClause}
    `, queryParams);

    const total = parseInt(countResult.rows[0].total);

    res.json({
      success: true,
      oportunidades: result.rows,
      pagination: {
        current_page: parseInt(page),
        total_pages: Math.ceil(total / limit),
        total_records: total,
        per_page: parseInt(limit)
      }
    });

  } catch (error) {
    console.error('Error fetching oportunidades:', error);
    res.status(500).json({
      success: false,
      message: 'Error al cargar oportunidades'
    });
  }
});

// Crear nueva oportunidad
router.post('/', [
  body('nombre_oportunidad').trim().isLength({ min: 2 }).withMessage('Nombre debe tener al menos 2 caracteres'),
  body('cliente_potencial').trim().isLength({ min: 2 }).withMessage('Cliente potencial es requerido'),
  body('valor_estimado').optional({ nullable: true }).isNumeric().withMessage('Valor estimado debe ser un número'),
  body('probabilidad_cierre').optional({ nullable: true }).isInt({ min: 0, max: 100 }).withMessage('Probabilidad debe ser entre 0 y 100'),
  authenticateToken
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
      nombre_oportunidad,
      cliente_potencial,
      contacto_referido,
      telefono_contacto,
      email_contacto,
      valor_estimado,
      moneda = 'USD',
      probabilidad_cierre,
      fecha_contacto_inicial,
      fecha_estimada_cierre,
      tipo_trabajo,
      notas_comerciales,
      siguiente_accion,
      fecha_siguiente_seguimiento,
      origen,
      assigned_to
    } = req.body;

    const result = await query(`
      INSERT INTO oportunidades (
        nombre_oportunidad, cliente_potencial, contacto_referido, telefono_contacto, 
        email_contacto, valor_estimado, moneda, probabilidad_cierre, fecha_contacto_inicial,
        fecha_estimada_cierre, tipo_trabajo, notas_comerciales, siguiente_accion,
        fecha_siguiente_seguimiento, origen, assigned_to, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
      RETURNING *
    `, [
      nombre_oportunidad, cliente_potencial, contacto_referido, telefono_contacto,
      email_contacto, valor_estimado, moneda, probabilidad_cierre, fecha_contacto_inicial,
      fecha_estimada_cierre, tipo_trabajo, notas_comerciales, siguiente_accion,
      fecha_siguiente_seguimiento, origen, assigned_to, req.user.id
    ]);

    res.status(201).json({
      success: true,
      message: 'Oportunidad creada exitosamente',
      oportunidad: result.rows[0]
    });

  } catch (error) {
    console.error('Error creando oportunidad:', error);
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor'
    });
  }
});

// Actualizar estado de oportunidad
router.put('/:id/estado', [
  param('id').isInt().withMessage('ID debe ser un número'),
  body('estado_oportunidad').isIn(['prospecto', 'calificada', 'propuesta', 'negociacion', 'cerrada', 'perdida'])
    .withMessage('Estado de oportunidad inválido'),
  authenticateToken
], async (req, res) => {
  try {
    const { id } = req.params;
    const { estado_oportunidad, notas_comerciales } = req.body;

    const result = await query(`
      UPDATE oportunidades 
      SET estado_oportunidad = $1, notas_comerciales = COALESCE($2, notas_comerciales), updated_at = CURRENT_TIMESTAMP
      WHERE id = $3
      RETURNING *
    `, [estado_oportunidad, notas_comerciales, id]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Oportunidad no encontrada'
      });
    }

    res.json({
      success: true,
      message: 'Estado de oportunidad actualizado',
      oportunidad: result.rows[0]
    });

  } catch (error) {
    console.error('Error actualizando estado oportunidad:', error);
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor'
    });
  }
});

// Convertir oportunidad cerrada a proyecto
router.post('/:id/convert-to-project', [
  param('id').isInt().withMessage('ID debe ser un número'),
  authenticateToken,
  requireManager
], async (req, res) => {
  try {
    const { id } = req.params;

    const oportunidadResult = await query(`
      SELECT * FROM oportunidades WHERE id = $1 AND estado_oportunidad = 'cerrada'
    `, [id]);

    if (oportunidadResult.rows.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Oportunidad no encontrada o no está cerrada'
      });
    }

    const oportunidad = oportunidadResult.rows[0];

    const proyectoResult = await query(`
      INSERT INTO proyectos (
        nombre, monto_contrato_original, oportunidad_id, tipo_origen,
        datos_adicionales, created_at
      ) VALUES ($1, $2, $3, 'oportunidad', $4, CURRENT_TIMESTAMP)
      RETURNING *
    `, [
      oportunidad.nombre_oportunidad,
      oportunidad.valor_estimado,
      oportunidad.id,
      JSON.stringify({
        cliente_potencial: oportunidad.cliente_potencial,
        contacto_referido: oportunidad.contacto_referido,
        tipo_trabajo: oportunidad.tipo_trabajo,
        origen: oportunidad.origen
      })
    ]);

    res.status(201).json({
      success: true,
      message: 'Proyecto creado desde oportunidad',
      proyecto: proyectoResult.rows[0],
      oportunidad: oportunidad
    });

  } catch (error) {
    console.error('Error convirtiendo oportunidad a proyecto:', error);
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor'
    });
  }
});

module.exports = router;