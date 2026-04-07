import { Router, Request, Response } from 'express';
import { body, validationResult, param } from 'express-validator';
import { query } from '../database/config.js';
import { authenticateToken, checkPermission } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { registrarAudit } from '../services/auditLog.js';

const router = Router();

type EquipoOwner = 'Pinellas' | 'COCP';

interface EquipoRow {
  id: number;
  codigo?: string;
  descripcion: string;
  marca: string;
  modelo: string;
  ano: number;
  motor?: string;
  chasis?: string;
  costo?: number;
  valor_actual?: number;
  rata_mes?: number;
  proyecto?: string;
  ubicacion?: string;
  responsable?: string;
  estado?: string;
  observaciones?: string;
  observaciones_status?: string;
  owner: EquipoOwner;
  activo: boolean;
  ultima_revision?: Date;
  created_at: Date;
  updated_at: Date;
}

interface CreateEquipoBody {
  codigo?: string;
  descripcion: string;
  marca: string;
  modelo: string;
  ano: number;
  motor?: string;
  chasis?: string;
  costo?: string | number;
  valor_actual?: string | number;
  rata_mes?: string | number;
  proyecto?: string;
  responsable?: string;
  estado?: string;
  observaciones?: string;
  owner: EquipoOwner;
}

interface UpdateStatusBody {
  estado?: string;
  proyecto?: string;
  responsable?: string;
  rata_mes?: string | number;
  observaciones_status?: string;
}

interface QueryParams {
  owner?: string;
  search?: string;
  estado?: string;
}

// Obtener status de equipos
router.get(
  '/status',
  authenticateToken,
  checkPermission('equipos_ver'),
  asyncHandler(async (_req: Request, res: Response): Promise<void> => {
    const result = await query<EquipoRow>(`
    SELECT id, codigo, descripcion, marca, modelo, ano, estado, owner,
           proyecto as ubicacion, updated_at as ultima_revision
    FROM equipos
    WHERE activo = true
    ORDER BY
      CASE WHEN owner = 'Pinellas' THEN 0 ELSE 1 END,
      descripcion ASC
  `);

    const equiposConEstado = result.rows.map((equipo) => ({
      ...equipo,
      estado: equipo.estado || 'operativo',
      ubicacion: equipo.ubicacion || 'No especificada',
    }));

    res.json({
      success: true,
      data: equiposConEstado,
      total: equiposConEstado.length,
    });
  }),
);

// Obtener todos los equipos
router.get(
  '/',
  authenticateToken,
  checkPermission('equipos_ver'),
  asyncHandler(
    async (
      req: Request<object, object, object, QueryParams>,
      res: Response,
    ): Promise<void> => {
      const { owner, search, estado } = req.query;

      let whereClause = 'WHERE activo = true';
      const queryParams: unknown[] = [];
      let paramCounter = 1;

      if (owner) {
        whereClause += ` AND owner = $${paramCounter}`;
        queryParams.push(owner);
        paramCounter++;
      }

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

      if (estado) {
        whereClause += ` AND estado = $${paramCounter}`;
        queryParams.push(estado);
        paramCounter++;
      }

      const result = await query<EquipoRow>(
        `
    SELECT id, codigo, descripcion, marca, modelo, ano, motor, chasis, costo,
           valor_actual, rata_mes, proyecto, responsable, estado, observaciones,
           owner, created_at, updated_at
    FROM equipos
    ${whereClause}
    ORDER BY
      CASE WHEN owner = 'Pinellas' THEN 0 ELSE 1 END,
      descripcion ASC
  `,
        queryParams,
      );

      res.json({
        success: true,
        data: result.rows,
        total: result.rows.length,
      });
    },
  ),
);

// Obtener un equipo por ID
router.get(
  '/:id',
  authenticateToken,
  checkPermission('equipos_ver'),
  [param('id').isInt().withMessage('ID debe ser un número entero')],
  asyncHandler(
    async (req: Request<{ id: string }>, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({
          success: false,
          message: 'Datos de entrada inválidos',
          errors: errors.array(),
        });
        return;
      }

      const { id } = req.params;

      const result = await query<EquipoRow>(
        `
    SELECT id, codigo, descripcion, marca, modelo, ano, motor, chasis, costo,
           valor_actual, rata_mes, proyecto, responsable, estado, observaciones,
           owner, created_at, updated_at
    FROM equipos
    WHERE id = $1 AND activo = true
  `,
        [id],
      );

      if (result.rows.length === 0) {
        res
          .status(404)
          .json({ success: false, message: 'Equipo no encontrado' });
        return;
      }

      res.json({ success: true, data: result.rows[0] });
    },
  ),
);

// Crear nuevo equipo
router.post(
  '/',
  authenticateToken,
  checkPermission('equipos_agregar'),
  [
    body('descripcion')
      .trim()
      .notEmpty()
      .withMessage('Descripción es requerida'),
    body('marca').trim().notEmpty().withMessage('Marca es requerida'),
    body('modelo').trim().notEmpty().withMessage('Modelo es requerido'),
    body('ano')
      .isInt({ min: 1900, max: 2030 })
      .withMessage('Año debe ser un número válido entre 1900 y 2030'),
    body('owner')
      .isIn(['Pinellas', 'COCP'])
      .withMessage('Owner debe ser Pinellas o COCP'),
    body('costo').optional({ nullable: true, checkFalsy: true }).isDecimal(),
    body('valor_actual')
      .optional({ nullable: true, checkFalsy: true })
      .isDecimal(),
    body('rata_mes').optional({ nullable: true, checkFalsy: true }).isDecimal(),
  ],
  asyncHandler(
    async (
      req: Request<object, object, CreateEquipoBody>,
      res: Response,
    ): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({
          success: false,
          message: 'Datos de entrada inválidos',
          errors: errors.array(),
        });
        return;
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
        owner,
      } = req.body;

      const result = await query<{ id: number }>(
        `
    INSERT INTO equipos (
      codigo, descripcion, marca, modelo, ano, motor, chasis,
      costo, valor_actual, rata_mes, proyecto, responsable,
      estado, observaciones, owner
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
    RETURNING id
  `,
        [
          codigo || null,
          descripcion,
          marca,
          modelo,
          ano,
          motor || null,
          chasis || null,
          costo ? parseFloat(String(costo)) : null,
          valor_actual ? parseFloat(String(valor_actual)) : null,
          rata_mes ? parseFloat(String(rata_mes)) : null,
          proyecto || null,
          responsable || null,
          estado || null,
          observaciones || null,
          owner,
        ],
      );

      await registrarAudit(req.user!.id, 'crear', 'equipo', result.rows[0].id, {
        descripcion,
        marca,
        modelo,
        owner,
      });

      res.status(201).json({
        success: true,
        message: 'Equipo creado exitosamente',
        data: { id: result.rows[0].id },
      });
    },
  ),
);

// Actualizar equipo
router.put(
  '/:id',
  authenticateToken,
  checkPermission('equipos_editar'),
  [
    param('id').isInt().withMessage('ID debe ser un número entero'),
    body('descripcion')
      .trim()
      .notEmpty()
      .withMessage('Descripción es requerida'),
    body('marca').trim().notEmpty().withMessage('Marca es requerida'),
    body('modelo').trim().notEmpty().withMessage('Modelo es requerido'),
    body('ano')
      .isInt({ min: 1900, max: 2030 })
      .withMessage('Año debe ser un número válido entre 1900 y 2030'),
    body('owner')
      .isIn(['Pinellas', 'COCP'])
      .withMessage('Owner debe ser Pinellas o COCP'),
  ],
  asyncHandler(
    async (
      req: Request<{ id: string }, object, CreateEquipoBody>,
      res: Response,
    ): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({
          success: false,
          message: 'Datos de entrada inválidos',
          errors: errors.array(),
        });
        return;
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
        owner,
      } = req.body;

      const existsResult = await query<{ id: number }>(
        'SELECT id FROM equipos WHERE id = $1 AND activo = true',
        [id],
      );
      if (existsResult.rows.length === 0) {
        res
          .status(404)
          .json({ success: false, message: 'Equipo no encontrado' });
        return;
      }

      await query(
        `
    UPDATE equipos SET
      codigo = $1, descripcion = $2, marca = $3, modelo = $4, ano = $5, motor = $6, chasis = $7,
      costo = $8, valor_actual = $9, rata_mes = $10, proyecto = $11, responsable = $12,
      estado = $13, observaciones = $14, owner = $15, updated_at = CURRENT_TIMESTAMP
    WHERE id = $16
  `,
        [
          codigo || null,
          descripcion,
          marca,
          modelo,
          ano,
          motor || null,
          chasis || null,
          costo ? parseFloat(String(costo)) : null,
          valor_actual ? parseFloat(String(valor_actual)) : null,
          rata_mes ? parseFloat(String(rata_mes)) : null,
          proyecto || null,
          responsable || null,
          estado || null,
          observaciones || null,
          owner,
          id,
        ],
      );

      await registrarAudit(req.user!.id, 'editar', 'equipo', parseInt(id), {
        descripcion,
        marca,
        modelo,
        owner,
      });

      res.json({ success: true, message: 'Equipo actualizado exitosamente' });
    },
  ),
);

// Actualizar status de equipo
router.put(
  '/:id/status',
  authenticateToken,
  checkPermission('equipos_editar'),
  [
    param('id').isInt().withMessage('ID debe ser un número entero'),
    body('rata_mes')
      .optional()
      .isDecimal()
      .withMessage('Rata mensual debe ser un número válido'),
  ],
  asyncHandler(
    async (
      req: Request<{ id: string }, object, UpdateStatusBody>,
      res: Response,
    ): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({
          success: false,
          message: 'Datos de entrada inválidos',
          errors: errors.array(),
        });
        return;
      }

      const { id } = req.params;
      const { estado, proyecto, responsable, rata_mes, observaciones_status } =
        req.body;

      const existsResult = await query<{ id: number }>(
        'SELECT id FROM equipos WHERE id = $1 AND activo = true',
        [id],
      );
      if (existsResult.rows.length === 0) {
        res
          .status(404)
          .json({ success: false, message: 'Equipo no encontrado' });
        return;
      }

      await query(
        `
    UPDATE equipos SET
      estado = $1, proyecto = $2, responsable = $3, rata_mes = $4,
      observaciones_status = $5, updated_at = CURRENT_TIMESTAMP
    WHERE id = $6
  `,
        [
          estado || null,
          proyecto || null,
          responsable || null,
          rata_mes ? parseFloat(String(rata_mes)) : null,
          observaciones_status || null,
          id,
        ],
      );

      await registrarAudit(
        req.user!.id,
        'editar_status',
        'equipo',
        parseInt(id),
        {
          estado,
          proyecto,
          responsable,
        },
      );

      res.json({
        success: true,
        message: 'Status del equipo actualizado exitosamente',
      });
    },
  ),
);

// Eliminar equipo (soft delete)
router.delete(
  '/:id',
  authenticateToken,
  checkPermission('equipos_eliminar'),
  [param('id').isInt().withMessage('ID debe ser un número entero')],
  asyncHandler(
    async (req: Request<{ id: string }>, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({
          success: false,
          message: 'Datos de entrada inválidos',
          errors: errors.array(),
        });
        return;
      }

      const { id } = req.params;

      const existsResult = await query<{ id: number }>(
        'SELECT id FROM equipos WHERE id = $1 AND activo = true',
        [id],
      );
      if (existsResult.rows.length === 0) {
        res
          .status(404)
          .json({ success: false, message: 'Equipo no encontrado' });
        return;
      }

      const equipoData = await query<{ descripcion: string; owner: string }>(
        'SELECT descripcion, owner FROM equipos WHERE id = $1',
        [id],
      );
      await query(
        'UPDATE equipos SET activo = false, updated_at = CURRENT_TIMESTAMP WHERE id = $1',
        [id],
      );

      await registrarAudit(req.user!.id, 'eliminar', 'equipo', parseInt(id), {
        descripcion: equipoData.rows[0]?.descripcion,
        owner: equipoData.rows[0]?.owner,
      });

      res.json({ success: true, message: 'Equipo eliminado exitosamente' });
    },
  ),
);

export default router;
