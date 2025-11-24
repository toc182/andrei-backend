const express = require('express');
const { body, validationResult, param } = require('express-validator');
const { query } = require('../database/config');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// Obtener status de equipos (para la tabla de estado)
router.get('/status', authenticateToken, async (req, res) => {
  try {
    console.log('=== EQUIPOS STATUS QUERY ===');
    console.log('📊 Environment:', process.env.NODE_ENV);
    console.log('🔍 User ID:', req.user?.id);

    const statusQuery = `
      SELECT
        id,
        codigo,
        descripcion,
        marca,
        modelo,
        ano,
        estado,
        owner,
        proyecto as ubicacion,
        updated_at as ultima_revision
      FROM equipos
      WHERE activo = true
      ORDER BY
        CASE
          WHEN owner = 'Pinellas' THEN 0
          ELSE 1
        END,
        descripcion ASC
    `;

    const result = await query(statusQuery, []);

    console.log('✅ Equipos status encontrados:', result.rows.length);

    // Mapear los datos para el frontend
    const equiposConEstado = result.rows.map(equipo => ({
      ...equipo,
      estado: equipo.estado || 'operativo', // Estado por defecto si es null
      ubicacion: equipo.ubicacion || 'No especificada'
    }));

    res.json({
      success: true,
      data: equiposConEstado,
      total: equiposConEstado.length
    });

  } catch (error) {
    console.error('❌ Error al obtener status de equipos:', error);
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Obtener todos los equipos
router.get('/', authenticateToken, async (req, res) => {
  try {
    console.log('=== EQUIPOS QUERY ===');
    console.log('📊 Environment:', process.env.NODE_ENV);
    console.log('🔍 User ID:', req.user?.id);

    const { owner, search, estado } = req.query;

    let whereClause = 'WHERE activo = true';
    const queryParams = [];
    let paramCounter = 1;

    // Filtrar por propietario (Pinellas o COCP)
    if (owner) {
      whereClause += ` AND owner = $${paramCounter}`;
      queryParams.push(owner);
      paramCounter++;
    }

    // Filtrar por búsqueda en descripción, marca o modelo
    if (search) {
      whereClause += ` AND (
        descripcion ILIKE $${paramCounter} OR
        marca ILIKE $${paramCounter} OR
        modelo ILIKE $${paramCounter} OR
        codigo ILIKE $${paramCounter}
      )`;
      queryParams.push(`%${search}%`);
      paramCounter++;
    }

    // Filtrar por estado
    if (estado) {
      whereClause += ` AND estado = $${paramCounter}`;
      queryParams.push(estado);
      paramCounter++;
    }

    const equiposQuery = `
      SELECT
        id,
        codigo,
        descripcion,
        marca,
        modelo,
        ano,
        motor,
        chasis,
        costo,
        valor_actual,
        rata_mes,
        proyecto,
        responsable,
        estado,
        observaciones,
        owner,
        created_at,
        updated_at
      FROM equipos
      ${whereClause}
      ORDER BY
        CASE
          WHEN owner = 'Pinellas' THEN 0
          ELSE 1
        END,
        descripcion ASC
    `;

    console.log('🔍 Query:', equiposQuery);
    console.log('📝 Params:', queryParams);

    const result = await query(equiposQuery, queryParams);

    console.log('✅ Equipos encontrados:', result.rows.length);

    res.json({
      success: true,
      data: result.rows,
      total: result.rows.length
    });

  } catch (error) {
    console.error('❌ Error al obtener equipos:', error);
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Obtener un equipo por ID
router.get('/:id',
  authenticateToken,
  param('id').isInt().withMessage('ID debe ser un número entero'),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Datos de entrada inválidos',
          errors: errors.array()
        });
      }

      const { id } = req.params;

      const equipoQuery = `
        SELECT
          id,
          codigo,
          descripcion,
          marca,
          modelo,
          ano,
          motor,
          chasis,
          costo,
          valor_actual,
          rata_mes,
          proyecto,
          responsable,
          estado,
          observaciones,
          owner,
          created_at,
          updated_at
        FROM equipos
        WHERE id = $1 AND activo = true
      `;

      const result = await query(equipoQuery, [id]);

      if (result.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Equipo no encontrado'
        });
      }

      res.json({
        success: true,
        data: result.rows[0]
      });

    } catch (error) {
      console.error('❌ Error al obtener equipo:', error);
      res.status(500).json({
        success: false,
        message: 'Error interno del servidor',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  }
);

// Crear nuevo equipo
router.post('/',
  authenticateToken,
  [
    body('descripcion').trim().notEmpty().withMessage('Descripción es requerida'),
    body('marca').trim().notEmpty().withMessage('Marca es requerida'),
    body('modelo').trim().notEmpty().withMessage('Modelo es requerido'),
    body('ano').isInt({ min: 1900, max: 2030 }).withMessage('Año debe ser un número válido entre 1900 y 2030'),
    body('owner').isIn(['Pinellas', 'COCP']).withMessage('Owner debe ser Pinellas o COCP'),
    body('codigo').optional({ nullable: true, checkFalsy: true }).trim(),
    body('motor').optional({ nullable: true, checkFalsy: true }).trim(),
    body('chasis').optional({ nullable: true, checkFalsy: true }).trim(),
    body('costo').optional({ nullable: true, checkFalsy: true }).isDecimal().withMessage('Costo debe ser un número válido'),
    body('valor_actual').optional({ nullable: true, checkFalsy: true }).isDecimal().withMessage('Valor actual debe ser un número válido'),
    body('rata_mes').optional({ nullable: true, checkFalsy: true }).isDecimal().withMessage('Rata mensual debe ser un número válido'),
    body('proyecto').optional({ nullable: true, checkFalsy: true }).trim(),
    body('responsable').optional({ nullable: true, checkFalsy: true }).trim(),
    body('estado').optional({ nullable: true, checkFalsy: true }).trim(),
    body('observaciones').optional({ nullable: true, checkFalsy: true }).trim()
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        console.log('❌ Validation errors (CREATE):', JSON.stringify(errors.array(), null, 2));
        return res.status(400).json({
          success: false,
          message: 'Datos de entrada inválidos',
          errors: errors.array()
        });
      }

      const {
        codigo,
        descripcion,
        marca,
        modelo,
        ano,
        motor,
        chasis,
        costo,
        valor_actual,
        rata_mes,
        proyecto,
        responsable,
        estado,
        observaciones,
        owner
      } = req.body;

      const insertQuery = `
        INSERT INTO equipos (
          codigo, descripcion, marca, modelo, ano, motor, chasis,
          costo, valor_actual, rata_mes, proyecto, responsable,
          estado, observaciones, owner
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15
        ) RETURNING id
      `;

      const values = [
        codigo || null,
        descripcion,
        marca,
        modelo,
        ano,
        motor || null,
        chasis || null,
        costo ? parseFloat(costo) : null,
        valor_actual ? parseFloat(valor_actual) : null,
        rata_mes ? parseFloat(rata_mes) : null,
        proyecto || null,
        responsable || null,
        estado || null,
        observaciones || null,
        owner
      ];

      const result = await query(insertQuery, values);

      console.log('✅ Equipo creado con ID:', result.rows[0].id);

      res.status(201).json({
        success: true,
        message: 'Equipo creado exitosamente',
        data: { id: result.rows[0].id }
      });

    } catch (error) {
      console.error('❌ Error al crear equipo:', error);
      res.status(500).json({
        success: false,
        message: 'Error interno del servidor',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  }
);

// Actualizar equipo
router.put('/:id',
  authenticateToken,
  [
    param('id').isInt().withMessage('ID debe ser un número entero'),
    body('descripcion').trim().notEmpty().withMessage('Descripción es requerida'),
    body('marca').trim().notEmpty().withMessage('Marca es requerida'),
    body('modelo').trim().notEmpty().withMessage('Modelo es requerido'),
    body('ano').isInt({ min: 1900, max: 2030 }).withMessage('Año debe ser un número válido entre 1900 y 2030'),
    body('owner').isIn(['Pinellas', 'COCP']).withMessage('Owner debe ser Pinellas o COCP'),
    body('codigo').optional().trim(),
    body('motor').optional().trim(),
    body('chasis').optional().trim(),
    body('costo').optional().isDecimal().withMessage('Costo debe ser un número válido'),
    body('valor_actual').optional().isDecimal().withMessage('Valor actual debe ser un número válido'),
    body('rata_mes').optional().isDecimal().withMessage('Rata mensual debe ser un número válido'),
    body('proyecto').optional().trim(),
    body('responsable').optional().trim(),
    body('estado').optional().trim(),
    body('observaciones').optional().trim()
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Datos de entrada inválidos',
          errors: errors.array()
        });
      }

      const { id } = req.params;
      const {
        codigo,
        descripcion,
        marca,
        modelo,
        ano,
        motor,
        chasis,
        costo,
        valor_actual,
        rata_mes,
        proyecto,
        responsable,
        estado,
        observaciones,
        owner
      } = req.body;

      // Verificar que el equipo existe
      const existsQuery = 'SELECT id FROM equipos WHERE id = $1 AND activo = true';
      const existsResult = await query(existsQuery, [id]);

      if (existsResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Equipo no encontrado'
        });
      }

      const updateQuery = `
        UPDATE equipos SET
          codigo = $1,
          descripcion = $2,
          marca = $3,
          modelo = $4,
          ano = $5,
          motor = $6,
          chasis = $7,
          costo = $8,
          valor_actual = $9,
          rata_mes = $10,
          proyecto = $11,
          responsable = $12,
          estado = $13,
          observaciones = $14,
          owner = $15,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $16
      `;

      const values = [
        codigo || null,
        descripcion,
        marca,
        modelo,
        ano,
        motor || null,
        chasis || null,
        costo ? parseFloat(costo) : null,
        valor_actual ? parseFloat(valor_actual) : null,
        rata_mes ? parseFloat(rata_mes) : null,
        proyecto || null,
        responsable || null,
        estado || null,
        observaciones || null,
        owner,
        id
      ];

      await query(updateQuery, values);

      console.log('✅ Equipo actualizado:', id);

      res.json({
        success: true,
        message: 'Equipo actualizado exitosamente'
      });

    } catch (error) {
      console.error('❌ Error al actualizar equipo:', error);
      res.status(500).json({
        success: false,
        message: 'Error interno del servidor',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  }
);

// Actualizar status de equipo (solo campos operativos)
router.put('/:id/status',
  authenticateToken,
  [
    param('id').isInt().withMessage('ID debe ser un número entero'),
    body('estado').optional().trim(),
    body('proyecto').optional().trim(),
    body('responsable').optional().trim(),
    body('rata_mes').optional().isDecimal().withMessage('Rata mensual debe ser un número válido'),
    body('observaciones_status').optional().trim()
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Datos de entrada inválidos',
          errors: errors.array()
        });
      }

      const { id } = req.params;
      const {
        estado,
        proyecto,
        responsable,
        rata_mes,
        observaciones_status
      } = req.body;

      // Verificar que el equipo existe
      const existsQuery = 'SELECT id FROM equipos WHERE id = $1 AND activo = true';
      const existsResult = await query(existsQuery, [id]);

      if (existsResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Equipo no encontrado'
        });
      }

      const updateQuery = `
        UPDATE equipos SET
          estado = $1,
          proyecto = $2,
          responsable = $3,
          rata_mes = $4,
          observaciones_status = $5,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $6
      `;

      const values = [
        estado || null,
        proyecto || null,
        responsable || null,
        rata_mes ? parseFloat(rata_mes) : null,
        observaciones_status || null,
        id
      ];

      await query(updateQuery, values);

      console.log('✅ Status de equipo actualizado:', id);

      res.json({
        success: true,
        message: 'Status del equipo actualizado exitosamente'
      });

    } catch (error) {
      console.error('❌ Error al actualizar status del equipo:', error);
      res.status(500).json({
        success: false,
        message: 'Error interno del servidor',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  }
);

// Eliminar equipo (soft delete)
router.delete('/:id',
  authenticateToken,
  param('id').isInt().withMessage('ID debe ser un número entero'),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Datos de entrada inválidos',
          errors: errors.array()
        });
      }

      const { id } = req.params;

      // Verificar que el equipo existe
      const existsQuery = 'SELECT id FROM equipos WHERE id = $1 AND activo = true';
      const existsResult = await query(existsQuery, [id]);

      if (existsResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Equipo no encontrado'
        });
      }

      // Soft delete
      const deleteQuery = `
        UPDATE equipos
        SET activo = false, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
      `;

      await query(deleteQuery, [id]);

      console.log('✅ Equipo eliminado (soft delete):', id);

      res.json({
        success: true,
        message: 'Equipo eliminado exitosamente'
      });

    } catch (error) {
      console.error('❌ Error al eliminar equipo:', error);
      res.status(500).json({
        success: false,
        message: 'Error interno del servidor',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  }
);

module.exports = router;