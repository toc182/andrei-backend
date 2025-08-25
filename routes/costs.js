const express = require('express');
const { body, validationResult, param } = require('express-validator');
const { query } = require('../database/config');
const { authenticateToken, requireManager } = require('../middleware/auth');

const router = express.Router();

// ===============================
// EXPENSE CATEGORIES ROUTES
// ===============================

// Get all expense categories
router.get('/categories', authenticateToken, async (req, res) => {
  try {
    console.log('📂 Fetching expense categories...');
    
    const result = await query(`
      SELECT 
        id, nombre, descripcion, codigo, color, orden, activo
      FROM expense_categories 
      WHERE activo = true 
      ORDER BY orden, nombre
    `);

    console.log('📂 Categories found:', result.rows.length);

    res.json({
      success: true,
      categories: result.rows
    });

  } catch (error) {
    console.error('❌ Error fetching expense categories:', error);
    res.status(500).json({
      success: false,
      message: 'Error cargando categorías de gastos',
      error: error.message
    });
  }
});

// Create expense category (admin only)
router.post('/categories', requireManager, [
  body('nombre').trim().isLength({ min: 2 }).withMessage('Nombre debe tener al menos 2 caracteres'),
  body('codigo').trim().isLength({ min: 2, max: 10 }).withMessage('Código debe tener entre 2 y 10 caracteres'),
  body('color').optional().matches(/^#[0-9A-F]{6}$/i).withMessage('Color debe ser un código hex válido'),
  body('orden').optional().isInt({ min: 0 }).withMessage('Orden debe ser un número positivo')
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

    const { nombre, descripcion, codigo, color = '#007bff', orden = 0 } = req.body;

    const result = await query(`
      INSERT INTO expense_categories (nombre, descripcion, codigo, color, orden)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `, [nombre, descripcion, codigo, color, orden]);

    res.status(201).json({
      success: true,
      message: 'Categoría creada exitosamente',
      category: result.rows[0]
    });

  } catch (error) {
    console.error('Error creating expense category:', error);
    if (error.code === '23505') {
      return res.status(400).json({
        success: false,
        message: 'El código de categoría ya existe'
      });
    }
    res.status(500).json({
      success: false,
      message: 'Error creando categoría'
    });
  }
});

// ===============================
// PROJECT BUDGET ROUTES
// ===============================

// Get project budget
router.get('/projects/:projectId/budget', authenticateToken, [
  param('projectId').isInt().withMessage('ID de proyecto inválido')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Parámetros inválidos',
        errors: errors.array()
      });
    }

    const { projectId } = req.params;

    // Get project budget
    const budgetResult = await query(`
      SELECT 
        pb.*,
        p.nombre as proyecto_nombre,
        p.monto_contrato_original
      FROM project_budgets pb
      LEFT JOIN proyectos p ON pb.proyecto_id = p.id
      WHERE pb.proyecto_id = $1
    `, [projectId]);

    // Get budget by categories
    const categoriesResult = await query(`
      SELECT 
        bc.*,
        ec.nombre as categoria_nombre,
        ec.codigo as categoria_codigo,
        ec.color as categoria_color
      FROM budget_categories bc
      JOIN expense_categories ec ON bc.category_id = ec.id
      WHERE bc.proyecto_id = $1
      ORDER BY ec.orden, ec.nombre
    `, [projectId]);

    // Get expense summary by category
    const expensesResult = await query(`
      SELECT 
        pe.category_id,
        ec.nombre as categoria_nombre,
        ec.codigo as categoria_codigo,
        SUM(pe.monto) as total_gastado,
        COUNT(pe.id) as total_gastos
      FROM project_expenses pe
      JOIN expense_categories ec ON pe.category_id = ec.id
      WHERE pe.proyecto_id = $1 AND pe.tipo_gasto = 'real'
      GROUP BY pe.category_id, ec.nombre, ec.codigo, ec.orden
      ORDER BY ec.orden, ec.nombre
    `, [projectId]);

    const budget = budgetResult.rows[0] || null;
    const categories = categoriesResult.rows;
    const expenses = expensesResult.rows;

    // Calculate totals
    const totalPresupuestado = categories.reduce((sum, cat) => sum + parseFloat(cat.presupuesto_actual || 0), 0);
    const totalGastado = expenses.reduce((sum, exp) => sum + parseFloat(exp.total_gastado || 0), 0);

    res.json({
      success: true,
      budget: {
        ...budget,
        total_presupuestado: totalPresupuestado,
        total_gastado: totalGastado,
        saldo_disponible: totalPresupuestado - totalGastado,
        porcentaje_usado: totalPresupuestado > 0 ? (totalGastado / totalPresupuestado * 100) : 0
      },
      categories,
      expenses
    });

  } catch (error) {
    console.error('Error fetching project budget:', error);
    res.status(500).json({
      success: false,
      message: 'Error cargando presupuesto del proyecto'
    });
  }
});

// Create/Update project budget
router.post('/projects/:projectId/budget', requireManager, [
  param('projectId').isInt().withMessage('ID de proyecto inválido'),
  body('monto_contrato_original').isDecimal().withMessage('Monto original debe ser un número'),
  body('monto_contrato_actual').isDecimal().withMessage('Monto actual debe ser un número'),
  body('contingencia_porcentaje').optional().isDecimal({ min: 0, max: 100 }).withMessage('Contingencia debe estar entre 0 y 100%'),
  body('categories').isArray().withMessage('Categorías debe ser un array'),
  body('categories.*.category_id').isInt().withMessage('ID de categoría inválido'),
  body('categories.*.presupuesto_inicial').isDecimal().withMessage('Presupuesto inicial debe ser un número'),
  body('categories.*.presupuesto_actual').isDecimal().withMessage('Presupuesto actual debe ser un número')
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

    const { projectId } = req.params;
    const { 
      monto_contrato_original, 
      monto_contrato_actual, 
      contingencia_porcentaje = 10,
      notas,
      categories = [] 
    } = req.body;

    const contingencia_monto = (parseFloat(monto_contrato_actual) * parseFloat(contingencia_porcentaje)) / 100;
    const presupuesto_aprobado = parseFloat(monto_contrato_actual) + contingencia_monto;

    // Start transaction
    await query('BEGIN');

    try {
      // Upsert project budget
      await query(`
        INSERT INTO project_budgets (
          proyecto_id, monto_contrato_original, monto_contrato_actual, 
          contingencia_porcentaje, contingencia_monto, presupuesto_aprobado,
          notas, created_by, updated_by
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
        ON CONFLICT (proyecto_id) 
        DO UPDATE SET 
          monto_contrato_actual = $3,
          contingencia_porcentaje = $4,
          contingencia_monto = $5,
          presupuesto_aprobado = $6,
          notas = $7,
          updated_by = $8,
          updated_at = CURRENT_TIMESTAMP
      `, [
        projectId, monto_contrato_original, monto_contrato_actual,
        contingencia_porcentaje, contingencia_monto, presupuesto_aprobado,
        notas, req.user.id
      ]);

      // Update category budgets
      for (const category of categories) {
        await query(`
          INSERT INTO budget_categories (
            proyecto_id, category_id, presupuesto_inicial, presupuesto_actual
          ) VALUES ($1, $2, $3, $4)
          ON CONFLICT (proyecto_id, category_id)
          DO UPDATE SET 
            presupuesto_actual = $4,
            updated_at = CURRENT_TIMESTAMP
        `, [
          projectId, 
          category.category_id, 
          category.presupuesto_inicial, 
          category.presupuesto_actual
        ]);
      }

      // Update project flag
      await query(`
        UPDATE proyectos 
        SET tiene_presupuesto = true 
        WHERE id = $1
      `, [projectId]);

      await query('COMMIT');

      res.json({
        success: true,
        message: 'Presupuesto actualizado exitosamente'
      });

    } catch (error) {
      await query('ROLLBACK');
      throw error;
    }

  } catch (error) {
    console.error('Error updating project budget:', error);
    res.status(500).json({
      success: false,
      message: 'Error actualizando presupuesto'
    });
  }
});

// ===============================
// PROJECT EXPENSES ROUTES
// ===============================

// Get project expenses
router.get('/projects/:projectId/expenses', authenticateToken, [
  param('projectId').isInt().withMessage('ID de proyecto inválido')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Parámetros inválidos',
        errors: errors.array()
      });
    }

    const { projectId } = req.params;
    const { page = 1, limit = 20, categoria, fecha_desde, fecha_hasta, tipo_gasto, period } = req.query;
    const offset = (page - 1) * limit;

    let whereClause = 'WHERE pe.proyecto_id = $1';
    const queryParams = [projectId];
    let paramCounter = 2;

    // Filters
    if (categoria) {
      whereClause += ` AND pe.category_id = $${paramCounter}`;
      queryParams.push(categoria);
      paramCounter++;
    }

    // Period filtering
    if (period && period !== 'all') {
      const days = parseInt(period);
      if (!isNaN(days)) {
        whereClause += ` AND pe.fecha >= CURRENT_DATE - INTERVAL '${days} days'`;
      }
    }

    if (fecha_desde) {
      whereClause += ` AND pe.fecha >= $${paramCounter}`;
      queryParams.push(fecha_desde);
      paramCounter++;
    }

    if (fecha_hasta) {
      whereClause += ` AND pe.fecha <= $${paramCounter}`;
      queryParams.push(fecha_hasta);
      paramCounter++;
    }

    if (tipo_gasto) {
      whereClause += ` AND pe.tipo_gasto = $${paramCounter}`;
      queryParams.push(tipo_gasto);
      paramCounter++;
    }

    const result = await query(`
      SELECT 
        pe.*,
        ec.nombre as categoria_nombre,
        ec.codigo as categoria_codigo,
        ec.color as categoria_color,
        u.nombre as creado_por_nombre
      FROM project_expenses pe
      JOIN expense_categories ec ON pe.category_id = ec.id
      LEFT JOIN users u ON pe.created_by = u.id
      ${whereClause}
      ORDER BY pe.fecha DESC, pe.created_at DESC
      LIMIT $${paramCounter} OFFSET $${paramCounter + 1}
    `, [...queryParams, limit, offset]);

    // Get total count
    const countResult = await query(`
      SELECT COUNT(*) as total
      FROM project_expenses pe
      ${whereClause}
    `, queryParams);

    const total = parseInt(countResult.rows[0].total);
    const totalPages = Math.ceil(total / limit);

    res.json({
      success: true,
      expenses: result.rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1
      }
    });

  } catch (error) {
    console.error('Error fetching project expenses:', error);
    res.status(500).json({
      success: false,
      message: 'Error cargando gastos del proyecto'
    });
  }
});

// Create project expense
router.post('/projects/:projectId/expenses', authenticateToken, [
  param('projectId').isInt().withMessage('ID de proyecto inválido'),
  body('category_id').isInt().withMessage('Categoría es requerida'),
  body('fecha').isDate().withMessage('Fecha inválida'),
  body('concepto').trim().isLength({ min: 3 }).withMessage('Concepto debe tener al menos 3 caracteres'),
  body('monto').isDecimal({ decimal_digits: '0,2' }).withMessage('Monto debe ser un número válido'),
  body('tipo_gasto').optional().isIn(['real', 'compromiso', 'estimado']).withMessage('Tipo de gasto inválido')
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

    const { projectId } = req.params;
    const { 
      category_id, fecha, concepto, descripcion, monto, moneda = 'USD',
      tipo_gasto = 'real', proveedor, numero_factura, numero_orden_compra,
      centro_costo, observaciones
    } = req.body;

    const result = await query(`
      INSERT INTO project_expenses (
        proyecto_id, category_id, fecha, concepto, descripcion, monto, moneda,
        tipo_gasto, proveedor, numero_factura, numero_orden_compra, centro_costo,
        observaciones, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      RETURNING *
    `, [
      projectId, category_id, fecha, concepto, descripcion, monto, moneda,
      tipo_gasto, proveedor, numero_factura, numero_orden_compra, centro_costo,
      observaciones, req.user.id
    ]);

    res.status(201).json({
      success: true,
      message: 'Gasto registrado exitosamente',
      expense: result.rows[0]
    });

  } catch (error) {
    console.error('Error creating project expense:', error);
    res.status(500).json({
      success: false,
      message: 'Error registrando gasto'
    });
  }
});

// ===============================
// COST DASHBOARD ROUTES
// ===============================

// Get project cost dashboard
router.get('/projects/:projectId/dashboard', authenticateToken, [
  param('projectId').isInt().withMessage('ID de proyecto inválido')
], async (req, res) => {
  try {
    const { projectId } = req.params;

    // Get budget summary
    const budgetResult = await query(`
      SELECT 
        pb.*,
        p.nombre as proyecto_nombre
      FROM project_budgets pb
      JOIN proyectos p ON pb.proyecto_id = p.id
      WHERE pb.proyecto_id = $1
    `, [projectId]);

    // Get expenses by category
    const expensesByCategory = await query(`
      SELECT 
        ec.id,
        ec.nombre,
        ec.codigo,
        ec.color,
        COALESCE(bc.presupuesto_actual, 0) as presupuestado,
        COALESCE(SUM(pe.monto), 0) as gastado,
        COUNT(pe.id) as total_gastos
      FROM expense_categories ec
      LEFT JOIN budget_categories bc ON ec.id = bc.category_id AND bc.proyecto_id = $1
      LEFT JOIN project_expenses pe ON ec.id = pe.category_id AND pe.proyecto_id = $1 AND pe.tipo_gasto = 'real'
      WHERE ec.activo = true
      GROUP BY ec.id, ec.nombre, ec.codigo, ec.color, ec.orden, bc.presupuesto_actual
      ORDER BY ec.orden, ec.nombre
    `, [projectId]);

    // Get recent expenses
    const recentExpenses = await query(`
      SELECT 
        pe.*,
        ec.nombre as categoria_nombre,
        ec.color as categoria_color
      FROM project_expenses pe
      JOIN expense_categories ec ON pe.category_id = ec.id
      WHERE pe.proyecto_id = $1
      ORDER BY pe.created_at DESC
      LIMIT 10
    `, [projectId]);

    // Get monthly spending trend
    const monthlyTrend = await query(`
      SELECT 
        DATE_TRUNC('month', fecha) as mes,
        SUM(monto) as total_mes
      FROM project_expenses
      WHERE proyecto_id = $1 AND tipo_gasto = 'real'
        AND fecha >= DATE_TRUNC('month', CURRENT_DATE - INTERVAL '11 months')
      GROUP BY DATE_TRUNC('month', fecha)
      ORDER BY mes
    `, [projectId]);

    const budget = budgetResult.rows[0] || null;
    const categories = expensesByCategory.rows;
    const expenses = recentExpenses.rows;
    const trend = monthlyTrend.rows;

    // Calculate totals
    const totalPresupuestado = categories.reduce((sum, cat) => sum + parseFloat(cat.presupuestado), 0);
    const totalGastado = categories.reduce((sum, cat) => sum + parseFloat(cat.gastado), 0);

    res.json({
      success: true,
      dashboard: {
        budget: {
          ...budget,
          total_presupuestado: totalPresupuestado,
          total_gastado: totalGastado,
          saldo_disponible: totalPresupuestado - totalGastado,
          porcentaje_usado: totalPresupuestado > 0 ? (totalGastado / totalPresupuestado * 100) : 0
        },
        categories,
        recentExpenses: expenses,
        monthlyTrend: trend
      }
    });

  } catch (error) {
    console.error('Error fetching cost dashboard:', error);
    res.status(500).json({
      success: false,
      message: 'Error cargando dashboard de costos'
    });
  }
});

module.exports = router;