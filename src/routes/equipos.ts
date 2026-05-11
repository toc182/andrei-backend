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
  proyecto_id?: number;
  proyecto_nombre?: string;
  ubicacion?: string;
  responsable_id?: number;
  responsable_nombre?: string;
  estado?: string;
  observaciones?: string;
  observaciones_status?: string;
  propietario: EquipoOwner;
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
  proyecto_id?: number;
  responsable_id?: number;
  estado?: string;
  observaciones?: string;
  propietario: EquipoOwner;
}

interface UpdateStatusBody {
  estado?: string;
  proyecto_id?: number;
  responsable_id?: number;
  rata_mes?: string | number;
  observaciones_status?: string;
}

interface QueryParams {
  propietario?: string;
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
    SELECT e.id, e.codigo, e.descripcion, e.marca, e.modelo, e.ano, e.estado, e.propietario,
           p.nombre_corto as ubicacion, e.updated_at as ultima_revision
    FROM equipos e
    LEFT JOIN proyectos p ON p.id = e.proyecto_id
    WHERE e.activo = true
    ORDER BY
      CASE WHEN e.propietario = 'Pinellas' THEN 0 ELSE 1 END,
      e.descripcion ASC
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
      const { propietario, search, estado } = req.query;

      let whereClause = 'WHERE e.activo = true';
      const queryParams: unknown[] = [];
      let paramCounter = 1;

      if (propietario) {
        whereClause += ` AND e.propietario = $${paramCounter}`;
        queryParams.push(propietario);
        paramCounter++;
      }

      if (search) {
        whereClause += ` AND (
      e.descripcion ILIKE $${paramCounter} OR
      e.marca ILIKE $${paramCounter} OR
      e.modelo ILIKE $${paramCounter} OR
      e.codigo ILIKE $${paramCounter}
    )`;
        queryParams.push(`%${search}%`);
        paramCounter++;
      }

      if (estado) {
        whereClause += ` AND e.estado = $${paramCounter}`;
        queryParams.push(estado);
        paramCounter++;
      }

      const result = await query<EquipoRow>(
        `
    SELECT e.id, e.codigo, e.descripcion, e.marca, e.modelo, e.ano, e.motor, e.chasis, e.costo,
           e.valor_actual, e.rata_mes, e.proyecto_id, e.responsable_id, e.estado, e.observaciones,
           e.propietario, e.created_at, e.updated_at,
           p.nombre_corto as proyecto_nombre, u.nombre as responsable_nombre
    FROM equipos e
    LEFT JOIN proyectos p ON p.id = e.proyecto_id
    LEFT JOIN users u ON u.id = e.responsable_id
    ${whereClause}
    ORDER BY
      CASE WHEN e.propietario = 'Pinellas' THEN 0 ELSE 1 END,
      e.descripcion ASC
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
    SELECT e.id, e.codigo, e.descripcion, e.marca, e.modelo, e.ano, e.motor, e.chasis, e.costo,
           e.valor_actual, e.rata_mes, e.proyecto_id, e.responsable_id, e.estado, e.observaciones,
           e.propietario, e.created_at, e.updated_at,
           p.nombre_corto as proyecto_nombre, u.nombre as responsable_nombre
    FROM equipos e
    LEFT JOIN proyectos p ON p.id = e.proyecto_id
    LEFT JOIN users u ON u.id = e.responsable_id
    WHERE e.id = $1 AND e.activo = true
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
    body('propietario')
      .isIn(['Pinellas', 'COCP'])
      .withMessage('Propietario debe ser Pinellas o COCP'),
    body('costo').optional({ nullable: true, checkFalsy: true }).isDecimal(),
    body('valor_actual')
      .optional({ nullable: true, checkFalsy: true })
      .isDecimal(),
    body('rata_mes').optional({ nullable: true, checkFalsy: true }).isDecimal(),
    body('proyecto_id')
      .optional({ nullable: true, checkFalsy: true })
      .isInt()
      .withMessage('ID de proyecto inválido'),
    body('responsable_id')
      .optional({ nullable: true, checkFalsy: true })
      .isInt()
      .withMessage('ID de responsable inválido'),
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
        proyecto_id,
        responsable_id,
        estado,
        observaciones,
        propietario,
      } = req.body;

      const result = await query<{ id: number }>(
        `
    INSERT INTO equipos (
      codigo, descripcion, marca, modelo, ano, motor, chasis,
      costo, valor_actual, rata_mes, proyecto_id, responsable_id,
      estado, observaciones, propietario
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
          proyecto_id || null,
          responsable_id || null,
          estado || null,
          observaciones || null,
          propietario,
        ],
      );

      await registrarAudit(req.user!.id, 'crear', 'equipo', result.rows[0].id, {
        descripcion,
        marca,
        modelo,
        propietario,
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
    body('propietario')
      .isIn(['Pinellas', 'COCP'])
      .withMessage('Propietario debe ser Pinellas o COCP'),
    body('proyecto_id')
      .optional({ nullable: true, checkFalsy: true })
      .isInt()
      .withMessage('ID de proyecto inválido'),
    body('responsable_id')
      .optional({ nullable: true, checkFalsy: true })
      .isInt()
      .withMessage('ID de responsable inválido'),
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
        proyecto_id,
        responsable_id,
        estado,
        observaciones,
        propietario,
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
      costo = $8, valor_actual = $9, rata_mes = $10, proyecto_id = $11, responsable_id = $12,
      estado = $13, observaciones = $14, propietario = $15, updated_at = CURRENT_TIMESTAMP
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
          proyecto_id || null,
          responsable_id || null,
          estado || null,
          observaciones || null,
          propietario,
          id,
        ],
      );

      await registrarAudit(req.user!.id, 'editar', 'equipo', parseInt(id), {
        descripcion,
        marca,
        modelo,
        propietario,
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
    body('proyecto_id')
      .optional({ nullable: true, checkFalsy: true })
      .isInt()
      .withMessage('ID de proyecto inválido'),
    body('responsable_id')
      .optional({ nullable: true, checkFalsy: true })
      .isInt()
      .withMessage('ID de responsable inválido'),
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
      const { estado, proyecto_id, responsable_id, rata_mes, observaciones_status } =
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
      estado = $1, proyecto_id = $2, responsable_id = $3, rata_mes = $4,
      observaciones_status = $5, updated_at = CURRENT_TIMESTAMP
    WHERE id = $6
  `,
        [
          estado || null,
          proyecto_id || null,
          responsable_id || null,
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
          proyecto_id,
          responsable_id,
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

      const equipoData = await query<{ descripcion: string; propietario: string }>(
        'SELECT descripcion, propietario FROM equipos WHERE id = $1',
        [id],
      );
      await query(
        'UPDATE equipos SET activo = false, updated_at = CURRENT_TIMESTAMP WHERE id = $1',
        [id],
      );

      await registrarAudit(req.user!.id, 'eliminar', 'equipo', parseInt(id), {
        descripcion: equipoData.rows[0]?.descripcion,
        propietario: equipoData.rows[0]?.propietario,
      });

      res.json({ success: true, message: 'Equipo eliminado exitosamente' });
    },
  ),
);

export default router;
