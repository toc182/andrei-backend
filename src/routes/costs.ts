import { Router, Request, Response } from 'express';
import { body, validationResult, param } from 'express-validator';
import { query, pool } from '../database/config.js';
import {
  authenticateToken,
  checkProjectAccess,
  requireAdmin,
  requireManager,
} from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { registrarAudit } from '../services/auditLog.js';

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
  proyecto_id: number;
  categoria_id?: number;
  is_custom: boolean;
  proyecto_categoria_id?: number;
}

interface BudgetRow {
  id: number;
  proyecto_id: number;
  moneda: string;
  notas?: string;
  proyecto_nombre?: string;
  monto_contrato_original?: number;
  creado_por: number;
  actualizado_por?: number;
  created_at: Date;
  updated_at: Date;
}

interface BudgetCategoryRow {
  id: number;
  proyecto_id: number;
  proyecto_categoria_id: number;
  presupuesto_inicial: number;
  presupuesto_actual: number;
  categoria_nombre?: string;
  categoria_codigo?: string;
  categoria_color?: string;
}

interface ExpenseRow {
  id: number;
  proyecto_id: number;
  categoria_id: number;
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
  creado_por: number;
  created_at: Date;
}

interface ExpenseSummary {
  categoria_id: number;
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
router.get(
  '/categories',
  authenticateToken,
  asyncHandler(
    async (_req: Request, res: Response): Promise<void> => {
      const result = await query<CategoryRow>(`
    SELECT id, nombre, descripcion, codigo, color, orden, activo
    FROM categorias_gastos
    WHERE activo = true
    ORDER BY orden, nombre
  `);

      res.json({ success: true, categories: result.rows });
    },
    {
      tableNotExistsDefault: { categories: [] },
    },
  ),
);

/**
 * Derives a short código ("Alquiler Eq." -> "ALQ") for a new category.
 *
 * The catalog predates issue #71 and requires a unique código, but the
 * category dropdown on a solicitud de pago only asks for a name — so the
 * código is generated here instead of being demanded from the user.
 */
async function generarCodigoCategoria(nombre: string): Promise<string> {
  const base =
    nombre
      // NFD splits "Ó" into "O" + a combining accent, and the next line
      // then drops the accent — so "Ó" survives as "O" instead of vanishing.
      .normalize('NFD')
      .replace(/[^a-zA-Z]/g, '')
      .toUpperCase()
      .slice(0, 3) || 'CAT';

  const existentes = await query<{ codigo: string }>(
    'SELECT codigo FROM categorias_gastos WHERE codigo = $1 OR codigo LIKE $2',
    [base, `${base}%`],
  );
  const usados = new Set(existentes.rows.map((r) => r.codigo));

  if (!usados.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidato = `${base}${i}`;
    if (!usados.has(candidato)) return candidato;
  }
  throw new Error('No se pudo generar un código de categoría único');
}

// Create expense category.
//
// Admin only (issue #71): if anyone raising a solicitud could create
// categories, the catalog fills up with "Materiales" / "materiales" /
// "Mat." and every company-wide total splits across the near-duplicates.
router.post(
  '/categories',
  authenticateToken,
  requireAdmin,
  [
    body('nombre')
      .trim()
      .isLength({ min: 2 })
      .withMessage('Nombre debe tener al menos 2 caracteres'),
    body('codigo')
      .optional()
      .trim()
      .isLength({ min: 2, max: 10 })
      .withMessage('Código debe tener entre 2 y 10 caracteres'),
    body('color')
      .optional()
      .matches(/^#[0-9A-F]{6}$/i)
      .withMessage('Color debe ser un código hex válido'),
    body('orden')
      .optional()
      .isInt({ min: 0 })
      .withMessage('Orden debe ser un número positivo'),
  ],
  asyncHandler(
    async (
      req: Request<
        object,
        object,
        {
          nombre: string;
          descripcion?: string;
          codigo?: string;
          color?: string;
          orden?: number;
        }
      >,
      res: Response,
    ): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({
          success: false,
          message: 'Datos inválidos',
          errors: errors.array(),
        });
        return;
      }

      const { descripcion, color = '#64748B', orden } = req.body;
      const nombre = req.body.nombre.trim();

      // Same name already in the catalog? Never create a second row for it.
      const existente = await query<CategoryRow>(
        'SELECT * FROM categorias_gastos WHERE LOWER(nombre) = LOWER($1) LIMIT 1',
        [nombre],
      );

      if (existente.rows.length > 0) {
        const previa = existente.rows[0];
        if (previa.activo) {
          res.status(409).json({
            success: false,
            message: `Ya existe una categoría llamada "${previa.nombre}"`,
          });
          return;
        }
        // It existed and was retired — bring it back rather than duplicating it,
        // so any record still pointing at it keeps its classification.
        const reactivada = await query<CategoryRow>(
          `UPDATE categorias_gastos
              SET activo = true, updated_at = CURRENT_TIMESTAMP
            WHERE id = $1
        RETURNING *`,
          [previa.id],
        );
        res.status(200).json({
          success: true,
          message: 'Categoría reactivada',
          category: reactivada.rows[0],
        });
        return;
      }

      const codigo =
        req.body.codigo?.trim() || (await generarCodigoCategoria(nombre));

      const ordenFinal =
        orden ??
        (
          await query<{ siguiente: number }>(
            'SELECT COALESCE(MAX(orden), 0) + 1 AS siguiente FROM categorias_gastos',
          )
        ).rows[0].siguiente;

      const result = await query<CategoryRow>(
        `
    INSERT INTO categorias_gastos (nombre, descripcion, codigo, color, orden)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING *
  `,
        [nombre, descripcion, codigo, color, ordenFinal],
      );

      res.status(201).json({
        success: true,
        message: 'Categoría creada exitosamente',
        category: result.rows[0],
      });
    },
    {
      duplicateMessage: 'El código de categoría ya existe',
    },
  ),
);

// Get project categories
router.get(
  '/projects/:projectId/categories',
  authenticateToken,
  [param('projectId').isInt().withMessage('ID de proyecto inválido')],
  asyncHandler(
    async (
      req: Request<{ projectId: string }>,
      res: Response,
    ): Promise<void> => {
      const { projectId } = req.params;

      const hasCustomSettings = await query<{ count: string }>(
        `
    SELECT COUNT(*) as count FROM proyecto_categorias_gastos WHERE proyecto_id = $1
  `,
        [projectId],
      );

      if (parseInt(hasCustomSettings.rows[0].count) === 0) {
        await query(`SELECT initialize_project_categories($1)`, [projectId]);
      }

      const result = await query<ProjectCategoryRow>(
        `
    SELECT
      pec.id, pec.proyecto_id, pec.categoria_id,
      COALESCE(pec.nombre, ec.nombre) as nombre,
      COALESCE(pec.codigo, ec.codigo) as codigo,
      COALESCE(pec.color, ec.color) as color,
      pec.activo, pec.orden,
      CASE WHEN pec.categoria_id IS NOT NULL THEN false ELSE true END as is_custom
    FROM proyecto_categorias_gastos pec
    LEFT JOIN categorias_gastos ec ON pec.categoria_id = ec.id
    WHERE pec.proyecto_id = $1 AND pec.activo = true
    ORDER BY pec.orden, COALESCE(pec.nombre, ec.nombre)
  `,
        [projectId],
      );

      res.json({ success: true, categories: result.rows });
    },
  ),
);

// Get available categories to add
router.get(
  '/projects/:projectId/categories/available',
  authenticateToken,
  [param('projectId').isInt().withMessage('ID de proyecto inválido')],
  asyncHandler(
    async (
      req: Request<{ projectId: string }>,
      res: Response,
    ): Promise<void> => {
      const { projectId } = req.params;

      const result = await query<ProjectCategoryRow>(
        `
    SELECT pec.id, pec.categoria_id, ec.nombre, ec.codigo, ec.color
    FROM proyecto_categorias_gastos pec
    JOIN categorias_gastos ec ON pec.categoria_id = ec.id
    WHERE pec.proyecto_id = $1 AND pec.activo = false
    ORDER BY ec.orden, ec.nombre
  `,
        [projectId],
      );

      res.json({ success: true, availableCategories: result.rows });
    },
  ),
);

// Remove category from project
router.delete(
  '/projects/:projectId/categories/:categoryId',
  authenticateToken,
  requireManager,
  [
    param('projectId').isInt().withMessage('ID de proyecto inválido'),
    param('categoryId').isInt().withMessage('ID de categoría inválido'),
  ],
  asyncHandler(
    async (
      req: Request<{ projectId: string; categoryId: string }>,
      res: Response,
    ): Promise<void> => {
      const { projectId, categoryId } = req.params;

      const expenseCheck = await query<{ count: string }>(
        `
    SELECT COUNT(*) as count FROM proyecto_gastos
    WHERE proyecto_id = $1 AND categoria_id = (
      SELECT COALESCE(categoria_id, $2) FROM proyecto_categorias_gastos WHERE id = $2
    )
  `,
        [projectId, categoryId],
      );

      if (parseInt(expenseCheck.rows[0].count) > 0) {
        res.status(400).json({
          success: false,
          message: 'No se puede eliminar una categoría con gastos registrados',
        });
        return;
      }

      await query(
        `
    UPDATE proyecto_categorias_gastos SET activo = false, updated_at = CURRENT_TIMESTAMP
    WHERE id = $1 AND proyecto_id = $2
  `,
        [categoryId, projectId],
      );

      res.json({ success: true, message: 'Categoría removida exitosamente' });
    },
  ),
);

// Re-activate a removed category
router.post(
  '/projects/:projectId/categories/:categoryId/activate',
  authenticateToken,
  requireManager,
  [
    param('projectId').isInt().withMessage('ID de proyecto inválido'),
    param('categoryId').isInt().withMessage('ID de categoría inválido'),
  ],
  asyncHandler(
    async (
      req: Request<{ projectId: string; categoryId: string }>,
      res: Response,
    ): Promise<void> => {
      const { projectId, categoryId } = req.params;

      await query(
        `
    UPDATE proyecto_categorias_gastos SET activo = true, updated_at = CURRENT_TIMESTAMP
    WHERE id = $1 AND proyecto_id = $2
  `,
        [categoryId, projectId],
      );

      res.json({ success: true, message: 'Categoría reactivada exitosamente' });
    },
  ),
);

// Create custom category for project
router.post(
  '/projects/:projectId/categories',
  authenticateToken,
  requireManager,
  [
    param('projectId').isInt().withMessage('ID de proyecto inválido'),
    body('nombre')
      .trim()
      .isLength({ min: 2 })
      .withMessage('Nombre debe tener al menos 2 caracteres'),
    body('codigo')
      .trim()
      .isLength({ min: 2, max: 10 })
      .withMessage('Código debe tener entre 2 y 10 caracteres'),
    body('color')
      .optional()
      .matches(/^#[0-9A-F]{6}$/i)
      .withMessage('Color debe ser un código hex válido'),
  ],
  asyncHandler(
    async (
      req: Request<
        { projectId: string },
        object,
        { nombre: string; codigo: string; color?: string }
      >,
      res: Response,
    ): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({
          success: false,
          message: 'Datos inválidos',
          errors: errors.array(),
        });
        return;
      }

      const { projectId } = req.params;
      const { nombre, codigo, color = '#e74c3c' } = req.body;

      const maxOrder = await query<{ next_orden: number }>(
        `
    SELECT COALESCE(MAX(orden), 0) + 1 as next_orden FROM proyecto_categorias_gastos WHERE proyecto_id = $1
  `,
        [projectId],
      );

      const result = await query<ProjectCategoryRow>(
        `
    INSERT INTO proyecto_categorias_gastos (proyecto_id, categoria_id, nombre, codigo, color, activo, orden)
    VALUES ($1, NULL, $2, $3, $4, true, $5)
    RETURNING *
  `,
        [projectId, nombre, codigo, color, maxOrder.rows[0].next_orden],
      );

      res.status(201).json({
        success: true,
        message: 'Categoría creada exitosamente',
        category: { ...result.rows[0], is_custom: true },
      });
    },
    {
      duplicateMessage:
        'Ya existe una categoría con ese código en este proyecto',
    },
  ),
);

// Get project budget
router.get(
  '/projects/:projectId/budget',
  authenticateToken,
  [param('projectId').isInt().withMessage('ID de proyecto inválido')],
  asyncHandler(
    async (
      req: Request<{ projectId: string }>,
      res: Response,
    ): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({
          success: false,
          message: 'Parámetros inválidos',
          errors: errors.array(),
        });
        return;
      }

      const { projectId } = req.params;

      const budgetResult = await query<BudgetRow>(
        `
    SELECT pb.*, p.nombre as proyecto_nombre, p.monto_contrato_original
    FROM proyecto_presupuestos pb
    LEFT JOIN proyectos p ON pb.proyecto_id = p.id
    WHERE pb.proyecto_id = $1
  `,
        [projectId],
      );

      const categoriesResult = await query<BudgetCategoryRow>(
        `
    SELECT bc.*, pec.nombre as categoria_nombre, pec.codigo as categoria_codigo,
           pec.color as categoria_color, pec.id as proyecto_categoria_id
    FROM categorias_presupuesto bc
    JOIN proyecto_categorias_gastos pec ON bc.proyecto_categoria_id = pec.id
    WHERE bc.proyecto_id = $1 AND pec.activo = true
    ORDER BY pec.nombre
  `,
        [projectId],
      );

      const expensesResult = await query<ExpenseSummary>(
        `
    SELECT pe.categoria_id, ec.nombre as categoria_nombre, ec.codigo as categoria_codigo,
           SUM(pe.monto) as total_gastado, COUNT(pe.id) as total_gastos
    FROM proyecto_gastos pe
    JOIN categorias_gastos ec ON pe.categoria_id = ec.id
    WHERE pe.proyecto_id = $1 AND pe.tipo_gasto = 'real'
    GROUP BY pe.categoria_id, ec.nombre, ec.codigo, ec.orden
    ORDER BY ec.orden, ec.nombre
  `,
        [projectId],
      );

      const budget = budgetResult.rows[0] || null;
      const categories = categoriesResult.rows;
      const expenses = expensesResult.rows;

      const totalPresupuestado = categories.reduce(
        (sum, cat) => sum + parseFloat(String(cat.presupuesto_actual || 0)),
        0,
      );
      const totalGastado = expenses.reduce(
        (sum, exp) => sum + parseFloat(exp.total_gastado || '0'),
        0,
      );

      res.json({
        success: true,
        budget: {
          ...budget,
          total_presupuestado: totalPresupuestado,
          total_gastado: totalGastado,
          saldo_disponible: totalPresupuestado - totalGastado,
          porcentaje_usado:
            totalPresupuestado > 0
              ? (totalGastado / totalPresupuestado) * 100
              : 0,
        },
        categories,
        expenses,
      });
    },
    {
      tableNotExistsDefault: {
        budget: {
          total_presupuestado: 0,
          total_gastado: 0,
          saldo_disponible: 0,
          porcentaje_usado: 0,
        },
        categories: [],
        expenses: [],
      },
    },
  ),
);

// Create/Update project budget
router.post(
  '/projects/:projectId/budget',
  authenticateToken,
  requireManager,
  [
    param('projectId').isInt().withMessage('ID de proyecto inválido'),
    body('categories').isArray().withMessage('Categorías debe ser un array'),
    body('categories.*.proyecto_categoria_id')
      .isInt()
      .withMessage('ID de categoría inválido'),
    body('categories.*.presupuesto_inicial')
      .isNumeric()
      .withMessage('Presupuesto inicial debe ser un número'),
    body('categories.*.presupuesto_actual')
      .isNumeric()
      .withMessage('Presupuesto actual debe ser un número'),
  ],
  asyncHandler(
    async (
      req: Request<
        { projectId: string },
        object,
        {
          notas?: string;
          categories: Array<{
            proyecto_categoria_id: number;
            presupuesto_inicial: number;
            presupuesto_actual: number;
          }>;
        }
      >,
      res: Response,
    ): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({
          success: false,
          message: 'Datos inválidos',
          errors: errors.array(),
        });
        return;
      }

      const { projectId } = req.params;
      const { notas, categories = [] } = req.body;

      await query('BEGIN');

      // Try-catch interno preservado para ROLLBACK de transacción
      try {
        await query(
          `
      UPDATE proyectos SET tiene_presupuesto = true, updated_at = CURRENT_TIMESTAMP WHERE id = $1
    `,
          [projectId],
        );

        await query(
          `
      INSERT INTO proyecto_presupuestos (proyecto_id, moneda, notas, creado_por, actualizado_por)
      VALUES ($1, $2, $3, $4, $4)
      ON CONFLICT (proyecto_id)
      DO UPDATE SET notas = $3, updated_at = CURRENT_TIMESTAMP, actualizado_por = $4
      RETURNING id
    `,
          [projectId, 'PAB', notas || '', req.user!.id],
        );

        await query(`DELETE FROM categorias_presupuesto WHERE proyecto_id = $1`, [
          projectId,
        ]);

        for (const category of categories) {
          await query(
            `
        INSERT INTO categorias_presupuesto (proyecto_id, proyecto_categoria_id, presupuesto_inicial, presupuesto_actual)
        VALUES ($1, $2, $3, $4)
      `,
            [
              projectId,
              category.proyecto_categoria_id,
              category.presupuesto_inicial,
              category.presupuesto_actual,
            ],
          );
        }

        await query('COMMIT');

        res.json({
          success: true,
          message: 'Presupuesto actualizado exitosamente',
        });
      } catch (err) {
        await query('ROLLBACK');
        throw err;
      }
    },
  ),
);

// Get project expenses
router.get(
  '/projects/:projectId/expenses',
  authenticateToken,
  [param('projectId').isInt().withMessage('ID de proyecto inválido')],
  asyncHandler(
    async (
      req: Request<{ projectId: string }, object, object, QueryParams>,
      res: Response,
    ): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({
          success: false,
          message: 'Parámetros inválidos',
          errors: errors.array(),
        });
        return;
      }

      const { projectId } = req.params;
      const {
        page = '1',
        limit = '20',
        categoria,
        fecha_desde,
        fecha_hasta,
        tipo_gasto,
        period,
      } = req.query;
      const offset = (parseInt(page) - 1) * parseInt(limit);

      let whereClause = 'WHERE pe.proyecto_id = $1';
      const queryParams: unknown[] = [projectId];
      let paramCounter = 2;

      if (categoria) {
        whereClause += ` AND pe.categoria_id = $${paramCounter}`;
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

      const result = await query<ExpenseRow>(
        `
    SELECT pe.*,
           COALESCE(pec.nombre, ec.nombre) as categoria_nombre,
           COALESCE(pec.codigo, ec.codigo) as categoria_codigo,
           COALESCE(pec.color, ec.color) as categoria_color,
           u.nombre as creado_por_nombre
    FROM proyecto_gastos pe
    LEFT JOIN proyecto_categorias_gastos pec ON pe.proyecto_categoria_id = pec.id
    LEFT JOIN categorias_gastos ec ON COALESCE(pec.categoria_id, pe.categoria_id) = ec.id
    LEFT JOIN users u ON pe.creado_por = u.id
    ${whereClause}
    ORDER BY pe.fecha DESC, pe.created_at DESC
    LIMIT $${paramCounter} OFFSET $${paramCounter + 1}
  `,
        [...queryParams, limit, offset],
      );

      const countResult = await query<{ total: string }>(
        `
    SELECT COUNT(*) as total FROM proyecto_gastos pe ${whereClause}
  `,
        queryParams,
      );

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
          hasPrev: parseInt(page) > 1,
        },
      });
    },
    {
      tableNotExistsDefault: {
        expenses: [],
        pagination: {
          page: 1,
          limit: 20,
          total: 0,
          totalPages: 0,
          hasNext: false,
          hasPrev: false,
        },
      },
    },
  ),
);

// Create project expense
router.post(
  '/projects/:projectId/expenses',
  authenticateToken,
  [
    param('projectId').isInt().withMessage('ID de proyecto inválido'),
    body('proyecto_categoria_id').isInt().withMessage('Categoría es requerida'),
    body('fecha').isDate().withMessage('Fecha inválida'),
    body('concepto')
      .trim()
      .isLength({ min: 3 })
      .withMessage('Concepto debe tener al menos 3 caracteres'),
    body('monto')
      .isDecimal({ decimal_digits: '0,2' })
      .withMessage('Monto debe ser un número válido'),
    body('tipo_gasto')
      .optional()
      .isIn(['real', 'compromiso', 'estimado'])
      .withMessage('Tipo de gasto inválido'),
  ],
  asyncHandler(
    async (
      req: Request<
        { projectId: string },
        object,
        {
          proyecto_categoria_id: number;
          fecha: string;
          concepto: string;
          descripcion?: string;
          monto: number;
          moneda?: string;
          tipo_gasto?: 'real' | 'compromiso' | 'estimado';
        }
      >,
      res: Response,
    ): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({
          success: false,
          message: 'Datos inválidos',
          errors: errors.array(),
        });
        return;
      }

      const { projectId } = req.params;
      const {
        proyecto_categoria_id,
        fecha,
        concepto,
        descripcion,
        monto,
        moneda = 'USD',
        tipo_gasto = 'real',
      } = req.body;

      // Look up the global categoria_id from proyecto_categorias_gastos for backward compatibility
      const categoryLookup = await query<{ categoria_id: number | null }>(
        `
    SELECT categoria_id FROM proyecto_categorias_gastos WHERE id = $1 AND proyecto_id = $2
  `,
        [proyecto_categoria_id, projectId],
      );

      if (categoryLookup.rows.length === 0) {
        res.status(400).json({
          success: false,
          message: 'Categoría no válida para este proyecto',
        });
        return;
      }

      const global_category_id = categoryLookup.rows[0].categoria_id;

      const result = await query<ExpenseRow>(
        `
    INSERT INTO proyecto_gastos (proyecto_id, proyecto_categoria_id, categoria_id, fecha, concepto, descripcion, monto, moneda, tipo_gasto, creado_por)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    RETURNING *
  `,
        [
          projectId,
          proyecto_categoria_id,
          global_category_id,
          fecha,
          concepto,
          descripcion,
          monto,
          moneda,
          tipo_gasto,
          req.user!.id,
        ],
      );

      res.status(201).json({
        success: true,
        message: 'Gasto registrado exitosamente',
        expense: result.rows[0],
      });
    },
  ),
);

// Delete project expense
router.delete(
  '/projects/:projectId/expenses/:expenseId',
  authenticateToken,
  [
    param('projectId').isInt().withMessage('ID de proyecto inválido'),
    param('expenseId').isInt().withMessage('ID de gasto inválido'),
  ],
  asyncHandler(
    async (
      req: Request<{ projectId: string; expenseId: string }>,
      res: Response,
    ): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({
          success: false,
          message: 'Datos inválidos',
          errors: errors.array(),
        });
        return;
      }

      const { projectId, expenseId } = req.params;

      const expense = await query<{ id: number }>(
        `
    SELECT id FROM proyecto_gastos WHERE id = $1 AND proyecto_id = $2
  `,
        [expenseId, projectId],
      );

      if (expense.rows.length === 0) {
        res
          .status(404)
          .json({ success: false, message: 'Gasto no encontrado' });
        return;
      }

      await query('DELETE FROM proyecto_gastos WHERE id = $1', [expenseId]);

      res.json({ success: true, message: 'Gasto eliminado exitosamente' });
    },
  ),
);

// Get project cost dashboard
router.get(
  '/projects/:projectId/dashboard',
  authenticateToken,
  [param('projectId').isInt().withMessage('ID de proyecto inválido')],
  asyncHandler(
    async (
      req: Request<{ projectId: string }>,
      res: Response,
    ): Promise<void> => {
      const { projectId } = req.params;

      const projectResult = await query<{
        id: number;
        nombre: string;
        monto_contrato_original?: number;
      }>(
        `
    SELECT id, nombre, monto_contrato_original FROM proyectos WHERE id = $1
  `,
        [projectId],
      );

      const project = projectResult.rows[0];
      if (!project) {
        res
          .status(404)
          .json({ success: false, message: 'Proyecto no encontrado' });
        return;
      }

      const budgetResult = await query<BudgetRow>(
        `
    SELECT pb.*, p.nombre as proyecto_nombre
    FROM proyecto_presupuestos pb JOIN proyectos p ON pb.proyecto_id = p.id
    WHERE pb.proyecto_id = $1
  `,
        [projectId],
      );

      const expensesByCategory = await query<{
        proyecto_categoria_id: number;
        nombre: string;
        codigo: string;
        color: string;
        presupuesto_actual: number;
        gastado: string;
        total_gastos: string;
      }>(
        `
    SELECT
      pec.id as proyecto_categoria_id,
      COALESCE(pec.nombre, ec.nombre) as nombre,
      COALESCE(pec.codigo, ec.codigo) as codigo,
      COALESCE(pec.color, ec.color) as color,
      COALESCE(bc.presupuesto_actual, 0) as presupuesto_actual,
      COALESCE(SUM(pe.monto), 0) as gastado,
      COUNT(pe.id) as total_gastos
    FROM proyecto_categorias_gastos pec
    LEFT JOIN categorias_gastos ec ON pec.categoria_id = ec.id
    LEFT JOIN categorias_presupuesto bc ON pec.id = bc.proyecto_categoria_id AND bc.proyecto_id = $1
    LEFT JOIN proyecto_gastos pe ON pec.categoria_id = pe.categoria_id AND pe.proyecto_id = $1 AND pe.tipo_gasto = 'real'
    WHERE pec.proyecto_id = $1 AND pec.activo = true
    GROUP BY pec.id, pec.nombre, pec.codigo, pec.color, ec.nombre, ec.codigo, ec.color, bc.presupuesto_actual
    ORDER BY COALESCE(pec.nombre, ec.nombre)
  `,
        [projectId],
      );

      const categoriesWithCalculations = expensesByCategory.rows.map((cat) => {
        const presupuesto = parseFloat(String(cat.presupuesto_actual)) || 0;
        const gastado = parseFloat(cat.gastado) || 0;
        return {
          ...cat,
          presupuesto_actual: presupuesto,
          gastado: gastado,
          disponible: presupuesto - gastado,
          porcentaje_usado: presupuesto > 0 ? (gastado / presupuesto) * 100 : 0,
        };
      });

      const recentExpenses = await query<ExpenseRow>(
        `
    SELECT pe.*, COALESCE(pec.nombre, ec.nombre) as categoria_nombre, COALESCE(pec.color, ec.color) as categoria_color
    FROM proyecto_gastos pe
    LEFT JOIN categorias_gastos ec ON pe.categoria_id = ec.id
    LEFT JOIN proyecto_categorias_gastos pec ON pec.categoria_id = pe.categoria_id AND pec.proyecto_id = pe.proyecto_id
    WHERE pe.proyecto_id = $1
    ORDER BY pe.created_at DESC
    LIMIT 10
  `,
        [projectId],
      );

      const monthlyTrend = await query<{ mes: Date; total_mes: string }>(
        `
    SELECT DATE_TRUNC('month', fecha) as mes, SUM(monto) as total_mes
    FROM proyecto_gastos
    WHERE proyecto_id = $1 AND tipo_gasto = 'real' AND fecha >= DATE_TRUNC('month', CURRENT_DATE - INTERVAL '11 months')
    GROUP BY DATE_TRUNC('month', fecha)
    ORDER BY mes
  `,
        [projectId],
      );

      const budget = budgetResult.rows[0] || null;
      const categories = categoriesWithCalculations;

      const totalPresupuestado = categories.reduce(
        (sum, cat) => sum + (cat.presupuesto_actual || 0),
        0,
      );
      const totalGastado = categories.reduce(
        (sum, cat) => sum + (cat.gastado || 0),
        0,
      );
      const montoContrato = parseFloat(
        String(project.monto_contrato_original || 0),
      );
      const presupuestoFinal =
        totalPresupuestado > 0 ? totalPresupuestado : montoContrato;

      res.json({
        success: true,
        dashboard: {
          project: {
            id: project.id,
            nombre: project.nombre,
            monto_contrato_original: montoContrato,
          },
          budget: {
            ...budget,
            presupuesto_aprobado: presupuestoFinal,
            monto_contrato_original: montoContrato,
            total_presupuestado: totalPresupuestado,
            total_gastado: totalGastado,
            saldo_disponible: presupuestoFinal - totalGastado,
            porcentaje_usado:
              presupuestoFinal > 0
                ? (totalGastado / presupuestoFinal) * 100
                : 0,
            tiene_presupuesto_configurado:
              budget !== null && totalPresupuestado > 0,
          },
          totalSpent: totalGastado,
          totalAvailable: presupuestoFinal - totalGastado,
          percentageUsed:
            presupuestoFinal > 0 ? (totalGastado / presupuestoFinal) * 100 : 0,
          categoryBreakdown: categories,
          recentExpenses: recentExpenses.rows,
          monthlyTrend: monthlyTrend.rows,
        },
      });
    },
    {
      tableNotExistsDefault: {
        dashboard: {
          budget: {
            total_presupuestado: 0,
            total_gastado: 0,
            saldo_disponible: 0,
            porcentaje_usado: 0,
          },
          totalSpent: 0,
          totalAvailable: 0,
          percentageUsed: 0,
          categoryBreakdown: [],
          recentExpenses: [],
          monthlyTrend: [],
        },
      },
    },
  ),
);

// ---------------------------------------------------------------------------
// Resumen de Control de Costos (pantalla nueva)
//
// Tres numeros arriba y dos cuadros abajo. De donde sale cada cosa:
//
//   contrato    -> proyectos.monto_total, lo que se va a cobrar.
//   presupuesto -> el presupuesto marcado con la estrella; lo que se calculo
//                  que iba a costar. null si el proyecto no tiene ninguno.
//   gastado     -> las solicitudes de pago ya pagadas. Las cajas menudas no se
//                  cuentan aparte: terminan pasando por solicitudes.
//
// Una solicitud cuenta como gastada en los estados 'pagada' y 'facturada'
// (facturada viene DESPUES de pagada). 'devolucion' es una plata que el
// proveedor devolvio entera, asi que no cuenta.
//
// La fecha del gasto es la del comprobante de pago; si no hay comprobante, la
// de la solicitud, que es lo mas cercano que existe.
// ---------------------------------------------------------------------------

interface ResumenCategoriaRow {
  id: number | null;
  codigo: string | null;
  nombre: string | null;
  color: string | null;
  monto: string;
  solicitudes: string;
}

interface ResumenSerieRow {
  fecha: string;
  monto: string;
}

/** Una linea de reparto de un pago. item/descripcion van en null cuando la fila
 *  ya no esta en el desglose: la partida se borro despues de asignarla. */
interface PartidaAsignadaWire {
  rowUid: string;
  item: string | null;
  descripcion: string | null;
  monto: number;
}

/** Una fila del cuadro de presupuestado contra gastado. presupuestado va en
 *  null cuando el presupuesto oficial no tiene esa partida (o no hay
 *  presupuesto); gastado es 0 mientras nadie le haya echado un pago. */
interface ComparativoFilaWire {
  rowUid: string;
  item: string;
  descripcion: string;
  presupuestado: number | null;
  gastado: number;
}

const numero = (v: string | null | undefined): number => (v != null ? parseFloat(v) : 0);

/** Solicitudes ya pagadas del proyecto, con su fecha de pago resuelta. */
const PAGADAS_CTE = `
  WITH pagadas AS (
    SELECT s.id,
           s.monto_total,
           s.categoria_id,
           COALESCE(MAX(c.fecha_pago), s.fecha) AS fecha_pago
      FROM solicitudes_pago s
      LEFT JOIN comprobantes_pago c ON c.solicitud_pago_id = s.id
     WHERE s.proyecto_id = $1
       AND s.activo = TRUE
       AND s.estado IN ('pagada', 'facturada')
     GROUP BY s.id
  )`;

router.get(
  '/projects/:projectId/resumen',
  authenticateToken,
  checkProjectAccess('projectId'),
  asyncHandler(async (req: Request<{ projectId: string }>, res: Response): Promise<void> => {
    const proyectoId = parseInt(req.params.projectId, 10);
    if (!Number.isInteger(proyectoId)) {
      res.status(400).json({ success: false, message: 'ID de proyecto inválido' });
      return;
    }

    const proyecto = await query<{
      id: number;
      monto_total: string | null;
      fecha_inicio: string | null;
      orden_proceder: string | null;
      fecha_fin_estimada: string | null;
    }>(
      `SELECT id, monto_total,
              to_char(fecha_inicio, 'YYYY-MM-DD')       AS fecha_inicio,
              to_char(orden_proceder, 'YYYY-MM-DD')     AS orden_proceder,
              to_char(fecha_fin_estimada, 'YYYY-MM-DD') AS fecha_fin_estimada
         FROM proyectos WHERE id = $1`,
      [proyectoId],
    );
    if (!proyecto.rows.length) {
      res.status(404).json({ success: false, message: 'Proyecto no encontrado' });
      return;
    }
    const p = proyecto.rows[0];

    // El presupuesto oficial. Un renglon que tiene hijos es contenedor: su
    // total sube desde abajo y sumarlo tambien seria contarlo dos veces.
    const presupuesto = await query<{ id: number; nombre: string; costo: string | null }>(
      `SELECT pr.id, pr.nombre, SUM(r.cantidad * r.costo_unitario) AS costo
         FROM presupuestos pr
         LEFT JOIN presupuesto_renglones r
                ON r.presupuesto_id = pr.id
               AND NOT EXISTS (SELECT 1 FROM presupuesto_renglones h WHERE h.parent_id = r.id)
        WHERE pr.proyecto_id = $1 AND pr.activo = TRUE AND pr.es_principal = TRUE
        GROUP BY pr.id, pr.nombre`,
      [proyectoId],
    );

    const [porCategoria, serie, solicitudes, partidas, comparativo, sinPartida] = await Promise.all([
      query<ResumenCategoriaRow>(
        `${PAGADAS_CTE}
         SELECT c.id, c.codigo, c.nombre, c.color,
                SUM(pg.monto_total)::text AS monto,
                COUNT(*)::text            AS solicitudes
           FROM pagadas pg
           LEFT JOIN categorias_gastos c ON c.id = pg.categoria_id
          GROUP BY c.id, c.codigo, c.nombre, c.color, c.orden
          ORDER BY c.orden NULLS LAST, c.nombre NULLS LAST`,
        [proyectoId],
      ),
      query<ResumenSerieRow>(
        `${PAGADAS_CTE}
         SELECT to_char(fecha_pago, 'YYYY-MM-DD') AS fecha,
                SUM(monto_total)::text            AS monto
           FROM pagadas
          GROUP BY fecha_pago
          ORDER BY fecha_pago`,
        [proyectoId],
      ),
      // Las solicitudes que hay detras de cada categoria: la fila del reparto
      // se pincha y se abre, asi que viajan de una vez. Son pocas —solo las ya
      // pagadas de un proyecto— y ahorran una segunda espera al abrir.
      query<{
        id: number; numero: string | null; fecha: string; proveedor: string | null;
        monto: string; categoria_id: number | null;
      }>(
        `${PAGADAS_CTE}
         SELECT pg.id, s.numero, to_char(pg.fecha_pago, 'YYYY-MM-DD') AS fecha,
                s.proveedor, pg.monto_total::text AS monto, pg.categoria_id
           FROM pagadas pg
           JOIN solicitudes_pago s ON s.id = pg.id
          ORDER BY pg.fecha_pago DESC, pg.id DESC`,
        [proyectoId],
      ),
      // A que partida del desglose va cada pago. LEFT JOIN a proposito: si la
      // fila desaparecio del desglose, la linea sigue aqui con el nombre vacio
      // y la pantalla la trata como pendiente de volver a asignar.
      query<{
        solicitud_pago_id: number; row_uid: string; monto: string;
        item: string | null; descripcion: string | null;
      }>(
        `${PAGADAS_CTE}
         SELECT sp.solicitud_pago_id, sp.row_uid, sp.monto::text AS monto,
                i.item, i.descripcion
           FROM pagadas pg
           JOIN solicitud_pago_partidas sp ON sp.solicitud_pago_id = pg.id
           LEFT JOIN desglose_items i
                  ON i.desglose_id = sp.desglose_id AND i.row_uid = sp.row_uid
          ORDER BY sp.id`,
        [proyectoId],
      ),
      // Presupuestado contra gastado, partida por partida. El puente entre los
      // dos lados es row_uid: el presupuesto guarda de que fila del desglose
      // nacio cada renglon, y el gasto se asigna a esa misma fila.
      //
      // Van TODAS las partidas del desglose, tengan gasto o no: el cuadro es el
      // presupuesto entero, y una partida sin tocar tambien es informacion.
      query<{
        row_uid: string; item: string; descripcion: string;
        presupuestado: string | null; gastado: string | null;
      }>(
        `WITH oficial AS (
           SELECT id FROM desgloses
            WHERE proyecto_id = $1 AND tipo = 'oficial' AND activo = TRUE
            ORDER BY id LIMIT 1
         ),
         presu AS (
           SELECT r.desglose_row_uid AS row_uid,
                  SUM(r.cantidad * r.costo_unitario) AS presupuestado
             FROM presupuestos p
             JOIN presupuesto_renglones r ON r.presupuesto_id = p.id
            WHERE p.proyecto_id = $1 AND p.activo = TRUE AND p.es_principal = TRUE
              AND NOT EXISTS (SELECT 1 FROM presupuesto_renglones h WHERE h.parent_id = r.id)
            GROUP BY r.desglose_row_uid
         ),
         gasto AS (
           SELECT sp.row_uid, SUM(sp.monto) AS gastado
             FROM solicitud_pago_partidas sp
             JOIN solicitudes_pago s ON s.id = sp.solicitud_pago_id
            WHERE s.proyecto_id = $1 AND s.activo = TRUE
              AND s.estado IN ('pagada', 'facturada')
            GROUP BY sp.row_uid
         )
         SELECT i.row_uid, i.item, i.descripcion,
                pr.presupuestado::text AS presupuestado,
                g.gastado::text        AS gastado
           FROM desglose_items i
           JOIN oficial o ON o.id = i.desglose_id
           LEFT JOIN presu pr ON pr.row_uid = i.row_uid
           LEFT JOIN gasto g  ON g.row_uid  = i.row_uid
          WHERE NOT EXISTS (SELECT 1 FROM desglose_items h WHERE h.parent_id = i.id)
          ORDER BY i.orden`,
        [proyectoId],
      ),
      // Cuantos pagos no caen en ninguna fila viva del cuadro: los que no tienen
      // reparto, y los que lo tienen contra una partida ya borrada.
      query<{ pagos: string }>(
        `${PAGADAS_CTE}
         SELECT COUNT(*)::text AS pagos
           FROM pagadas pg
          WHERE NOT EXISTS (
            SELECT 1 FROM solicitud_pago_partidas sp
              JOIN desglose_items i
                ON i.desglose_id = sp.desglose_id AND i.row_uid = sp.row_uid
             WHERE sp.solicitud_pago_id = pg.id
          )`,
        [proyectoId],
      ),
    ]);

    const partidasPorPago = new Map<number, PartidaAsignadaWire[]>();
    for (const p of partidas.rows) {
      const lista = partidasPorPago.get(p.solicitud_pago_id) ?? [];
      lista.push({
        rowUid: p.row_uid,
        item: p.item,
        descripcion: p.descripcion,
        monto: numero(p.monto),
      });
      partidasPorPago.set(p.solicitud_pago_id, lista);
    }

    // Lo sin clasificar sale aparte: en la pantalla es un aviso, no una fila
    // mas del reparto, porque no es una categoria sino un pendiente.
    const sinCat = porCategoria.rows.find((c) => c.id == null);
    const categorias = porCategoria.rows
      .filter((c) => c.id != null)
      .map((c) => ({
        id: c.id as number,
        codigo: c.codigo as string,
        nombre: c.nombre as string,
        color: c.color as string,
        monto: numero(c.monto),
        solicitudes: parseInt(c.solicitudes, 10),
      }));

    const gastado = categorias.reduce((s, c) => s + c.monto, 0) + numero(sinCat?.monto);

    const filasComparativo: ComparativoFilaWire[] = comparativo.rows.map((f) => ({
      rowUid: f.row_uid,
      item: f.item,
      descripcion: f.descripcion,
      presupuestado: f.presupuestado != null ? numero(f.presupuestado) : null,
      gastado: numero(f.gastado),
    }));

    // Lo que el cuadro no puede colocar sale por diferencia, no por una suma
    // aparte: asi el cuadro siempre cierra con el gastado total, incluso si un
    // pago quedo asignado a una partida que despues se borro del desglose.
    const enPartidas = filasComparativo.reduce((s, f) => s + f.gastado, 0);
    const montoSinPartida = Math.round((gastado - enPartidas) * 100) / 100;

    res.json({
      success: true,
      data: {
        contrato: p.monto_total != null ? numero(p.monto_total) : null,
        presupuesto: presupuesto.rows.length
          ? {
              id: presupuesto.rows[0].id,
              nombre: presupuesto.rows[0].nombre,
              costo: numero(presupuesto.rows[0].costo),
            }
          : null,
        gastado,
        categorias,
        sinClasificar: {
          monto: numero(sinCat?.monto),
          solicitudes: sinCat ? parseInt(sinCat.solicitudes, 10) : 0,
        },
        serie: serie.rows.map((s) => ({ fecha: s.fecha, monto: numero(s.monto) })),
        solicitudes: solicitudes.rows.map((s) => ({
          id: s.id,
          numero: s.numero,
          fecha: s.fecha,
          proveedor: s.proveedor,
          monto: numero(s.monto),
          categoriaId: s.categoria_id,
          partidas: partidasPorPago.get(s.id) ?? [],
        })),
        comparativo: {
          filas: filasComparativo,
          sinPartida: {
            monto: montoSinPartida,
            pagos: parseInt(sinPartida.rows[0]?.pagos ?? '0', 10),
          },
        },
        fechas: {
          // La obra arranca con la orden de proceder; si no la hay, con la
          // fecha de inicio del proyecto.
          inicio: p.orden_proceder ?? p.fecha_inicio,
          fin: p.fecha_fin_estimada,
        },
      },
    });
  }),
);

// ---------------------------------------------------------------------------
// A que partida del desglose va cada pago
//
// El ancla es (desglose_id, row_uid) del desglose OFICIAL del proyecto, no el
// presupuesto: los presupuestos van y vienen —y la estrella se puede mover a
// mitad de obra— mientras que el desglose es la lista de partidas del contrato.
// Asi, cambiar de presupuesto no descoloca el gasto ya clasificado.
//
// Solo se ofrecen las filas SIN HIJOS. Una fila con hijos es un contenedor: su
// total sube desde abajo, y meterle gasto propio seria contarlo dos veces
// (misma regla que el presupuesto y el desglose).
// ---------------------------------------------------------------------------

interface PartidaWire {
  rowUid: string;
  item: string;
  descripcion: string;
  /** Lo que el presupuesto oficial le puso a esta partida. Es el peso con el
   *  que se reparte un gasto general: una partida que es el 20% del
   *  presupuesto carga el 20% del extintor. null = sin costo escrito, y
   *  entonces no entra en el reparto porque no hay con que calcular su parte. */
  presupuestado: number | null;
  /** El grupo del que cuelga, para poder repartir solo dentro de una seccion.
   *  null en las partidas que van sueltas en la raiz. */
  seccionUid: string | null;
}

interface SeccionWire {
  rowUid: string;
  item: string;
  descripcion: string;
  partidas: number;
}

/** El desglose oficial del proyecto, sus filas costeables y las secciones que
 *  las agrupan. null si el proyecto no tiene desglose. */
async function partidasDelProyecto(
  proyectoId: number,
): Promise<{ desgloseId: number; partidas: PartidaWire[]; secciones: SeccionWire[] } | null> {
  const d = await query<{ id: number }>(
    `SELECT id FROM desgloses
      WHERE proyecto_id = $1 AND tipo = 'oficial' AND activo = TRUE
      ORDER BY id LIMIT 1`,
    [proyectoId],
  );
  if (!d.rows.length) return null;
  const desgloseId = d.rows[0].id;

  const filas = await query<{
    row_uid: string; item: string; descripcion: string; presupuestado: string | null;
    seccion_uid: string | null; seccion_item: string | null; seccion_desc: string | null;
  }>(
    `WITH presu AS (
       SELECT r.desglose_row_uid AS row_uid,
              SUM(r.cantidad * r.costo_unitario) AS presupuestado
         FROM presupuestos p
         JOIN presupuesto_renglones r ON r.presupuesto_id = p.id
        WHERE p.proyecto_id = $2 AND p.activo = TRUE AND p.es_principal = TRUE
          AND NOT EXISTS (SELECT 1 FROM presupuesto_renglones h WHERE h.parent_id = r.id)
        GROUP BY r.desglose_row_uid
     )
     SELECT i.row_uid, i.item, i.descripcion,
            pr.presupuestado::text AS presupuestado,
            g.row_uid    AS seccion_uid,
            g.item       AS seccion_item,
            g.descripcion AS seccion_desc
       FROM desglose_items i
       LEFT JOIN desglose_items g ON g.id = i.parent_id
       LEFT JOIN presu pr ON pr.row_uid = i.row_uid
      WHERE i.desglose_id = $1
        AND NOT EXISTS (SELECT 1 FROM desglose_items h WHERE h.parent_id = i.id)
      ORDER BY i.orden`,
    [desgloseId, proyectoId],
  );

  const secciones: SeccionWire[] = [];
  for (const f of filas.rows) {
    if (f.seccion_uid == null) continue;
    const ya = secciones.find((s) => s.rowUid === f.seccion_uid);
    if (ya) ya.partidas++;
    else {
      secciones.push({
        rowUid: f.seccion_uid,
        item: f.seccion_item ?? '',
        descripcion: f.seccion_desc ?? '',
        partidas: 1,
      });
    }
  }

  return {
    desgloseId,
    partidas: filas.rows.map((f) => ({
      rowUid: f.row_uid,
      item: f.item,
      descripcion: f.descripcion,
      presupuestado: f.presupuestado != null ? numero(f.presupuestado) : null,
      seccionUid: f.seccion_uid,
    })),
    secciones,
  };
}

// GET /costs/projects/:projectId/partidas — las partidas que se pueden escoger
router.get(
  '/projects/:projectId/partidas',
  authenticateToken,
  checkProjectAccess('projectId'),
  asyncHandler(async (req: Request<{ projectId: string }>, res: Response): Promise<void> => {
    const proyectoId = parseInt(req.params.projectId, 10);
    if (!Number.isInteger(proyectoId)) {
      res.status(400).json({ success: false, message: 'ID de proyecto inválido' });
      return;
    }
    const data = await partidasDelProyecto(proyectoId);
    res.json({ success: true, data: data ?? { desgloseId: null, partidas: [], secciones: [] } });
  }),
);

/** Los centavos, en entero: comparar sumas de decimales en coma flotante deja
 *  repartos que "no cuadran" por 0.0000001. */
const centavos = (n: number): number => Math.round(n * 100);

// PUT /costs/projects/:projectId/pagos/:solicitudId/partidas — guardar el reparto
router.put(
  '/projects/:projectId/pagos/:solicitudId/partidas',
  authenticateToken,
  requireManager,
  checkProjectAccess('projectId'),
  asyncHandler(async (
    req: Request<{ projectId: string; solicitudId: string }>,
    res: Response,
  ): Promise<void> => {
    const proyectoId = parseInt(req.params.projectId, 10);
    const solicitudId = parseInt(req.params.solicitudId, 10);
    if (!Number.isInteger(proyectoId) || !Number.isInteger(solicitudId)) {
      res.status(400).json({ success: false, message: 'ID inválido' });
      return;
    }
    const user = req.user;
    if (!user) {
      res.status(401).json({ success: false, message: 'Token inválido' });
      return;
    }

    const body = req.body as { partidas?: { rowUid?: unknown; monto?: unknown }[] };
    if (!Array.isArray(body.partidas)) {
      res.status(400).json({ success: false, message: 'Falta el reparto' });
      return;
    }

    // El pago tiene que ser de este proyecto y estar ya pagado: el control de
    // costos solo cuenta esos, y clasificar uno que aun no se paga daria un
    // gasto que todavia no existe.
    const sol = await query<{ monto_total: string; numero: string | null }>(
      `SELECT monto_total, numero FROM solicitudes_pago
        WHERE id = $1 AND proyecto_id = $2 AND activo = TRUE
          AND estado IN ('pagada', 'facturada')`,
      [solicitudId, proyectoId],
    );
    if (!sol.rows.length) {
      res.status(404).json({ success: false, message: 'Pago no encontrado en este proyecto' });
      return;
    }

    const disponible = await partidasDelProyecto(proyectoId);
    if (!disponible) {
      res.status(400).json({
        success: false,
        message: 'Este proyecto todavía no tiene desglose, así que no hay partidas que asignar',
      });
      return;
    }

    const validas = new Set(disponible.partidas.map((p) => p.rowUid));
    const lineas: { rowUid: string; monto: number }[] = [];
    for (const l of body.partidas) {
      const rowUid = typeof l.rowUid === 'string' ? l.rowUid : '';
      const monto = typeof l.monto === 'number' ? l.monto : NaN;
      if (!validas.has(rowUid)) {
        res.status(400).json({ success: false, message: 'Esa partida no está en el desglose del proyecto' });
        return;
      }
      if (!Number.isFinite(monto) || centavos(monto) <= 0) {
        res.status(400).json({ success: false, message: 'Cada partida necesita un monto mayor que cero' });
        return;
      }
      if (lineas.some((x) => x.rowUid === rowUid)) {
        res.status(400).json({ success: false, message: 'Esa partida está repetida en el reparto' });
        return;
      }
      lineas.push({ rowUid, monto });
    }

    // Lista vacia = dejarlo sin clasificar, y eso si vale. Con lineas, la suma
    // tiene que dar el monto del pago: un reparto a medias haria que el gasto
    // por partida no cuadrase con el total gastado.
    const totalPago = centavos(parseFloat(sol.rows[0].monto_total));
    const sumaLineas = lineas.reduce((s, l) => s + centavos(l.monto), 0);
    if (lineas.length > 0 && sumaLineas !== totalPago) {
      res.status(400).json({
        success: false,
        message: 'El reparto tiene que sumar exactamente el monto del pago',
      });
      return;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM solicitud_pago_partidas WHERE solicitud_pago_id = $1', [solicitudId]);
      for (const l of lineas) {
        await client.query(
          `INSERT INTO solicitud_pago_partidas
             (solicitud_pago_id, desglose_id, row_uid, monto, creado_por)
           VALUES ($1, $2, $3, $4, $5)`,
          [solicitudId, disponible.desgloseId, l.rowUid, l.monto, user.id],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    try {
      await registrarAudit(user.id, 'editar', 'solicitud_pago', solicitudId, {
        accion: 'asignar_partidas',
        proyecto_id: proyectoId,
        desglose_id: disponible.desgloseId,
        partidas: lineas.length,
      });
    } catch (auditErr) {
      console.error('Error registrando audit de partidas del pago:', auditErr);
    }

    const guardadas = await query<{
      row_uid: string; monto: string; item: string | null; descripcion: string | null;
    }>(
      `SELECT sp.row_uid, sp.monto::text AS monto, i.item, i.descripcion
         FROM solicitud_pago_partidas sp
         LEFT JOIN desglose_items i
                ON i.desglose_id = sp.desglose_id AND i.row_uid = sp.row_uid
        WHERE sp.solicitud_pago_id = $1
        ORDER BY sp.id`,
      [solicitudId],
    );

    res.json({
      success: true,
      data: guardadas.rows.map((g) => ({
        rowUid: g.row_uid,
        item: g.item,
        descripcion: g.descripcion,
        monto: numero(g.monto),
      })),
    });
  }),
);

export default router;
