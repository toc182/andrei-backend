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
    
    // If table doesn't exist, return empty array
    if (error.message.includes('relation "expense_categories" does not exist')) {
      console.log('⚠️ Cost tracking tables not yet created, returning empty categories');
      return res.json({
        success: true,
        categories: []
      });
    }

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
// PROJECT EXPENSE CATEGORIES ROUTES
// ===============================

// Get project categories (with custom categories support)
router.get('/projects/:projectId/categories', authenticateToken, [
  param('projectId').isInt().withMessage('ID de proyecto inválido')
], async (req, res) => {
  try {
    const { projectId } = req.params;

    // Check if project has custom category settings
    const hasCustomSettings = await query(`
      SELECT COUNT(*) as count FROM project_expense_categories WHERE project_id = $1
    `, [projectId]);

    if (parseInt(hasCustomSettings.rows[0].count) === 0) {
      // Initialize with default categories
      await query(`SELECT initialize_project_categories($1)`, [projectId]);
    }

    // Get active categories for this project
    const result = await query(`
      SELECT
        pec.id,
        pec.project_id,
        pec.category_id,
        COALESCE(pec.nombre, ec.nombre) as nombre,
        COALESCE(pec.codigo, ec.codigo) as codigo,
        COALESCE(pec.color, ec.color) as color,
        pec.activo,
        pec.orden,
        CASE WHEN pec.category_id IS NOT NULL THEN false ELSE true END as is_custom
      FROM project_expense_categories pec
      LEFT JOIN expense_categories ec ON pec.category_id = ec.id
      WHERE pec.project_id = $1 AND pec.activo = true
      ORDER BY pec.orden, COALESCE(pec.nombre, ec.nombre)
    `, [projectId]);

    res.json({
      success: true,
      categories: result.rows
    });

  } catch (error) {
    console.error('Error fetching project categories:', error);
    res.status(500).json({
      success: false,
      message: 'Error cargando categorías del proyecto'
    });
  }
});

// Get available categories to add (removed ones + option to create new)
router.get('/projects/:projectId/categories/available', authenticateToken, [
  param('projectId').isInt().withMessage('ID de proyecto inválido')
], async (req, res) => {
  try {
    const { projectId } = req.params;

    // Get inactive (removed) global categories for this project
    const result = await query(`
      SELECT
        pec.id,
        pec.category_id,
        ec.nombre,
        ec.codigo,
        ec.color
      FROM project_expense_categories pec
      JOIN expense_categories ec ON pec.category_id = ec.id
      WHERE pec.project_id = $1 AND pec.activo = false
      ORDER BY ec.orden, ec.nombre
    `, [projectId]);

    res.json({
      success: true,
      availableCategories: result.rows
    });

  } catch (error) {
    console.error('Error fetching available categories:', error);
    res.status(500).json({
      success: false,
      message: 'Error cargando categorías disponibles'
    });
  }
});

// Remove category from project (set activo = false)
router.delete('/projects/:projectId/categories/:categoryId', authenticateToken, requireManager, [
  param('projectId').isInt().withMessage('ID de proyecto inválido'),
  param('categoryId').isInt().withMessage('ID de categoría inválido')
], async (req, res) => {
  try {
    const { projectId, categoryId } = req.params;

    // Check if category has expenses
    const expenseCheck = await query(`
      SELECT COUNT(*) as count FROM project_expenses
      WHERE project_id = $1 AND category_id = (
        SELECT COALESCE(category_id, $2) FROM project_expense_categories WHERE id = $2
      )
    `, [projectId, categoryId]);

    if (parseInt(expenseCheck.rows[0].count) > 0) {
      return res.status(400).json({
        success: false,
        message: 'No se puede eliminar una categoría con gastos registrados'
      });
    }

    // Set category as inactive
    await query(`
      UPDATE project_expense_categories
      SET activo = false, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND project_id = $2
    `, [categoryId, projectId]);

    res.json({
      success: true,
      message: 'Categoría removida exitosamente'
    });

  } catch (error) {
    console.error('Error removing category:', error);
    res.status(500).json({
      success: false,
      message: 'Error removiendo categoría'
    });
  }
});

// Re-activate a removed category
router.post('/projects/:projectId/categories/:categoryId/activate', authenticateToken, requireManager, [
  param('projectId').isInt().withMessage('ID de proyecto inválido'),
  param('categoryId').isInt().withMessage('ID de categoría inválido')
], async (req, res) => {
  try {
    const { projectId, categoryId } = req.params;

    await query(`
      UPDATE project_expense_categories
      SET activo = true, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND project_id = $2
    `, [categoryId, projectId]);

    res.json({
      success: true,
      message: 'Categoría reactivada exitosamente'
    });

  } catch (error) {
    console.error('Error activating category:', error);
    res.status(500).json({
      success: false,
      message: 'Error reactivando categoría'
    });
  }
});

// Create custom category for project
router.post('/projects/:projectId/categories', authenticateToken, requireManager, [
  param('projectId').isInt().withMessage('ID de proyecto inválido'),
  body('nombre').trim().isLength({ min: 2 }).withMessage('Nombre debe tener al menos 2 caracteres'),
  body('codigo').trim().isLength({ min: 2, max: 10 }).withMessage('Código debe tener entre 2 y 10 caracteres'),
  body('color').optional().matches(/^#[0-9A-F]{6}$/i).withMessage('Color debe ser un código hex válido')
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
    const { nombre, codigo, color = '#808080' } = req.body;

    // Get max order
    const maxOrder = await query(`
      SELECT COALESCE(MAX(orden), 0) + 1 as next_orden
      FROM project_expense_categories WHERE project_id = $1
    `, [projectId]);

    const result = await query(`
      INSERT INTO project_expense_categories (
        project_id, category_id, nombre, codigo, color, activo, orden
      ) VALUES ($1, NULL, $2, $3, $4, true, $5)
      RETURNING *
    `, [projectId, nombre, codigo, color, maxOrder.rows[0].next_orden]);

    res.status(201).json({
      success: true,
      message: 'Categoría creada exitosamente',
      category: {
        ...result.rows[0],
        is_custom: true
      }
    });

  } catch (error) {
    console.error('Error creating custom category:', error);
    if (error.code === '23505') {
      return res.status(400).json({
        success: false,
        message: 'Ya existe una categoría con ese código en este proyecto'
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
      LEFT JOIN proyectos p ON pb.project_id = p.id
      WHERE pb.project_id = $1
    `, [projectId]);

    // Get budget by categories (using project_expense_categories)
    const categoriesResult = await query(`
      SELECT
        bc.*,
        pec.nombre as categoria_nombre,
        pec.codigo as categoria_codigo,
        pec.color as categoria_color,
        pec.id as project_category_id
      FROM budget_categories bc
      JOIN project_expense_categories pec ON bc.project_category_id = pec.id
      WHERE bc.project_id = $1 AND pec.activo = true
      ORDER BY pec.nombre
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
      WHERE pe.project_id = $1 AND pe.tipo_gasto = 'real'
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
    
    // If cost tracking tables don't exist, return empty budget
    if (error.message.includes('does not exist')) {
      console.log('⚠️ Cost tracking tables not yet created, returning empty budget');
      return res.json({
        success: true,
        budget: {
          total_presupuestado: 0,
          total_gastado: 0,
          saldo_disponible: 0,
          porcentaje_usado: 0
        },
        categories: [],
        expenses: []
      });
    }

    res.status(500).json({
      success: false,
      message: 'Error cargando presupuesto del proyecto'
    });
  }
});

// Create/Update project budget
// Solo guarda distribución por categorías y notas
// El monto del contrato ya está en proyectos.monto_contrato_original
router.post('/projects/:projectId/budget', authenticateToken, requireManager, [
  param('projectId').isInt().withMessage('ID de proyecto inválido'),
  body('categories').isArray().withMessage('Categorías debe ser un array'),
  body('categories.*.project_category_id').isInt().withMessage('ID de categoría inválido'),
  body('categories.*.presupuesto_inicial').isNumeric().withMessage('Presupuesto inicial debe ser un número'),
  body('categories.*.presupuesto_actual').isNumeric().withMessage('Presupuesto actual debe ser un número')
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
      notas,
      categories = []
    } = req.body;

    // Start transaction
    await query('BEGIN');

    try {
      // Marcar proyecto como que tiene presupuesto configurado
      await query(`
        UPDATE proyectos
        SET
          tiene_presupuesto = true,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
      `, [projectId]);

      // Upsert project budget (only metadata - notas)
      await query(`
        INSERT INTO project_budgets (
          project_id, moneda, notas, created_by
        ) VALUES ($1, $2, $3, $4)
        ON CONFLICT (project_id)
        DO UPDATE SET
          notas = $3,
          updated_at = CURRENT_TIMESTAMP,
          updated_by = $4
        RETURNING id
      `, [projectId, 'PAB', notas || '', req.user.id]);

      // Delete existing category budgets (to handle category removal)
      await query(`
        DELETE FROM budget_categories
        WHERE project_id = $1
      `, [projectId]);

      // Insert category budgets using project_category_id
      for (const category of categories) {
        await query(`
          INSERT INTO budget_categories (
            project_id, project_category_id, presupuesto_inicial, presupuesto_actual
          ) VALUES ($1, $2, $3, $4)
        `, [
          projectId,
          category.project_category_id,
          category.presupuesto_inicial,
          category.presupuesto_actual
        ]);
      }

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

    let whereClause = 'WHERE pe.project_id = $1';
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

    // If cost tracking tables don't exist, return empty expenses
    if (error.message.includes('does not exist')) {
      console.log('⚠️ Cost tracking tables not yet created, returning empty expenses');
      const { page = 1, limit = 20 } = req.query;
      return res.json({
        success: true,
        expenses: [],
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: 0,
          totalPages: 0,
          hasNext: false,
          hasPrev: false
        }
      });
    }

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
      tipo_gasto = 'real'
    } = req.body;

    const result = await query(`
      INSERT INTO project_expenses (
        project_id, category_id, fecha, concepto, descripcion, monto, moneda,
        tipo_gasto, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `, [
      projectId, category_id, fecha, concepto, descripcion, monto, moneda,
      tipo_gasto, req.user.id
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

// Delete project expense
router.delete('/projects/:projectId/expenses/:expenseId', authenticateToken, [
  param('projectId').isInt().withMessage('ID de proyecto inválido'),
  param('expenseId').isInt().withMessage('ID de gasto inválido')
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

    const { projectId, expenseId } = req.params;

    // Verify expense belongs to project
    const expense = await query(`
      SELECT id FROM project_expenses
      WHERE id = $1 AND project_id = $2
    `, [expenseId, projectId]);

    if (expense.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Gasto no encontrado'
      });
    }

    // Delete expense
    await query('DELETE FROM project_expenses WHERE id = $1', [expenseId]);

    res.json({
      success: true,
      message: 'Gasto eliminado exitosamente'
    });

  } catch (error) {
    console.error('Error deleting project expense:', error);
    res.status(500).json({
      success: false,
      message: 'Error eliminando gasto'
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

    // Get project info (for contract amount)
    const projectResult = await query(`
      SELECT
        id,
        nombre,
        monto_contrato_original
      FROM proyectos
      WHERE id = $1
    `, [projectId]);

    const project = projectResult.rows[0];
    if (!project) {
      return res.status(404).json({
        success: false,
        message: 'Proyecto no encontrado'
      });
    }

    // Get budget summary (optional)
    const budgetResult = await query(`
      SELECT
        pb.*,
        p.nombre as proyecto_nombre
      FROM project_budgets pb
      JOIN proyectos p ON pb.project_id = p.id
      WHERE pb.project_id = $1
    `, [projectId]);

    // Get expenses by category (using project_expense_categories as the source)
    const expensesByCategory = await query(`
      SELECT
        pec.id as project_category_id,
        COALESCE(pec.nombre, ec.nombre) as nombre,
        COALESCE(pec.codigo, ec.codigo) as codigo,
        COALESCE(pec.color, ec.color) as color,
        COALESCE(bc.presupuesto_actual, 0) as presupuesto_actual,
        COALESCE(SUM(pe.monto), 0) as gastado,
        COUNT(pe.id) as total_gastos
      FROM project_expense_categories pec
      LEFT JOIN expense_categories ec ON pec.category_id = ec.id
      LEFT JOIN budget_categories bc ON pec.id = bc.project_category_id
        AND bc.project_id = $1
      LEFT JOIN project_expenses pe ON pec.category_id = pe.category_id
        AND pe.project_id = $1 AND pe.tipo_gasto = 'real'
      WHERE pec.project_id = $1 AND pec.activo = true
      GROUP BY pec.id, pec.nombre, pec.codigo, pec.color, ec.nombre, ec.codigo, ec.color, bc.presupuesto_actual
      ORDER BY COALESCE(pec.nombre, ec.nombre)
    `, [projectId]);

    // Calculate disponible and porcentaje_usado for each category
    const categoriesWithCalculations = expensesByCategory.rows.map(cat => {
      const presupuesto = parseFloat(cat.presupuesto_actual) || 0;
      const gastado = parseFloat(cat.gastado) || 0;
      const disponible = presupuesto - gastado;
      const porcentaje_usado = presupuesto > 0 ? (gastado / presupuesto) * 100 : 0;
      return {
        ...cat,
        presupuesto_actual: presupuesto,
        gastado: gastado,
        disponible: disponible,
        porcentaje_usado: porcentaje_usado
      };
    });

    // Get recent expenses
    const recentExpenses = await query(`
      SELECT
        pe.*,
        COALESCE(pec.nombre, ec.nombre) as categoria_nombre,
        COALESCE(pec.color, ec.color) as categoria_color
      FROM project_expenses pe
      LEFT JOIN expense_categories ec ON pe.category_id = ec.id
      LEFT JOIN project_expense_categories pec ON pec.category_id = pe.category_id
        AND pec.project_id = pe.project_id
      WHERE pe.project_id = $1
      ORDER BY pe.created_at DESC
      LIMIT 10
    `, [projectId]);

    // Get monthly spending trend
    const monthlyTrend = await query(`
      SELECT
        DATE_TRUNC('month', fecha) as mes,
        SUM(monto) as total_mes
      FROM project_expenses
      WHERE project_id = $1 AND tipo_gasto = 'real'
        AND fecha >= DATE_TRUNC('month', CURRENT_DATE - INTERVAL '11 months')
      GROUP BY DATE_TRUNC('month', fecha)
      ORDER BY mes
    `, [projectId]);

    const budget = budgetResult.rows[0] || null;
    const categories = categoriesWithCalculations;
    const expenses = recentExpenses.rows;
    const trend = monthlyTrend.rows;

    // Calculate totals
    const totalPresupuestado = categories.reduce((sum, cat) => sum + (cat.presupuesto_actual || 0), 0);
    const totalGastado = categories.reduce((sum, cat) => sum + (cat.gastado || 0), 0);

    // Use contract amount if no budget configured
    const montoContrato = parseFloat(project.monto_contrato_original || 0);
    const presupuestoFinal = totalPresupuestado > 0 ? totalPresupuestado : montoContrato;

    res.json({
      success: true,
      dashboard: {
        project: {
          id: project.id,
          nombre: project.nombre,
          monto_contrato_original: montoContrato
        },
        budget: {
          ...budget,
          presupuesto_aprobado: presupuestoFinal,
          monto_contrato_original: montoContrato,
          total_presupuestado: totalPresupuestado,
          total_gastado: totalGastado,
          saldo_disponible: presupuestoFinal - totalGastado,
          porcentaje_usado: presupuestoFinal > 0 ? (totalGastado / presupuestoFinal * 100) : 0,
          tiene_presupuesto_configurado: budget !== null && totalPresupuestado > 0
        },
        totalSpent: totalGastado,
        totalAvailable: presupuestoFinal - totalGastado,
        percentageUsed: presupuestoFinal > 0 ? (totalGastado / presupuestoFinal * 100) : 0,
        categoryBreakdown: categories,
        recentExpenses: expenses,
        monthlyTrend: trend
      }
    });

  } catch (error) {
    console.error('Error fetching cost dashboard:', error);
    
    // If cost tracking tables don't exist, return empty dashboard
    if (error.message.includes('does not exist')) {
      console.log('⚠️ Cost tracking tables not yet created, returning empty dashboard');
      return res.json({
        success: true,
        dashboard: {
          budget: {
            total_presupuestado: 0,
            total_gastado: 0,
            saldo_disponible: 0,
            porcentaje_usado: 0
          },
          totalSpent: 0,
          totalAvailable: 0,
          percentageUsed: 0,
          categoryBreakdown: [],
          recentExpenses: [],
          monthlyTrend: []
        }
      });
    }

    res.status(500).json({
      success: false,
      message: 'Error cargando dashboard de costos'
    });
  }
});

module.exports = router;