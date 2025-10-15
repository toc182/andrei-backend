const express = require('express');
const { body, validationResult } = require('express-validator');
const { query } = require('../database/config');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// Crear nuevo registro de uso
router.post('/', [
  body('asignacion_id').isInt().withMessage('ID de asignación requerido'),
  body('fecha_inicio').isISO8601().withMessage('Fecha de inicio requerida'),
  body('fecha_fin').isISO8601().withMessage('Fecha de fin requerida'),
  body('cantidad').isNumeric().withMessage('Cantidad debe ser numérica')
], authenticateToken, async (req, res) => {
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
      asignacion_id,
      fecha_inicio,
      fecha_fin,
      cantidad,
      observaciones
    } = req.body;

    // Si fecha_inicio == fecha_fin (tipo hora), verificar si ya existe un registro para esa fecha
    let result;
    if (fecha_inicio === fecha_fin) {
      const existingRecord = await query(`
        SELECT id FROM registro_uso_equipos
        WHERE asignacion_id = $1 AND fecha_inicio = $2
      `, [asignacion_id, fecha_inicio]);

      if (existingRecord.rows.length > 0) {
        // Actualizar registro existente
        result = await query(`
          UPDATE registro_uso_equipos
          SET cantidad = $1, observaciones = $2
          WHERE id = $3
          RETURNING *
        `, [cantidad, observaciones || null, existingRecord.rows[0].id]);

        console.log('✅ Registro de uso actualizado:', result.rows[0].id);

        return res.json({
          success: true,
          message: 'Registro de uso actualizado exitosamente',
          data: result.rows[0]
        });
      }
    }

    // Crear nuevo registro
    result = await query(`
      INSERT INTO registro_uso_equipos (
        asignacion_id, fecha_inicio, fecha_fin, cantidad, observaciones, created_at
      ) VALUES (
        $1, $2, $3, $4, $5, NOW()
      ) RETURNING *
    `, [asignacion_id, fecha_inicio, fecha_fin, cantidad, observaciones || null]);

    console.log('✅ Registro de uso creado:', result.rows[0].id);

    res.json({
      success: true,
      message: 'Registro de uso creado exitosamente',
      data: result.rows[0]
    });

  } catch (error) {
    console.error('Error creando registro de uso:', error);
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor'
    });
  }
});

// Obtener registros de uso por asignación
router.get('/asignacion/:asignacion_id', authenticateToken, async (req, res) => {
  try {
    const { asignacion_id } = req.params;

    const result = await query(`
      SELECT * FROM registro_uso_equipos
      WHERE asignacion_id = $1
      ORDER BY fecha_inicio DESC
    `, [asignacion_id]);

    console.log('✅ Registros de uso encontrados:', result.rows.length);

    res.json({
      success: true,
      data: result.rows
    });

  } catch (error) {
    console.error('Error obteniendo registros de uso:', error);
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor'
    });
  }
});

module.exports = router;
