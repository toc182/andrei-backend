import { Router, Request, Response } from 'express';
import { body, param, validationResult } from 'express-validator';
import { query } from '../database/config.js';
import {
  authenticateToken,
  requireManager,
  checkPermission,
} from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

const router = Router();

type OportunidadEstado =
  | 'prospecto'
  | 'calificada'
  | 'propuesta'
  | 'negociacion'
  | 'cerrada'
  | 'perdida';

interface OportunidadRow {
  id: number;
  nombre_oportunidad: string;
  cliente_potencial: string;
  contacto_referido?: string;
  telefono_contacto?: string;
  email_contacto?: string;
  valor_estimado?: number;
  moneda: string;
  probabilidad_cierre?: number;
  fecha_contacto_inicial?: Date;
  fecha_estimada_cierre?: Date;
  tipo_trabajo?: string;
  notas_comerciales?: string;
  siguiente_accion?: string;
  fecha_siguiente_seguimiento?: Date;
  origen?: string;
  assigned_to?: number;
  estado_oportunidad: OportunidadEstado;
  created_by: number;
  created_by_name?: string;
  assigned_to_name?: string;
  tiene_proyecto_asociado?: boolean;
  proyecto_id?: number;
  created_at: Date;
  updated_at: Date;
}

interface CreateOportunidadBody {
  nombre_oportunidad: string;
  cliente_potencial: string;
  contacto_referido?: string;
  telefono_contacto?: string;
  email_contacto?: string;
  valor_estimado?: number;
  moneda?: string;
  probabilidad_cierre?: number;
  fecha_contacto_inicial?: string;
  fecha_estimada_cierre?: string;
  tipo_trabajo?: string;
  notas_comerciales?: string;
  siguiente_accion?: string;
  fecha_siguiente_seguimiento?: string;
  origen?: string;
  assigned_to?: number;
}

interface QueryParams {
  estado?: string;
  assigned_to?: string;
  page?: string;
  limit?: string;
}

// Obtener todas las oportunidades
router.get(
  '/',
  authenticateToken,
  checkPermission('oportunidades_ver'),
  asyncHandler(
    async (
      req: Request<object, object, object, QueryParams>,
      res: Response,
    ): Promise<void> => {
      const { estado, assigned_to, page = '1', limit = '10' } = req.query;
      const offset = (parseInt(page) - 1) * parseInt(limit);

      let whereClause = 'WHERE 1=1';
      const queryParams: unknown[] = [];
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

      const result = await query<OportunidadRow>(
        `
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
  `,
        [...queryParams, limit, offset],
      );

      const countResult = await query<{ total: string }>(
        `
    SELECT COUNT(*) as total FROM oportunidades o ${whereClause}
  `,
        queryParams,
      );

      const total = parseInt(countResult.rows[0].total);

      res.json({
        success: true,
        oportunidades: result.rows,
        pagination: {
          current_page: parseInt(page),
          total_pages: Math.ceil(total / parseInt(limit)),
          total_records: total,
          per_page: parseInt(limit),
        },
      });
    },
  ),
);

// Crear nueva oportunidad
router.post(
  '/',
  [
    body('nombre_oportunidad')
      .trim()
      .isLength({ min: 2 })
      .withMessage('Nombre debe tener al menos 2 caracteres'),
    body('cliente_potencial')
      .trim()
      .isLength({ min: 2 })
      .withMessage('Cliente potencial es requerido'),
    body('valor_estimado')
      .optional({ nullable: true })
      .isNumeric()
      .withMessage('Valor estimado debe ser un número'),
    body('probabilidad_cierre')
      .optional({ nullable: true })
      .isInt({ min: 0, max: 100 })
      .withMessage('Probabilidad debe ser entre 0 y 100'),
    authenticateToken,
  ],
  asyncHandler(
    async (
      req: Request<object, object, CreateOportunidadBody>,
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
        assigned_to,
      } = req.body;

      const result = await query<OportunidadRow>(
        `
    INSERT INTO oportunidades (
      nombre_oportunidad, cliente_potencial, contacto_referido, telefono_contacto,
      email_contacto, valor_estimado, moneda, probabilidad_cierre, fecha_contacto_inicial,
      fecha_estimada_cierre, tipo_trabajo, notas_comerciales, siguiente_accion,
      fecha_siguiente_seguimiento, origen, assigned_to, created_by
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
    RETURNING *
  `,
        [
          nombre_oportunidad,
          cliente_potencial,
          contacto_referido,
          telefono_contacto,
          email_contacto,
          valor_estimado,
          moneda,
          probabilidad_cierre,
          fecha_contacto_inicial,
          fecha_estimada_cierre,
          tipo_trabajo,
          notas_comerciales,
          siguiente_accion,
          fecha_siguiente_seguimiento,
          origen,
          assigned_to,
          req.user!.id,
        ],
      );

      res.status(201).json({
        success: true,
        message: 'Oportunidad creada exitosamente',
        oportunidad: result.rows[0],
      });
    },
  ),
);

// Actualizar estado de oportunidad
router.put(
  '/:id/estado',
  [
    param('id').isInt().withMessage('ID debe ser un número'),
    body('estado_oportunidad')
      .isIn([
        'prospecto',
        'calificada',
        'propuesta',
        'negociacion',
        'cerrada',
        'perdida',
      ])
      .withMessage('Estado de oportunidad inválido'),
    authenticateToken,
  ],
  asyncHandler(
    async (
      req: Request<
        { id: string },
        object,
        { estado_oportunidad: OportunidadEstado; notas_comerciales?: string }
      >,
      res: Response,
    ): Promise<void> => {
      const { id } = req.params;
      const { estado_oportunidad, notas_comerciales } = req.body;

      const result = await query<OportunidadRow>(
        `
    UPDATE oportunidades
    SET estado_oportunidad = $1, notas_comerciales = COALESCE($2, notas_comerciales), updated_at = CURRENT_TIMESTAMP
    WHERE id = $3
    RETURNING *
  `,
        [estado_oportunidad, notas_comerciales, id],
      );

      if (result.rows.length === 0) {
        res.status(404).json({
          success: false,
          message: 'Oportunidad no encontrada',
        });
        return;
      }

      res.json({
        success: true,
        message: 'Estado de oportunidad actualizado',
        oportunidad: result.rows[0],
      });
    },
  ),
);

// Convertir oportunidad cerrada a proyecto
router.post(
  '/:id/convert-to-project',
  [
    param('id').isInt().withMessage('ID debe ser un número'),
    authenticateToken,
    requireManager,
  ],
  asyncHandler(
    async (req: Request<{ id: string }>, res: Response): Promise<void> => {
      const { id } = req.params;

      const oportunidadResult = await query<OportunidadRow>(
        `
    SELECT * FROM oportunidades WHERE id = $1 AND estado_oportunidad = 'cerrada'
  `,
        [id],
      );

      if (oportunidadResult.rows.length === 0) {
        res.status(400).json({
          success: false,
          message: 'Oportunidad no encontrada o no está cerrada',
        });
        return;
      }

      const oportunidad = oportunidadResult.rows[0];

      const proyectoResult = await query(
        `
    INSERT INTO proyectos (
      nombre, monto_contrato_original, oportunidad_id, tipo_origen,
      datos_adicionales, created_at
    ) VALUES ($1, $2, $3, 'oportunidad', $4, CURRENT_TIMESTAMP)
    RETURNING *
  `,
        [
          oportunidad.nombre_oportunidad,
          oportunidad.valor_estimado,
          oportunidad.id,
          JSON.stringify({
            cliente_potencial: oportunidad.cliente_potencial,
            contacto_referido: oportunidad.contacto_referido,
            tipo_trabajo: oportunidad.tipo_trabajo,
            origen: oportunidad.origen,
          }),
        ],
      );

      res.status(201).json({
        success: true,
        message: 'Proyecto creado desde oportunidad',
        proyecto: proyectoResult.rows[0],
        oportunidad: oportunidad,
      });
    },
  ),
);

export default router;
