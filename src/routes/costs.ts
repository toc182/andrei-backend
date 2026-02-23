import { Router, Request, Response } from 'express';
import { body, validationResult, param } from 'express-validator';
import { query } from '../database/config.js';
import { authenticateToken, requireManager } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

const router = Router();

interface CategoryRow {
  id: number;
  nombre: string;
  descripcion?: string;
  codigo: string;
  color: string;
  orden: number;
  activo: boolean;
}

interface ProjectCategoryRow extends CategoryRow {
  project_id: number;
  category_id?: number;
  is_custom: boolean;
  project_category_id?: number;
}

interface BudgetRow {
  id: number;
  project_id: number;
  moneda: string;
  notas?: string;
  proyecto_nombre?: string;
  monto_contrato_original?: number;
  created_by: number;
  updated_by?: number;
  created_at: Date;
  updated_at: Date;
}

interface BudgetCategoryRow {
  id: number;
  project_id: number;
  project_category_id: number;
  presupuesto_inicial: number;
  presupuesto_actual: number;
  categoria_nombre?: string;
  categoria_codigo?: string;
  categoria_color?: string;
}

interface ExpenseRow {
  id: number;
  project_id: number;
  category_id: number;
  fecha: Date;
  concepto: string;
  descripcion?: string;
  monto: number;
  moneda: string;
  tipo_gasto: 'real' | 'compromiso' | 'estimado';
  categoria_nombre?: string;
  categoria_codigo?: string;
  categoria_color?: string;
  creado_por_nombre?: string;
  created_by: number;
  created_at: Date;
}

interface ExpenseSummary {
  category_id: number;
  categoria_nombre: string;
  categoria_codigo: string;
  total_gastado: string;
  total_gastos: string;
}

interface QueryParams {
  page?: string;
  limit?: string;
  categoria?: string;
  fecha_desde?: string;
  fecha_hasta?: string;
  tipo_gasto?: string;
  period?: string;
}

// Get all expense categories
router.get('/categories', authenticateToken, asyncHandler(async (_req: Request, res: Response): Promise<void> => {
  console.log('📂 Fetching expense categories...');

  const result = await query<CategoryRow>(`
    SELECT id, nombre, descripcion, codigo, color, orden, activo
    FROM expense_categories
    WHERE activo = true
    ORDER BY orden, nombre
  `);

  console.log('📂 Categories found:', result.rows.length);

  res.json({ success: true, categories: result.rows });
}, {
  tableNotExistsDefault: { categories: [] }
}));

// Create expense category
router.post('/categories', requireManager, [
  body('nombre').trim().isLength({ min: 2 }).withMessage('Nombre debe tener al menos 2 caracteres'),
  body('codigo').trim().isLength({ min: 2, max: 10 }).withMessage('Código debe tener entre 2 y 10 caracteres'),
  body('color').optional().matches(/^#[0-9A-F]{6}$/i).withMessage('Color debe ser un código hex válido'),
  body('orden').optional().isInt({ min: 0 }).withMessage('Orden debe ser un número positivo')
], asyncHandler(async (req: Request<object, object, { nombre: string; descripcion?: string; codigo: string; color?: string; orden?: number }>, res: Response): Promise<void> => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ success: false, message: 'Datos inválidos', errors: errors.array() });
    return;
  }

  const { nombre, descripcion, codigo, color = '#007bff', orden = 0 } = req.body;

  const result = await query<CategoryRow>(`
    INSERT INTO expense_categories (nombre, descripcion, codigo, color, orden)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING *
  `, [nombre, descripcion, codigo, color, orden]);

  res.status(201).json({ success: true, message: 'Categoría creada exitosamente', category: result.rows[0] });
}, {
  duplicateMessage: 'El código de categoría ya existe'
}));

// Get project categories
router.get('/projects/:projectId/categories', authenticateToken, [
  param('projectId').isInt().withMessage('ID de proyecto inválido')
], asyncHandler(async (req: Request<{ projectId: string }>, res: Response): Promise<void> => {
  const { projectId } = req.params;

  const hasCustomSettings = await query<{ count: string }>(`
    SELECT COUNT(*) as count FROM project_expense_categories WHERE project_id = $1
  `, [projectId]);

  if (parseInt(hasCustomSettings.rows[0].count) === 0) {
    await query(`SELECT initialize_project_categories($1)`, [projectId]);
  }

  const result = await query<ProjectCategoryRow>(`
    SELECT
      pec.id, pec.project_id, pec.category_id,
      COALESCE(pec.nombre, ec.nombre) as nombre,
      COALESCE(pec.codigo, ec.codigo) as codigo,
      COALESCE(pec.color, ec.color) as color,
      pec.activo, pec.orden,
      CASE WHEN pec.category_id IS NOT NULL THEN false ELSE true END as is_custom
    FROM project_expense_categories pec
    LEFT JOIN expense_categories ec ON pec.category_id = ec.id
    WHERE pec.project_id = $1 AND pec.activo = true
    ORDER BY pec.orden, COALESCE(pec.nombre, ec.nombre)
  `, [projectId]);

  res.json({ success: true, categories: result.rows });
}));

// Get available categories to add
router.get('/projects/:projectId/categories/available', authenticateToken, [
  param('projectId').isInt().withMessage('ID de proyecto inválido')
], asyncHandler(async (req: Request<{ projectId: string }>, res: Response): Promise<void> => {
  const { projectId } = req.params;

  const result = await query<ProjectCategoryRow>(`
    SELECT pec.id, pec.category_id, ec.nombre, ec.codigo, ec.color
    FROM project_expense_categories pec
    JOIN expense_categories ec ON pec.category_id = ec.id
    WHERE pec.project_id = $1 AND pec.activo = false
    ORDER BY ec.orden, ec.nombre
  `, [projectId]);

  res.json({ success: true, availableCategories: result.rows });
}));

// Remove category from project
router.delete('/projects/:projectId/categories/:categoryId', authenticateToken, requireManager, [
  param('projectId').isInt().withMessage('ID de proyecto inválido'),
  param('categoryId').isInt().withMessage('ID de categoría inválido')
], asyncHandler(async (req: Request<{ projectId: string; categoryId: string }>, res: Response): Promise<void> => {
  const { projectId, categoryId } = req.params;

  const expenseCheck = await query<{ count: string }>(`
    SELECT COUNT(*) as count FROM project_expenses
    WHERE project_id = $1 AND category_id = (
      SELECT COALESCE(category_id, $2) FROM project_expense_categories WHERE id = $2
    )
  `, [projectId, categoryId]);

  if (parseInt(expenseCheck.rows[0].count) > 0) {
    res.status(400).json({ success: false, message: 'No se puede eliminar una categoría con gastos registrados' });
    return;
  }

  await query(`
    UPDATE project_expense_categories SET activo = false, updated_at = CURRENT_TIMESTAMP
    WHERE id = $1 AND project_id = $2
  `, [categoryId, projectId]);

  res.json({ success: true, message: 'Categoría removida exitosamente' });
}));

// Re-activate a removed category
router.post('/projects/:projectId/categories/:categoryId/activate', authenticateToken, requireManager, [
  param('projectId').isInt().withMessage('ID de proyecto inválido'),
  param('categoryId').isInt().withMessage('ID de categoría inválido')
], asyncHandler(async (req: Request<{ projectId: string; categoryId: string }>, res: Response): Promise<void> => {
  const { projectId, categoryId } = req.params;

  await query(`
    UPDATE project_expense_categories SET activo = true, updated_at = CURRENT_TIMESTAMP
    WHERE id = $1 AND project_id = $2
  `, [categoryId, projectId]);

  res.json({ success: true, message: 'Categoría reactivada exitosamente' });
}));

// Create custom category for project
router.post('/projects/:projectId/categories', authenticateToken, requireManager, [
  param('projectId').isInt().withMessage('ID de proyecto inválido'),
  body('nombre').trim().isLength({ min: 2 }).withMessage('Nombre debe tener al menos 2 caracteres'),
  body('codigo').trim().isLength({ min: 2, max: 10 }).withMessage('Código debe tener entre 2 y 10 caracteres'),
  body('color').optional().matches(/^#[0-9A-F]{6}$/i).withMessage('Color debe ser un código hex válido')
], asyncHandler(async (req: Request<{ projectId: string }, object, { nombre: string; codigo: string; color?: string }>, res: Response): Promise<void> => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ success: false, message: 'Datos inválidos', errors: errors.array() });
    return;
  }

  const { projectId } = req.params;
  const { nombre, codigo, color = '#e74c3c' } = req.body;

  const maxOrder = await query<{ next_orden: number }>(`
    SELECT COALESCE(MAX(orden), 0) + 1 as next_orden FROM project_expense_categories WHERE project_id = $1
  `, [projectId]);

  const result = await query<ProjectCategoryRow>(`
    INSERT INTO project_expense_categories (project_id, category_id, nombre, codigo, color, activo, orden)
    VALUES ($1, NULL, $2, $3, $4, true, $5)
    RETURNING *
  `, [projectId, nombre, codigo, color, maxOrder.rows[0].next_orden]);

  res.status(201).json({
    success: true,
    message: 'Categoría creada exitosamente',
    category: { ...result.rows[0], is_custom: true }
  });
}, {
  duplicateMessage: 'Ya existe una categoría con ese código en este proyecto'
}));

// Get project budget
router.get('/projects/:projectId/budget', authenticateToken, [
  param('projectId').isInt().withMessage('ID de proyecto inválido')
], asyncHandler(async (req: Request<{ projectId: string }>, res: Response): Promise<void> => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ success: false, message: 'Parámetros inválidos', errors: errors.array() });
    return;
  }

  const { projectId } = req.params;

  const budgetResult = await query<BudgetRow>(`
    SELECT pb.*, p.nombre as proyecto_nombre, p.monto_contrato_original
    FROM project_budgets pb
    LEFT JOIN proyectos p ON pb.project_id = p.id
    WHERE pb.project_id = $1
  `, [projectId]);

  const categoriesResult = await query<BudgetCategoryRow>(`
    SELECT bc.*, pec.nombre as categoria_nombre, pec.codigo as categoria_codigo,
           pec.color as categoria_color, pec.id as project_category_id
    FROM budget_categories bc
    JOIN project_expense_categories pec ON bc.project_category_id = pec.id
    WHERE bc.project_id = $1 AND pec.activo = true
    ORDER BY pec.nombre
  `, [projectId]);

  const expensesResult = await query<ExpenseSummary>(`
    SELECT pe.category_id, ec.nombre as categoria_nombre, ec.codigo as categoria_codigo,
           SUM(pe.monto) as total_gastado, COUNT(pe.id) as total_gastos
    FROM project_expenses pe
    JOIN expense_categories ec ON pe.category_id = ec.id
    WHERE pe.project_id = $1 AND pe.tipo_gasto = 'real'
    GROUP BY pe.category_id, ec.nombre, ec.codigo, ec.orden
    ORDER BY ec.orden, ec.nombre
  `, [projectId]);

  const budget = budgetResult.rows[0] || null;
  const categories = categoriesResult.rows;
  const expenses = expensesResult.rows;

  const totalPresupuestado = categories.reduce((sum, cat) => sum + parseFloat(String(cat.presupuesto_actual || 0)), 0);
  const totalGastado = expenses.reduce((sum, exp) => sum + parseFloat(exp.total_gastado || '0'), 0);

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
}, {
  tableNotExistsDefault: {
    budget: { total_presupuestado: 0, total_gastado: 0, saldo_disponible: 0, porcentaje_usado: 0 },
    categories: [],
    expenses: []
  }
}));

// Create/Update project budget
router.post('/projects/:projectId/budget', authenticateToken, requireManager, [
  param('projectId').isInt().withMessage('ID de proyecto inválido'),
  body('categories').isArray().withMessage('Categorías debe ser un array'),
  body('categories.*.project_category_id').isInt().withMessage('ID de categoría inválido'),
  body('categories.*.presupuesto_inicial').isNumeric().withMessage('Presupuesto inicial debe ser un número'),
  body('categories.*.presupuesto_actual').isNumeric().withMessage('Presupuesto actual debe ser un número')
], asyncHandler(async (req: Request<{ projectId: string }, object, { notas?: string; categories: Array<{ project_category_id: number; presupuesto_inicial: number; presupuesto_actual: number }> }>, res: Response): Promise<void> => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ success: false, message: 'Datos inválidos', errors: errors.array() });
    return;
  }

  const { projectId } = req.params;
  const { notas, categories = [] } = req.body;

  await query('BEGIN');

  // Try-catch interno preservado para ROLLBACK de transacción
  try {
    await query(`
      UPDATE proyectos SET tiene_presupuesto = true, updated_at = CURRENT_TIMESTAMP WHERE id = $1
    `, [projectId]);

    await query(`
      INSERT INTO project_budgets (project_id, moneda, notas, created_by)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (project_id)
      DO UPDATE SET notas = $3, updated_at = CURRENT_TIMESTAMP, updated_by = $4
      RETURNING id
    `, [projectId, 'PAB', notas || '', req.user!.id]);

    await query(`DELETE FROM budget_categories WHERE project_id = $1`, [projectId]);

    for (const category of categories) {
      await query(`
        INSERT INTO budget_categories (project_id, project_category_id, presupuesto_inicial, presupuesto_actual)
        VALUES ($1, $2, $3, $4)
      `, [projectId, category.project_category_id, category.presupuesto_inicial, category.presupuesto_actual]);
    }

    await query('COMMIT');

    res.json({ success: true, message: 'Presupuesto actualizado exitosamente' });

  } catch (err) {
    await query('ROLLBACK');
    throw err;
  }
}));

// Get project expenses
router.get('/projects/:projectId/expenses', authenticateToken, [
  param('projectId').isInt().withMessage('ID de proyecto inválido')
], asyncHandler(async (req: Request<{ projectId: string }, object, object, QueryParams>, res: Response): Promise<void> => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ success: false, message: 'Parámetros inválidos', errors: errors.array() });
    return;
  }

  const { projectId } = req.params;
  const { page = '1', limit = '20', categoria, fecha_desde, fecha_hasta, tipo_gasto, period } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  let whereClause = 'WHERE pe.project_id = $1';
  const queryParams: unknown[] = [projectId];
  let paramCounter = 2;

  if (categoria) {
    whereClause += ` AND pe.category_id = $${paramCounter}`;
    queryParams.push(categoria);
    paramCounter++;
  }

  // FIX SQL INJECTION: usar parámetro en lugar de interpolación de string
  if (period && period !== 'all') {
    const days = parseInt(period);
    if (!isNaN(days) && days > 0 && days <= 365) {
      whereClause += ` AND pe.fecha >= CURRENT_DATE - INTERVAL '1 day' * $${paramCounter}`;
      queryParams.push(days);
      paramCounter++;
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

  const result = await query<ExpenseRow>(`
    SELECT pe.*,
           COALESCE(pec.nombre, ec.nombre) as categoria_nombre,
           COALESCE(pec.codigo, ec.codigo) as categoria_codigo,
           COALESCE(pec.color, ec.color) as categoria_color,
           u.nombre as creado_por_nombre
    FROM project_expenses pe
    LEFT JOIN project_expense_categories pec ON pe.project_category_id = pec.id
    LEFT JOIN expense_categories ec ON COALESCE(pec.category_id, pe.category_id) = ec.id
    LEFT JOIN users u ON pe.created_by = u.id
    ${whereClause}
    ORDER BY pe.fecha DESC, pe.created_at DESC
    LIMIT $${paramCounter} OFFSET $${paramCounter + 1}
  `, [...queryParams, limit, offset]);

  const countResult = await query<{ total: string }>(`
    SELECT COUNT(*) as total FROM project_expenses pe ${whereClause}
  `, queryParams);

  const total = parseInt(countResult.rows[0].total);
  const totalPages = Math.ceil(total / parseInt(limit));

  res.json({
    success: true,
    expenses: result.rows,
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total,
      totalPages,
      hasNext: parseInt(page) < totalPages,
      hasPrev: parseInt(page) > 1
    }
  });
}, {
  tableNotExistsDefault: {
    expenses: [],
    pagination: { page: 1, limit: 20, total: 0, totalPages: 0, hasNext: false, hasPrev: false }
  }
}));

// Create project expense
router.post('/projects/:projectId/expenses', authenticateToken, [
  param('projectId').isInt().withMessage('ID de proyecto inválido'),
  body('category_id').isInt().withMessage('Categoría es requerida'),
  body('fecha').isDate().withMessage('Fecha inválida'),
  body('concepto').trim().isLength({ min: 3 }).withMessage('Concepto debe tener al menos 3 caracteres'),
  body('monto').isDecimal({ decimal_digits: '0,2' }).withMessage('Monto debe ser un número válido'),
  body('tipo_gasto').optional().isIn(['real', 'compromiso', 'estimado']).withMessage('Tipo de gasto inválido')
], asyncHandler(async (req: Request<{ projectId: string }, object, { category_id: number; fecha: string; concepto: string; descripcion?: string; monto: number; moneda?: string; tipo_gasto?: 'real' | 'compromiso' | 'estimado' }>, res: Response): Promise<void> => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ success: false, message: 'Datos inválidos', errors: errors.array() });
    return;
  }

  const { projectId } = req.params;
  const { category_id: project_category_id, fecha, concepto, descripcion, monto, moneda = 'USD', tipo_gasto = 'real' } = req.body;

  // Look up the global category_id from project_expense_categories for backward compatibility
  const categoryLookup = await query<{ category_id: number | null }>(`
    SELECT category_id FROM project_expense_categories WHERE id = $1 AND project_id = $2
  `, [project_category_id, projectId]);

  if (categoryLookup.rows.length === 0) {
    res.status(400).json({ success: false, message: 'Categoría no válida para este proyecto' });
    return;
  }

  const global_category_id = categoryLookup.rows[0].category_id;

  const result = await query<ExpenseRow>(`
    INSERT INTO project_expenses (project_id, project_category_id, category_id, fecha, concepto, descripcion, monto, moneda, tipo_gasto, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    RETURNING *
  `, [projectId, project_category_id, global_category_id, fecha, concepto, descripcion, monto, moneda, tipo_gasto, req.user!.id]);

  res.status(201).json({ success: true, message: 'Gasto registrado exitosamente', expense: result.rows[0] });
}));

// Delete project expense
router.delete('/projects/:projectId/expenses/:expenseId', authenticateToken, [
  param('projectId').isInt().withMessage('ID de proyecto inválido'),
  param('expenseId').isInt().withMessage('ID de gasto inválido')
], asyncHandler(async (req: Request<{ projectId: string; expenseId: string }>, res: Response): Promise<void> => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ success: false, message: 'Datos inválidos', errors: errors.array() });
    return;
  }

  const { projectId, expenseId } = req.params;

  const expense = await query<{ id: number }>(`
    SELECT id FROM project_expenses WHERE id = $1 AND project_id = $2
  `, [expenseId, projectId]);

  if (expense.rows.length === 0) {
    res.status(404).json({ success: false, message: 'Gasto no encontrado' });
    return;
  }

  await query('DELETE FROM project_expenses WHERE id = $1', [expenseId]);

  res.json({ success: true, message: 'Gasto eliminado exitosamente' });
}));

// Get project cost dashboard
router.get('/projects/:projectId/dashboard', authenticateToken, [
  param('projectId').isInt().withMessage('ID de proyecto inválido')
], asyncHandler(async (req: Request<{ projectId: string }>, res: Response): Promise<void> => {
  const { projectId } = req.params;

  const projectResult = await query<{ id: number; nombre: string; monto_contrato_original?: number }>(`
    SELECT id, nombre, monto_contrato_original FROM proyectos WHERE id = $1
  `, [projectId]);

  const project = projectResult.rows[0];
  if (!project) {
    res.status(404).json({ success: false, message: 'Proyecto no encontrado' });
    return;
  }

  const budgetResult = await query<BudgetRow>(`
    SELECT pb.*, p.nombre as proyecto_nombre
    FROM project_budgets pb JOIN proyectos p ON pb.project_id = p.id
    WHERE pb.project_id = $1
  `, [projectId]);

  const expensesByCategory = await query<{
    project_category_id: number;
    nombre: string;
    codigo: string;
    color: string;
    presupuesto_actual: number;
    gastado: string;
    total_gastos: string;
  }>(`
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
    LEFT JOIN budget_categories bc ON pec.id = bc.project_category_id AND bc.project_id = $1
    LEFT JOIN project_expenses pe ON pec.category_id = pe.category_id AND pe.project_id = $1 AND pe.tipo_gasto = 'real'
    WHERE pec.project_id = $1 AND pec.activo = true
    GROUP BY pec.id, pec.nombre, pec.codigo, pec.color, ec.nombre, ec.codigo, ec.color, bc.presupuesto_actual
    ORDER BY COALESCE(pec.nombre, ec.nombre)
  `, [projectId]);

  const categoriesWithCalculations = expensesByCategory.rows.map(cat => {
    const presupuesto = parseFloat(String(cat.presupuesto_actual)) || 0;
    const gastado = parseFloat(cat.gastado) || 0;
    return {
      ...cat,
      presupuesto_actual: presupuesto,
      gastado: gastado,
      disponible: presupuesto - gastado,
      porcentaje_usado: presupuesto > 0 ? (gastado / presupuesto) * 100 : 0
    };
  });

  const recentExpenses = await query<ExpenseRow>(`
    SELECT pe.*, COALESCE(pec.nombre, ec.nombre) as categoria_nombre, COALESCE(pec.color, ec.color) as categoria_color
    FROM project_expenses pe
    LEFT JOIN expense_categories ec ON pe.category_id = ec.id
    LEFT JOIN project_expense_categories pec ON pec.category_id = pe.category_id AND pec.project_id = pe.project_id
    WHERE pe.project_id = $1
    ORDER BY pe.created_at DESC
    LIMIT 10
  `, [projectId]);

  const monthlyTrend = await query<{ mes: Date; total_mes: string }>(`
    SELECT DATE_TRUNC('month', fecha) as mes, SUM(monto) as total_mes
    FROM project_expenses
    WHERE project_id = $1 AND tipo_gasto = 'real' AND fecha >= DATE_TRUNC('month', CURRENT_DATE - INTERVAL '11 months')
    GROUP BY DATE_TRUNC('month', fecha)
    ORDER BY mes
  `, [projectId]);

  const budget = budgetResult.rows[0] || null;
  const categories = categoriesWithCalculations;

  const totalPresupuestado = categories.reduce((sum, cat) => sum + (cat.presupuesto_actual || 0), 0);
  const totalGastado = categories.reduce((sum, cat) => sum + (cat.gastado || 0), 0);
  const montoContrato = parseFloat(String(project.monto_contrato_original || 0));
  const presupuestoFinal = totalPresupuestado > 0 ? totalPresupuestado : montoContrato;

  res.json({
    success: true,
    dashboard: {
      project: { id: project.id, nombre: project.nombre, monto_contrato_original: montoContrato },
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
      recentExpenses: recentExpenses.rows,
      monthlyTrend: monthlyTrend.rows
    }
  });
}, {
  tableNotExistsDefault: {
    dashboard: {
      budget: { total_presupuestado: 0, total_gastado: 0, saldo_disponible: 0, porcentaje_usado: 0 },
      totalSpent: 0,
      totalAvailable: 0,
      percentageUsed: 0,
      categoryBreakdown: [],
      recentExpenses: [],
      monthlyTrend: []
    }
  }
}));

export default router;
