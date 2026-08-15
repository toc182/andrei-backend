import { Router, Request, Response } from 'express';
import { body, validationResult, param } from 'express-validator';
import { query, pool } from '../database/config.js';
import {
  authenticateToken,
  requireManager,
  checkPermission,
  checkProjectAccess,
} from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { registrarAudit } from '../services/auditLog.js';

const router = Router();

type ProjectState =
  | 'planificacion'
  | 'en_curso'
  | 'pausado'
  | 'completado'
  | 'cancelado';

interface ProjectRow {
  id: number;
  nombre: string;
  nombre_corto?: string;
  cliente_id?: number;
  fecha_inicio?: string;
  fecha_fin_estimada?: string;
  estado: ProjectState;
  contratista?: string;
  ingeniero_residente?: string;
  contrato?: string;
  acto_publico?: string;
  tipo_contrato?: 'publico' | 'privado';
  monto_contrato_original?: number;
  presupuesto_base?: number;
  itbms?: number;
  monto_total?: number;
  datos_adicionales?: Record<string, unknown>;
  cliente_nombre?: string;
  cliente_abreviatura?: string;
  cliente_contacto?: string;
  cliente_telefono?: string;
  cliente_email?: string;
  usuarios_asignados?: Array<{
    id: number;
    nombre: string;
    email: string;
    rol_proyecto: string;
  }>;
  created_at: Date;
  updated_at: Date;
}

interface CreateProjectBody {
  nombre: string;
  nombre_corto?: string;
  cliente_id?: number;
  fecha_inicio?: string;
  fecha_fin_estimada?: string;
  estado?: ProjectState;
  contratista?: string;
  ingeniero_residente?: string;
  contrato?: string;
  acto_publico?: string;
  tipo_contrato?: 'publico' | 'privado';
  monto_contrato_original?: number;
  presupuesto_base?: number;
  itbms?: number;
  monto_total?: number;
  datos_adicionales?: Record<string, unknown>;
}

interface QueryParams {
  page?: string;
  limit?: string;
  estado?: string;
  search?: string;
  tipo_origen?: string;
}

interface StatsRow {
  proyectos_activos: string;
  proyectos_planificacion: string;
  proyectos_completados: string;
  total_proyectos: string;
  monto_contratos_total: string;
}

// Obtener todos los proyectos
router.get(
  '/',
  authenticateToken,
  asyncHandler(
    async (
      req: Request<object, object, object, QueryParams>,
      res: Response,
    ): Promise<void> => {
      const {
        page = '1',
        limit = '10',
        estado,
        search,
        tipo_origen,
      } = req.query;
      const offset = (parseInt(page) - 1) * parseInt(limit);

      let whereClause = 'WHERE COALESCE(p.activo, true) = true';
      const queryParams: unknown[] = [];
      let paramCounter = 1;

      // Filtrar por acceso a proyectos si es usuario sin acceso_global
      if (
        req.user?.rol === 'usuario' &&
        !req.user?.permissions?.acceso_global
      ) {
        whereClause += ` AND p.id IN (SELECT proyecto_id FROM user_project_access WHERE user_id = $${paramCounter})`;
        queryParams.push(req.user.id);
        paramCounter++;
      }

      if (tipo_origen) {
        whereClause += ` AND p.tipo_origen = $${paramCounter}`;
        queryParams.push(tipo_origen);
        paramCounter++;
      }

      if (estado) {
        whereClause += ` AND p.estado = $${paramCounter}`;
        queryParams.push(estado);
        paramCounter++;
      }

      if (search) {
        whereClause += ` AND (
      p.nombre ILIKE $${paramCounter} OR
      p.nombre_corto ILIKE $${paramCounter} OR
      p.contratista ILIKE $${paramCounter} OR
      c.nombre ILIKE $${paramCounter}
    )`;
        queryParams.push(`%${search}%`);
        paramCounter++;
      }

      let result;
      try {
        result = await query<ProjectRow>(
          `
      SELECT
        p.id, p.nombre, p.nombre_corto, p.cliente_id,
        TO_CHAR(p.fecha_inicio, 'YYYY-MM-DD') AS fecha_inicio,
        TO_CHAR(p.fecha_fin_estimada, 'YYYY-MM-DD') AS fecha_fin_estimada,
        p.estado, p.contratista, p.ingeniero_residente, p.contrato,
        p.acto_publico, p.tipo_contrato, p.monto_contrato_original,
        COALESCE(p.presupuesto_base, 0) as presupuesto_base,
        COALESCE(p.itbms, 0) as itbms,
        COALESCE(p.monto_total, p.monto_contrato_original) as monto_total,
        p.datos_adicionales, p.created_at, p.updated_at,
        c.nombre as cliente_nombre, c.abreviatura as cliente_abreviatura
      FROM proyectos p
      LEFT JOIN clientes c ON p.cliente_id = c.id
      ${whereClause}
      ORDER BY p.created_at DESC
      LIMIT $${paramCounter} OFFSET $${paramCounter + 1}
    `,
          [...queryParams, limit, offset],
        );
      } catch {
        result = await query<ProjectRow>(
          `
      SELECT
        p.id, p.nombre, p.nombre_corto, p.cliente_id,
        TO_CHAR(p.fecha_inicio, 'YYYY-MM-DD') AS fecha_inicio,
        TO_CHAR(p.fecha_fin_estimada, 'YYYY-MM-DD') AS fecha_fin_estimada,
        p.estado, p.contratista, p.ingeniero_residente, p.contrato,
        p.acto_publico, p.tipo_contrato, p.tiene_ipt, p.monto_contrato_original, 0 as presupuesto_base, 0 as itbms,
        p.monto_contrato_original as monto_total, p.datos_adicionales, p.created_at, p.updated_at,
        c.nombre as cliente_nombre, c.abreviatura as cliente_abreviatura, c.tipo as cliente_tipo
      FROM proyectos p
      LEFT JOIN clientes c ON p.cliente_id = c.id
      ${whereClause}
      ORDER BY p.created_at DESC
      LIMIT $${paramCounter} OFFSET $${paramCounter + 1}
    `,
          [...queryParams, limit, offset],
        );
      }

      const countResult = await query<{ total: string }>(
        `
    SELECT COUNT(*) as total FROM proyectos p LEFT JOIN clientes c ON p.cliente_id = c.id ${whereClause}
  `,
        queryParams,
      );

      const total = parseInt(countResult.rows[0].total);

      res.json({
        success: true,
        proyectos: result.rows,
        pagination: {
          current_page: parseInt(page),
          total_pages: Math.ceil(total / parseInt(limit)),
          total_records: total,
          per_page: parseInt(limit),
        },
      });
    },
    {
      tableNotExistsDefault: {
        proyectos: [],
        pagination: {
          current_page: 1,
          total_pages: 0,
          total_records: 0,
          per_page: 10,
        },
      },
    },
  ),
);

// Obtener proyecto específico
router.get(
  '/:id',
  [
    param('id').isInt().withMessage('ID debe ser un número'),
    authenticateToken,
    checkProjectAccess('id'),
  ],
  asyncHandler(
    async (req: Request<{ id: string }>, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({
          success: false,
          message: 'ID inválido',
          errors: errors.array(),
        });
        return;
      }

      const { id } = req.params;

      const result = await query<ProjectRow>(
        `
    SELECT p.*,
           TO_CHAR(p.fecha_inicio, 'YYYY-MM-DD') AS fecha_inicio,
           TO_CHAR(p.fecha_fin_estimada, 'YYYY-MM-DD') AS fecha_fin_estimada,
           TO_CHAR(p.orden_proceder, 'YYYY-MM-DD') AS orden_proceder,
           c.nombre as cliente_nombre, c.contacto as cliente_contacto,
           c.telefono as cliente_telefono, c.email as cliente_email
    FROM proyectos p LEFT JOIN clientes c ON p.cliente_id = c.id
    WHERE p.id = $1
  `,
        [id],
      );

      if (result.rows.length === 0) {
        res
          .status(404)
          .json({ success: false, message: 'Proyecto no encontrado' });
        return;
      }

      const proyecto = result.rows[0];

      res.json({ success: true, proyecto });
    },
  ),
);

// Crear nuevo proyecto
router.post(
  '/',
  [
    body('nombre')
      .trim()
      .isLength({ min: 2 })
      .withMessage('Nombre debe tener al menos 2 caracteres'),
    body('nombre_corto').optional().trim().isLength({ max: 255 }),
    body('cliente_id').isInt({ min: 1 }).withMessage('El cliente es obligatorio'),
    body('fecha_inicio').optional({ nullable: true }).isISO8601(),
    body('fecha_fin_estimada').optional({ nullable: true }).isISO8601(),
    body('estado')
      .optional()
      .isIn([
        'planificacion',
        'en_curso',
        'pausado',
        'completado',
        'cancelado',
      ]),
    body('monto_contrato_original').optional({ nullable: true }).isNumeric(),
    body('presupuesto_base').optional({ nullable: true }).isNumeric(),
    body('itbms').optional({ nullable: true }).isNumeric(),
    body('monto_total')
      .exists({ values: 'falsy' })
      .withMessage('Monto total es requerido')
      .bail()
      .isFloat({ gt: 0 })
      .withMessage('Monto total debe ser mayor a cero'),
    body('datos_adicionales').optional().isObject(),
    authenticateToken,
    checkPermission('proyectos_crear'),
  ],
  asyncHandler(
    async (
      req: Request<object, object, CreateProjectBody>,
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
        nombre,
        nombre_corto,
        cliente_id,
        fecha_inicio,
        fecha_fin_estimada,
        estado = 'planificacion',
        contratista,
        ingeniero_residente,
        contrato,
        acto_publico,
        tipo_contrato = 'privado',
        monto_contrato_original,
        presupuesto_base,
        itbms,
        monto_total,
        datos_adicionales = {},
      } = req.body;

      const user = req.user!;
      const client = await pool.connect();
      let result;

      try {
        await client.query('BEGIN');

        // Try-catch interno preservado - fallback para esquemas sin columnas de presupuesto
        try {
          result = await client.query<ProjectRow>(
            `
      INSERT INTO proyectos (
        nombre, nombre_corto, cliente_id, fecha_inicio, fecha_fin_estimada,
        estado, contratista, ingeniero_residente,
        contrato, acto_publico, tipo_contrato, monto_contrato_original, presupuesto_base, itbms, monto_total, datos_adicionales
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      RETURNING *
    `,
            [
              nombre,
              nombre_corto,
              cliente_id,
              fecha_inicio,
              fecha_fin_estimada,
              estado,
              contratista,
              ingeniero_residente,
              contrato,
              acto_publico,
              tipo_contrato,
              monto_contrato_original,
              presupuesto_base,
              itbms,
              monto_total,
              JSON.stringify(datos_adicionales),
            ],
          );
        } catch (innerError) {
          const innerDbError = innerError as { code?: string };
          if (innerDbError.code === '23505') {
            throw innerError;
          }
          result = await client.query<ProjectRow>(
            `
      INSERT INTO proyectos (
        nombre, nombre_corto, cliente_id, fecha_inicio, fecha_fin_estimada,
        estado, contratista, ingeniero_residente,
        contrato, acto_publico, tipo_contrato, monto_contrato_original, datos_adicionales
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING *
    `,
            [
              nombre,
              nombre_corto,
              cliente_id,
              fecha_inicio,
              fecha_fin_estimada,
              estado,
              contratista,
              ingeniero_residente,
              contrato,
              acto_publico,
              tipo_contrato,
              monto_contrato_original,
              JSON.stringify(datos_adicionales),
            ],
          );
        }

        const proyecto = result.rows[0];

        await client.query('COMMIT');

        // El proyecto NACE sin cuentas: la primera cuenta la crea el usuario
        // desde la sección Cuentas (a mano o con desglose). Antes se auto-creaba
        // una "Cuenta 1" en borrador — confundía y estorbaba la elección de modo.
        await registrarAudit(user.id, 'crear', 'proyecto', proyecto.id, {
          nombre,
        });

        res.status(201).json({
          success: true,
          message: 'Proyecto creado exitosamente',
          proyecto,
        });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
    {
      duplicateMessage: 'El código de proyecto ya existe',
    },
  ),
);

// Actualizar proyecto
router.put(
  '/:id',
  [
    param('id').isInt().withMessage('ID debe ser un número'),
    body('nombre').optional().trim().isLength({ min: 2 }),
    body('orden_proceder').optional({ nullable: true }).isISO8601(),
    body('estado')
      .optional()
      .isIn([
        'planificacion',
        'en_curso',
        'pausado',
        'completado',
        'cancelado',
      ]),
    authenticateToken,
    checkPermission('proyectos_editar'),
    checkProjectAccess('id'),
  ],
  asyncHandler(
    async (
      req: Request<{ id: string }, object, Partial<CreateProjectBody>>,
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

      const { id } = req.params;
      const updateData = req.body;

      const projectResult = await query<{ id: number }>(
        'SELECT * FROM proyectos WHERE id = $1',
        [id],
      );
      if (projectResult.rows.length === 0) {
        res
          .status(404)
          .json({ success: false, message: 'Proyecto no encontrado' });
        return;
      }

      const allowedFields = [
        'nombre',
        'nombre_corto',
        'cliente_id',
        'fecha_inicio',
        'fecha_fin_estimada',
        // Fecha de la Orden de Proceder: de ella arranca el periodo de la
        // cuenta 1 (ver 147_proyecto_orden_proceder.sql).
        'orden_proceder',
        'estado',
        'contratista',
        'ingeniero_residente',
        'contrato',
        'acto_publico',
        'tipo_contrato',
        'monto_contrato_original',
        'presupuesto_base',
        'itbms',
        'monto_total',
        'datos_adicionales',
      ];

      const updateFields: string[] = [];
      const updateValues: unknown[] = [];
      let paramCounter = 1;

      Object.keys(updateData).forEach((key) => {
        if (
          updateData[key as keyof typeof updateData] !== undefined &&
          allowedFields.includes(key)
        ) {
          if (key === 'datos_adicionales') {
            updateFields.push(`${key} = $${paramCounter}`);
            updateValues.push(
              JSON.stringify(updateData[key as keyof typeof updateData]),
            );
          } else {
            updateFields.push(`${key} = $${paramCounter}`);
            updateValues.push(updateData[key as keyof typeof updateData]);
          }
          paramCounter++;
        }
      });

      if (updateFields.length === 0) {
        res
          .status(400)
          .json({ success: false, message: 'No hay datos para actualizar' });
        return;
      }

      updateFields.push(`updated_at = CURRENT_TIMESTAMP`);
      updateValues.push(id);

      const result = await query<ProjectRow>(
        `
    UPDATE proyectos SET ${updateFields.join(', ')} WHERE id = $${paramCounter} RETURNING *
  `,
        updateValues,
      );

      await registrarAudit(req.user!.id, 'editar', 'proyecto', parseInt(id), {
        nombre: result.rows[0].nombre,
        campos_modificados: Object.keys(updateData).filter((k) =>
          allowedFields.includes(k),
        ),
      });

      res.json({
        success: true,
        message: 'Proyecto actualizado exitosamente',
        proyecto: result.rows[0],
      });
    },
    {
      duplicateMessage: 'El código de proyecto ya existe',
    },
  ),
);

// Eliminar proyecto
router.delete(
  '/:id',
  [
    param('id').isInt().withMessage('ID debe ser un número'),
    authenticateToken,
    checkPermission('proyectos_eliminar'),
  ],
  asyncHandler(
    async (req: Request<{ id: string }>, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({
          success: false,
          message: 'ID inválido',
          errors: errors.array(),
        });
        return;
      }

      const { id } = req.params;

      const projectResult = await query<{ id: number; nombre: string }>(
        'SELECT id, nombre FROM proyectos WHERE id = $1',
        [id],
      );
      if (projectResult.rows.length === 0) {
        res
          .status(404)
          .json({ success: false, message: 'Proyecto no encontrado' });
        return;
      }

      if (req.user!.rol !== 'admin') {
        res.status(403).json({
          success: false,
          message: 'Solo administradores pueden eliminar proyectos',
        });
        return;
      }

      const { nombre } = projectResult.rows[0];
      // Soft delete — keeps the row + audit trail intact, hides from list.
      await query(
        'UPDATE proyectos SET activo = false, updated_at = CURRENT_TIMESTAMP WHERE id = $1',
        [id],
      );
      await registrarAudit(req.user!.id, 'eliminar', 'proyecto', parseInt(id), {
        nombre,
      });

      res.json({ success: true, message: 'Proyecto eliminado exitosamente' });
    },
  ),
);

// Estadísticas básicas
router.get(
  '/stats/dashboard',
  authenticateToken,
  asyncHandler(
    async (_req: Request, res: Response): Promise<void> => {
      const statsResult = await query<StatsRow>(`
    SELECT
      COUNT(CASE WHEN estado = 'en_curso' THEN 1 END) as proyectos_activos,
      COUNT(CASE WHEN estado = 'planificacion' THEN 1 END) as proyectos_planificacion,
      COUNT(CASE WHEN estado = 'completado' THEN 1 END) as proyectos_completados,
      COUNT(*) as total_proyectos,
      COALESCE(SUM(COALESCE(monto_total, monto_contrato_original)), 0) as monto_contratos_total
    FROM proyectos
  `);

      res.json({ success: true, stats: statsResult.rows[0] });
    },
    {
      tableNotExistsDefault: {
        stats: {
          proyectos_activos: 0,
          proyectos_planificacion: 0,
          proyectos_completados: 0,
          total_proyectos: 0,
          monto_contratos_total: 0,
        },
      },
    },
  ),
);

// Actualizar datos adicionales
router.patch(
  '/:id/datos-adicionales',
  [
    param('id').isInt().withMessage('ID debe ser un número'),
    body('datos').isObject().withMessage('Datos debe ser un objeto JSON'),
    authenticateToken,
    requireManager,
  ],
  asyncHandler(
    async (
      req: Request<{ id: string }, object, { datos: Record<string, unknown> }>,
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

      const { id } = req.params;
      const { datos } = req.body;

      const currentResult = await query<{
        datos_adicionales: Record<string, unknown> | null;
      }>('SELECT datos_adicionales FROM proyectos WHERE id = $1', [id]);

      if (currentResult.rows.length === 0) {
        res
          .status(404)
          .json({ success: false, message: 'Proyecto no encontrado' });
        return;
      }

      const currentData = currentResult.rows[0].datos_adicionales || {};
      const mergedData = { ...currentData, ...datos };

      const result = await query<{
        datos_adicionales: Record<string, unknown>;
      }>(
        `
    UPDATE proyectos SET datos_adicionales = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING datos_adicionales
  `,
        [JSON.stringify(mergedData), id],
      );

      res.json({
        success: true,
        message: 'Datos adicionales actualizados',
        datos_adicionales: result.rows[0].datos_adicionales,
      });
    },
  ),
);

// PUT /projects/:id/ajustes-cuenta-impresion — el montaje de la hoja que se
// imprime y se entrega en la institución (Cuadro de Presentación de Cuenta):
// título, las tres columnas del encabezado, las firmas, los logos y el papel.
// Se llena una vez y vale para todas las cuentas del proyecto.
//
// Deliberadamente NO toca updated_at: esto es presentación, no dato del
// proyecto, y bumpearlo ensuciaría el historial de cambios del proyecto con
// cada retoque del papel. Mismo criterio que
// PUT /cronogramas/:id/ajustes-impresion.
const AJUSTES_MAX_BYTES = 600 * 1024;
router.put(
  '/:id/ajustes-cuenta-impresion',
  [
    param('id').isInt().withMessage('ID debe ser un número'),
    authenticateToken,
    requireManager,
    checkProjectAccess('id'),
  ],
  asyncHandler(
    async (req: Request<{ id: string }>, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({ success: false, message: 'ID inválido' });
        return;
      }

      const body = req.body as unknown;
      if (body == null || typeof body !== 'object' || Array.isArray(body)) {
        res.status(400).json({
          success: false,
          message: 'Los ajustes de impresión deben ser un objeto',
        });
        return;
      }

      // Los logos viajan como data URL adentro; sin tope, una subida pesada
      // se guardaría en la fila del proyecto y la arrastraría en cada lectura.
      const json = JSON.stringify(body);
      if (Buffer.byteLength(json, 'utf8') > AJUSTES_MAX_BYTES) {
        res.status(400).json({
          success: false,
          message: 'Los ajustes de impresión exceden 600 KB (logos demasiado grandes).',
        });
        return;
      }

      const r = await query<{ id: number }>(
        `UPDATE proyectos SET ajustes_cuenta_impresion = $1
          WHERE id = $2
          RETURNING id`,
        [json, req.params.id],
      );
      if (r.rows.length === 0) {
        res.status(404).json({ success: false, message: 'Proyecto no encontrado' });
        return;
      }

      res.json({ success: true, data: body });
    },
  ),
);

export default router;
