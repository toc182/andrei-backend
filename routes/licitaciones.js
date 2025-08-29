const express = require('express');
const { body, param, validationResult } = require('express-validator');
const { query } = require('../database/config');
const { authenticateToken, requireManager } = require('../middleware/auth');

const router = express.Router();

// Obtener todas las licitaciones
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { estado, page = 1, limit = 10 } = req.query;
    const offset = (page - 1) * limit;

    let whereClause = 'WHERE 1=1';
    const queryParams = [];
    let paramCounter = 1;

    if (estado) {
      whereClause += ` AND estado_licitacion = $${paramCounter}`;
      queryParams.push(estado);
      paramCounter++;
    }

    const result = await query(`
      SELECT 
        l.*,
        u.nombre as created_by_name,
        CASE WHEN p.id IS NOT NULL THEN true ELSE false END as tiene_proyecto_asociado,
        p.id as proyecto_id
      FROM licitaciones l
      LEFT JOIN users u ON l.created_by = u.id
      LEFT JOIN proyectos p ON l.id = p.licitacion_id
      ${whereClause}
      ORDER BY l.fecha_cierre DESC, l.created_at DESC
      LIMIT $${paramCounter} OFFSET $${paramCounter + 1}
    `, [...queryParams, limit, offset]);

    const countResult = await query(`
      SELECT COUNT(*) as total FROM licitaciones l ${whereClause}
    `, queryParams);

    const total = parseInt(countResult.rows[0].total);

    res.json({
      success: true,
      licitaciones: result.rows,
      pagination: {
        current_page: parseInt(page),
        total_pages: Math.ceil(total / limit),
        total_records: total,
        per_page: parseInt(limit)
      }
    });

  } catch (error) {
    console.error('Error fetching licitaciones:', error);
    res.status(500).json({
      success: false,
      message: 'Error al cargar licitaciones'
    });
  }
});

// Crear nueva licitación
router.post('/', [
  body('nombre').trim().isLength({ min: 2 }).withMessage('Nombre debe tener al menos 2 caracteres'),
  body('numero_licitacion').trim().isLength({ min: 1 }).withMessage('Número de licitación es requerido'),
  body('entidad_licitante').trim().isLength({ min: 2 }).withMessage('Entidad licitante es requerida'),
  body('fecha_cierre').isISO8601().withMessage('Fecha de cierre inválida'),
  body('presupuesto_referencial').optional({ nullable: true }).isNumeric().withMessage('Presupuesto debe ser un número'),
  body('plazo_ejecucion_dias').optional({ nullable: true }).isInt().withMessage('Plazo debe ser un número entero'),
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
      numero_licitacion,
      entidad_licitante,
      fecha_apertura,
      fecha_cierre,
      presupuesto_referencial,
      moneda = 'USD',
      plazo_ejecucion_dias,
      documentos_licitacion,
      requisitos_tecnicos,
      ubicacion_proyecto,
      observaciones
    } = req.body;

    const result = await query(`
      INSERT INTO licitaciones (
        nombre, numero_licitacion, entidad_licitante, fecha_apertura, fecha_cierre,
        presupuesto_referencial, moneda, plazo_ejecucion_dias, documentos_licitacion,
        requisitos_tecnicos, ubicacion_proyecto, observaciones, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING *
    `, [
      nombre, numero_licitacion, entidad_licitante, fecha_apertura, fecha_cierre,
      presupuesto_referencial, moneda, plazo_ejecucion_dias, documentos_licitacion,
      requisitos_tecnicos, ubicacion_proyecto, observaciones, req.user.id
    ]);

    res.status(201).json({
      success: true,
      message: 'Licitación creada exitosamente',
      licitacion: result.rows[0]
    });

  } catch (error) {
    console.error('Error creando licitación:', error);
    if (error.code === '23505') {
      res.status(400).json({
        success: false,
        message: 'El número de licitación ya existe'
      });
    } else {
      res.status(500).json({
        success: false,
        message: 'Error interno del servidor'
      });
    }
  }
});

// Actualizar estado de licitación
router.put('/:id/estado', [
  param('id').isInt().withMessage('ID debe ser un número'),
  body('estado_licitacion').isIn(['activa', 'presentada', 'ganada', 'perdida', 'sin_interes', 'cancelada'])
    .withMessage('Estado de licitación inválido'),
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
    const { estado_licitacion, resultado } = req.body;

    const result = await query(`
      UPDATE licitaciones 
      SET estado_licitacion = $1, resultado = $2, updated_at = CURRENT_TIMESTAMP
      WHERE id = $3
      RETURNING *
    `, [estado_licitacion, resultado, id]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Licitación no encontrada'
      });
    }

    res.json({
      success: true,
      message: 'Estado de licitación actualizado',
      licitacion: result.rows[0]
    });

  } catch (error) {
    console.error('Error actualizando estado licitación:', error);
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor'
    });
  }
});

// Convertir licitación ganada a proyecto
router.post('/:id/convert-to-project', [
  param('id').isInt().withMessage('ID debe ser un número'),
  authenticateToken,
  requireManager
], async (req, res) => {
  try {
    const { id } = req.params;

    // Verificar que la licitación existe y está ganada
    const licitacionResult = await query(`
      SELECT * FROM licitaciones WHERE id = $1 AND estado_licitacion = 'ganada'
    `, [id]);

    if (licitacionResult.rows.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Licitación no encontrada o no está ganada'
      });
    }

    const licitacion = licitacionResult.rows[0];

    // Crear proyecto basado en la licitación
    const proyectoResult = await query(`
      INSERT INTO proyectos (
        nombre, monto_contrato_original, licitacion_id, tipo_origen,
        datos_adicionales, created_at
      ) VALUES ($1, $2, $3, 'licitacion', $4, CURRENT_TIMESTAMP)
      RETURNING *
    `, [
      licitacion.nombre,
      licitacion.presupuesto_referencial,
      licitacion.id,
      JSON.stringify({
        numero_licitacion: licitacion.numero_licitacion,
        entidad_licitante: licitacion.entidad_licitante,
        plazo_original: licitacion.plazo_ejecucion_dias
      })
    ]);

    res.status(201).json({
      success: true,
      message: 'Proyecto creado desde licitación',
      proyecto: proyectoResult.rows[0],
      licitacion: licitacion
    });

  } catch (error) {
    console.error('Error convirtiendo licitación a proyecto:', error);
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor'
    });
  }
});

module.exports = router;