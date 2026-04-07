import { Router, Request, Response } from 'express';
import { body, param, validationResult } from 'express-validator';
import { query } from '../database/config.js';
import { authenticateToken, requireManager } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

const router = Router();

type RequisicionEstado =
  | 'pendiente'
  | 'en_cotizacion'
  | 'por_aprobar'
  | 'aprobada'
  | 'pagada'
  | 'rechazada';

interface RequisicionRow {
  id: number;
  numero: string;
  project_id: number;
  proveedor: string;
  concepto?: string;
  fecha: Date;
  pdf_url?: string;
  pdf_nombre?: string;
  solicitado_por: number;
  solicitante_id: number;
  estado: RequisicionEstado;
  subtotal: number;
  itbms: number;
  monto_total: number;
  aprobado_por?: number;
  fecha_aprobacion?: Date;
  pagado_por?: number;
  fecha_pago?: Date;
  expense_id?: number;
  archivada: boolean;
  fecha_archivado?: Date;
  archivado_por?: number;
  proyecto_nombre?: string;
  proyecto_corto?: string;
  creador_nombre?: string;
  solicitante_nombre?: string;
  aprobador_nombre?: string;
  pagador_nombre?: string;
  items_count?: string;
  created_at: Date;
  updated_at: Date;
}

interface RequisicionItemRow {
  id: number;
  requisicion_id: number;
  descripcion: string;
  cantidad: number;
  unidad: string;
  precio_unitario: number;
  subtotal: number;
  aplica_itbms: boolean;
  itbms: number;
  total: number;
  categoria_id?: number;
  categoria_nombre?: string;
  categoria_codigo?: string;
  categoria_color?: string;
  notas?: string;
}

interface HistorialRow {
  id: number;
  requisicion_id: number;
  estado_anterior?: string;
  estado_nuevo: string;
  usuario_id: number;
  usuario_nombre?: string;
  comentario?: string;
  created_at: Date;
}

interface CreateItemBody {
  descripcion: string;
  cantidad: number | string;
  unidad?: string;
  precio_unitario: number | string;
  aplica_itbms?: boolean;
  categoria_id?: number;
  notas?: string;
}

interface CreateRequisicionBody {
  numero: string;
  project_id: number;
  proveedor: string;
  concepto?: string;
  fecha?: string;
  pdf_url?: string;
  pdf_nombre?: string;
  items: CreateItemBody[];
  solicitante_id?: number;
}

interface QueryParams {
  project_id?: string;
  estado?: string;
  archivadas?: string;
  limit?: string;
  offset?: string;
}

// Obtener todas las requisiciones
router.get(
  '/',
  authenticateToken,
  asyncHandler(
    async (
      req: Request<object, object, object, QueryParams>,
      res: Response,
    ): Promise<void> => {
      const {
        project_id,
        estado,
        archivadas,
        limit = '50',
        offset = '0',
      } = req.query;

      let whereClause = 'WHERE (r.archivada = FALSE OR r.archivada IS NULL)';
      const params: unknown[] = [];
      let paramCount = 0;

      if (archivadas === 'true') {
        whereClause = 'WHERE r.archivada = TRUE';
      } else if (archivadas === 'all') {
        whereClause = 'WHERE 1=1';
      }

      if (project_id) {
        paramCount++;
        whereClause += ` AND r.project_id = $${paramCount}`;
        params.push(project_id);
      }

      if (estado) {
        paramCount++;
        whereClause += ` AND r.estado = $${paramCount}`;
        params.push(estado);
      }

      paramCount++;
      const limitParam = paramCount;
      params.push(parseInt(limit));

      paramCount++;
      const offsetParam = paramCount;
      params.push(parseInt(offset));

      const result = await query<RequisicionRow>(
        `
    SELECT r.*, p.nombre as proyecto_nombre, p.nombre_corto as proyecto_corto,
           u_creador.nombre as creador_nombre, u_solicitante.nombre as solicitante_nombre,
           u_apr.nombre as aprobador_nombre, u_pag.nombre as pagador_nombre,
           (SELECT COUNT(*) FROM requisicion_items ri WHERE ri.requisicion_id = r.id) as items_count
    FROM requisiciones r
    LEFT JOIN proyectos p ON r.project_id = p.id
    LEFT JOIN users u_creador ON r.solicitado_por = u_creador.id
    LEFT JOIN users u_solicitante ON r.solicitante_id = u_solicitante.id
    LEFT JOIN users u_apr ON r.aprobado_por = u_apr.id
    LEFT JOIN users u_pag ON r.pagado_por = u_pag.id
    ${whereClause}
    ORDER BY r.created_at DESC
    LIMIT $${limitParam} OFFSET $${offsetParam}
  `,
        params,
      );

      const countResult = await query<{ total: string }>(
        `
    SELECT COUNT(*) as total FROM requisiciones r ${whereClause.replace(` LIMIT $${limitParam} OFFSET $${offsetParam}`, '')}
  `,
        params.slice(0, -2),
      );

      res.json({
        success: true,
        requisiciones: result.rows,
        total: parseInt(countResult.rows[0].total),
        limit: parseInt(limit),
        offset: parseInt(offset),
      });
    },
  ),
);

// Obtener requisiciones por proyecto
router.get(
  '/project/:projectId',
  authenticateToken,
  [param('projectId').isInt().withMessage('ID de proyecto inválido')],
  asyncHandler(
    async (
      req: Request<
        { projectId: string },
        object,
        object,
        { estado?: string; archivadas?: string }
      >,
      res: Response,
    ): Promise<void> => {
      const { projectId } = req.params;
      const { estado, archivadas } = req.query;

      let whereClause =
        'WHERE r.project_id = $1 AND (r.archivada = FALSE OR r.archivada IS NULL)';
      const params: unknown[] = [projectId];

      if (archivadas === 'true') {
        whereClause = 'WHERE r.project_id = $1 AND r.archivada = TRUE';
      } else if (archivadas === 'all') {
        whereClause = 'WHERE r.project_id = $1';
      }

      if (estado) {
        whereClause += ' AND r.estado = $2';
        params.push(estado);
      }

      const result = await query<RequisicionRow>(
        `
    SELECT r.*, u_creador.nombre as creador_nombre, u_solicitante.nombre as solicitante_nombre,
           u_apr.nombre as aprobador_nombre,
           (SELECT COUNT(*) FROM requisicion_items ri WHERE ri.requisicion_id = r.id) as items_count
    FROM requisiciones r
    LEFT JOIN users u_creador ON r.solicitado_por = u_creador.id
    LEFT JOIN users u_solicitante ON r.solicitante_id = u_solicitante.id
    LEFT JOIN users u_apr ON r.aprobado_por = u_apr.id
    ${whereClause}
    ORDER BY r.created_at DESC
  `,
        params,
      );

      res.json({ success: true, requisiciones: result.rows });
    },
  ),
);

// Obtener una requisición por ID
router.get(
  '/:id',
  authenticateToken,
  [param('id').isInt().withMessage('ID de requisición inválido')],
  asyncHandler(
    async (req: Request<{ id: string }>, res: Response): Promise<void> => {
      const { id } = req.params;

      const result = await query<RequisicionRow>(
        `
    SELECT r.*, p.nombre as proyecto_nombre, p.nombre_corto as proyecto_corto,
           u_creador.nombre as creador_nombre, u_solicitante.nombre as solicitante_nombre,
           u_apr.nombre as aprobador_nombre, u_pag.nombre as pagador_nombre
    FROM requisiciones r
    LEFT JOIN proyectos p ON r.project_id = p.id
    LEFT JOIN users u_creador ON r.solicitado_por = u_creador.id
    LEFT JOIN users u_solicitante ON r.solicitante_id = u_solicitante.id
    LEFT JOIN users u_apr ON r.aprobado_por = u_apr.id
    LEFT JOIN users u_pag ON r.pagado_por = u_pag.id
    WHERE r.id = $1
  `,
        [id],
      );

      if (result.rows.length === 0) {
        res
          .status(404)
          .json({ success: false, message: 'Requisición no encontrada' });
        return;
      }

      const items = await query<RequisicionItemRow>(
        `
    SELECT ri.*, pec.nombre as categoria_nombre, pec.codigo as categoria_codigo, pec.color as categoria_color
    FROM requisicion_items ri
    LEFT JOIN project_expense_categories pec ON ri.categoria_id = pec.id
    WHERE ri.requisicion_id = $1
    ORDER BY ri.id
  `,
        [id],
      );

      const historial = await query<HistorialRow>(
        `
    SELECT rh.*, u.nombre as usuario_nombre
    FROM requisiciones_historial rh
    LEFT JOIN users u ON rh.usuario_id = u.id
    WHERE rh.requisicion_id = $1
    ORDER BY rh.created_at DESC
  `,
        [id],
      );

      res.json({
        success: true,
        requisicion: result.rows[0],
        items: items.rows,
        historial: historial.rows,
      });
    },
  ),
);

// Crear requisición
router.post(
  '/',
  authenticateToken,
  [
    body('numero')
      .trim()
      .notEmpty()
      .withMessage('Número de requisición requerido'),
    body('project_id').isInt().withMessage('ID de proyecto inválido'),
    body('proveedor').trim().notEmpty().withMessage('Proveedor requerido'),
    body('items')
      .isArray({ min: 1 })
      .withMessage('Debe incluir al menos un item'),
    body('items.*.descripcion')
      .trim()
      .notEmpty()
      .withMessage('Descripción del item requerida'),
    body('items.*.cantidad')
      .isNumeric()
      .withMessage('Cantidad debe ser un número'),
    body('items.*.precio_unitario')
      .isNumeric()
      .withMessage('Precio unitario debe ser un número'),
  ],
  asyncHandler(
    async (
      req: Request<object, object, CreateRequisicionBody>,
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
        numero,
        project_id,
        proveedor,
        concepto,
        fecha,
        pdf_url,
        pdf_nombre,
        items,
        solicitante_id,
      } = req.body;

      let subtotalGeneral = 0;
      let itbmsGeneral = 0;

      const itemsCalculados = items.map((item) => {
        const cantidad = parseFloat(String(item.cantidad));
        const precioUnitario = parseFloat(String(item.precio_unitario));
        const subtotal = cantidad * precioUnitario;
        const aplicaItbms = item.aplica_itbms === true;
        const itbms = aplicaItbms ? subtotal * 0.07 : 0;
        const total = subtotal + itbms;

        subtotalGeneral += subtotal;
        itbmsGeneral += itbms;

        return {
          ...item,
          cantidad,
          precio_unitario: precioUnitario,
          subtotal,
          aplica_itbms: aplicaItbms,
          itbms,
          total,
        };
      });

      const montoTotal = subtotalGeneral + itbmsGeneral;
      const solicitanteIdFinal = solicitante_id || req.user!.id;

      const result = await query<RequisicionRow>(
        `
    INSERT INTO requisiciones (
      numero, project_id, proveedor, concepto, fecha, pdf_url, pdf_nombre,
      solicitado_por, solicitante_id, estado, subtotal, itbms, monto_total
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pendiente', $10, $11, $12)
    RETURNING *
  `,
        [
          numero,
          project_id,
          proveedor,
          concepto || null,
          fecha || new Date(),
          pdf_url || null,
          pdf_nombre || null,
          req.user!.id,
          solicitanteIdFinal,
          subtotalGeneral,
          itbmsGeneral,
          montoTotal,
        ],
      );

      const requisicionId = result.rows[0].id;

      // Insertar todos los items en una sola query
      if (itemsCalculados.length > 0) {
        const values = itemsCalculados
          .map((_, i) => {
            const b = i * 11;
            return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8}, $${b + 9}, $${b + 10}, $${b + 11})`;
          })
          .join(', ');
        const params: unknown[] = itemsCalculados.flatMap((item) => [
          requisicionId,
          item.descripcion,
          item.cantidad,
          item.unidad || 'unidad',
          item.precio_unitario,
          item.subtotal,
          item.aplica_itbms,
          item.itbms,
          item.total,
          item.categoria_id || null,
          item.notas || null,
        ]);
        await query(
          `
      INSERT INTO requisicion_items (
        requisicion_id, descripcion, cantidad, unidad, precio_unitario,
        subtotal, aplica_itbms, itbms, total, categoria_id, notas
      ) VALUES ${values}
    `,
          params,
        );
      }

      await query(
        `
    INSERT INTO requisiciones_historial (requisicion_id, estado_nuevo, usuario_id, comentario)
    VALUES ($1, 'pendiente', $2, 'Requisición creada')
  `,
        [requisicionId, req.user!.id],
      );

      res.status(201).json({
        success: true,
        message: 'Requisición creada exitosamente',
        requisicion: result.rows[0],
      });
    },
    {
      duplicateMessage: 'Ya existe una requisición con ese número',
    },
  ),
);

// Actualizar requisición
router.put(
  '/:id',
  authenticateToken,
  [
    param('id').isInt().withMessage('ID de requisición inválido'),
    body('proveedor').optional().trim().notEmpty(),
    body('items').optional().isArray(),
  ],
  asyncHandler(
    async (
      req: Request<
        { id: string },
        object,
        { proveedor?: string; concepto?: string; items?: CreateItemBody[] }
      >,
      res: Response,
    ): Promise<void> => {
      const { id } = req.params;
      const { proveedor, concepto, items } = req.body;

      const existing = await query<RequisicionRow>(
        'SELECT * FROM requisiciones WHERE id = $1',
        [id],
      );
      if (existing.rows.length === 0) {
        res
          .status(404)
          .json({ success: false, message: 'Requisición no encontrada' });
        return;
      }

      if (!['pendiente', 'en_cotizacion'].includes(existing.rows[0].estado)) {
        res.status(400).json({
          success: false,
          message:
            'Solo se pueden editar requisiciones pendientes o en cotización',
        });
        return;
      }

      // Verificar permisos: admin/co-admin pasan; usuario con requisiciones_editar_todas pasa; sino verificar propiedad
      if (
        req.user?.rol === 'usuario' &&
        !req.user?.permissions?.requisiciones_editar_todas
      ) {
        if (existing.rows[0].solicitante_id !== req.user.id) {
          res.status(403).json({
            success: false,
            message: 'Solo puedes editar tus propias requisiciones',
          });
          return;
        }
      }

      let subtotalGeneral = existing.rows[0].subtotal;
      let itbmsGeneral = existing.rows[0].itbms;
      let montoTotal = existing.rows[0].monto_total;

      if (items && items.length > 0) {
        await query('DELETE FROM requisicion_items WHERE requisicion_id = $1', [
          id,
        ]);

        subtotalGeneral = 0;
        itbmsGeneral = 0;

        const itemsCalculados = items.map((item) => {
          const cantidad = parseFloat(String(item.cantidad));
          const precioUnitario = parseFloat(String(item.precio_unitario));
          const subtotal = cantidad * precioUnitario;
          const aplicaItbms = item.aplica_itbms === true;
          const itbms = aplicaItbms ? subtotal * 0.07 : 0;
          const total = subtotal + itbms;

          subtotalGeneral += subtotal;
          itbmsGeneral += itbms;

          return {
            ...item,
            cantidad,
            precio_unitario: precioUnitario,
            subtotal,
            aplica_itbms: aplicaItbms,
            itbms,
            total,
          };
        });

        // Insertar todos los items en una sola query
        const values = itemsCalculados
          .map((_, i) => {
            const b = i * 11;
            return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8}, $${b + 9}, $${b + 10}, $${b + 11})`;
          })
          .join(', ');
        const itemParams: unknown[] = itemsCalculados.flatMap((item) => [
          id,
          item.descripcion,
          item.cantidad,
          item.unidad || 'unidad',
          item.precio_unitario,
          item.subtotal,
          item.aplica_itbms,
          item.itbms,
          item.total,
          item.categoria_id || null,
          item.notas || null,
        ]);
        await query(
          `
      INSERT INTO requisicion_items (
        requisicion_id, descripcion, cantidad, unidad, precio_unitario,
        subtotal, aplica_itbms, itbms, total, categoria_id, notas
      ) VALUES ${values}
    `,
          itemParams,
        );

        montoTotal = subtotalGeneral + itbmsGeneral;
      }

      const result = await query<RequisicionRow>(
        `
    UPDATE requisiciones SET
      proveedor = COALESCE($1, proveedor),
      concepto = COALESCE($2, concepto),
      subtotal = $3, itbms = $4, monto_total = $5,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = $6
    RETURNING *
  `,
        [proveedor, concepto, subtotalGeneral, itbmsGeneral, montoTotal, id],
      );

      res.json({
        success: true,
        message: 'Requisición actualizada',
        requisicion: result.rows[0],
      });
    },
  ),
);

// Cambiar estado
router.patch(
  '/:id/estado',
  authenticateToken,
  [
    param('id').isInt().withMessage('ID de requisición inválido'),
    body('estado')
      .isIn([
        'pendiente',
        'en_cotizacion',
        'por_aprobar',
        'aprobada',
        'pagada',
        'rechazada',
      ])
      .withMessage('Estado inválido'),
    body('comentario').optional().trim(),
  ],
  asyncHandler(
    async (
      req: Request<
        { id: string },
        object,
        { estado: RequisicionEstado; comentario?: string }
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

      const { id } = req.params;
      const { estado, comentario } = req.body;

      const existing = await query<RequisicionRow>(
        'SELECT * FROM requisiciones WHERE id = $1',
        [id],
      );
      if (existing.rows.length === 0) {
        res
          .status(404)
          .json({ success: false, message: 'Requisición no encontrada' });
        return;
      }

      const estadoAnterior = existing.rows[0].estado;
      const requisicion = existing.rows[0];

      const transicionesPermitidas: Record<string, string[]> = {
        pendiente: ['en_cotizacion', 'por_aprobar', 'rechazada'],
        en_cotizacion: ['por_aprobar', 'pendiente', 'rechazada'],
        por_aprobar: ['aprobada', 'rechazada', 'pendiente'],
        aprobada: ['pagada', 'rechazada'],
        pagada: [],
        rechazada: ['pendiente'],
      };

      if (!transicionesPermitidas[estadoAnterior].includes(estado)) {
        res.status(400).json({
          success: false,
          message: `No se puede cambiar de "${estadoAnterior}" a "${estado}"`,
        });
        return;
      }

      let updateFields = 'estado = $1, updated_at = CURRENT_TIMESTAMP';
      const params: unknown[] = [estado];
      let paramCount = 1;

      if (estado === 'aprobada') {
        paramCount++;
        updateFields += `, aprobado_por = $${paramCount}, fecha_aprobacion = CURRENT_TIMESTAMP`;
        params.push(req.user!.id);
      }

      if (estado === 'pagada') {
        paramCount++;
        updateFields += `, pagado_por = $${paramCount}, fecha_pago = CURRENT_TIMESTAMP`;
        params.push(req.user!.id);

        const gastoResult = await query<{ id: number }>(
          `
      INSERT INTO project_expenses (project_id, descripcion, monto, fecha, tipo_gasto, created_by)
      VALUES ($1, $2, $3, CURRENT_DATE, 'real', $4)
      RETURNING id
    `,
          [
            requisicion.project_id,
            `Requisición ${requisicion.numero}: ${requisicion.concepto || requisicion.proveedor}`,
            requisicion.monto_total,
            req.user!.id,
          ],
        );

        paramCount++;
        updateFields += `, expense_id = $${paramCount}`;
        params.push(gastoResult.rows[0].id);
      }

      paramCount++;
      params.push(id);

      const result = await query<RequisicionRow>(
        `
    UPDATE requisiciones SET ${updateFields} WHERE id = $${paramCount} RETURNING *
  `,
        params,
      );

      await query(
        `
    INSERT INTO requisiciones_historial (requisicion_id, estado_anterior, estado_nuevo, usuario_id, comentario)
    VALUES ($1, $2, $3, $4, $5)
  `,
        [id, estadoAnterior, estado, req.user!.id, comentario || null],
      );

      res.json({
        success: true,
        message: `Requisición cambiada a "${estado}"`,
        requisicion: result.rows[0],
      });
    },
  ),
);

// Archivar requisición
router.patch(
  '/:id/archivar',
  authenticateToken,
  requireManager,
  [param('id').isInt().withMessage('ID de requisición inválido')],
  asyncHandler(
    async (req: Request<{ id: string }>, res: Response): Promise<void> => {
      const { id } = req.params;

      const existing = await query<RequisicionRow>(
        'SELECT * FROM requisiciones WHERE id = $1',
        [id],
      );
      if (existing.rows.length === 0) {
        res
          .status(404)
          .json({ success: false, message: 'Requisición no encontrada' });
        return;
      }

      if (existing.rows[0].archivada) {
        res.status(400).json({
          success: false,
          message: 'La requisición ya está archivada',
        });
        return;
      }

      await query(
        `
    UPDATE requisiciones SET archivada = TRUE, fecha_archivado = CURRENT_TIMESTAMP, archivado_por = $2 WHERE id = $1
  `,
        [id, req.user!.id],
      );

      await query(
        `
    INSERT INTO requisiciones_historial (requisicion_id, estado_anterior, estado_nuevo, usuario_id, comentario)
    VALUES ($1, $2, 'archivada', $3, 'Requisición archivada')
  `,
        [id, existing.rows[0].estado, req.user!.id],
      );

      res.json({
        success: true,
        message: 'Requisición archivada exitosamente',
      });
    },
  ),
);

// Restaurar requisición archivada
router.patch(
  '/:id/restaurar',
  authenticateToken,
  requireManager,
  [param('id').isInt().withMessage('ID de requisición inválido')],
  asyncHandler(
    async (req: Request<{ id: string }>, res: Response): Promise<void> => {
      const { id } = req.params;

      const existing = await query<RequisicionRow>(
        'SELECT * FROM requisiciones WHERE id = $1',
        [id],
      );
      if (existing.rows.length === 0) {
        res
          .status(404)
          .json({ success: false, message: 'Requisición no encontrada' });
        return;
      }

      if (!existing.rows[0].archivada) {
        res.status(400).json({
          success: false,
          message: 'La requisición no está archivada',
        });
        return;
      }

      await query(
        `
    UPDATE requisiciones SET archivada = FALSE, fecha_archivado = NULL, archivado_por = NULL WHERE id = $1
  `,
        [id],
      );

      res.json({
        success: true,
        message: 'Requisición restaurada exitosamente',
      });
    },
  ),
);

// Eliminar permanentemente
router.delete(
  '/:id',
  authenticateToken,
  requireManager,
  [param('id').isInt().withMessage('ID de requisición inválido')],
  asyncHandler(
    async (req: Request<{ id: string }>, res: Response): Promise<void> => {
      const { id } = req.params;

      const existing = await query<RequisicionRow>(
        'SELECT * FROM requisiciones WHERE id = $1',
        [id],
      );
      if (existing.rows.length === 0) {
        res
          .status(404)
          .json({ success: false, message: 'Requisición no encontrada' });
        return;
      }

      if (!['pendiente', 'rechazada'].includes(existing.rows[0].estado)) {
        res.status(400).json({
          success: false,
          message:
            'Solo se pueden eliminar requisiciones pendientes o rechazadas',
        });
        return;
      }

      // Verificar permisos: admin/co-admin pasan; usuario con requisiciones_editar_todas pasa; sino verificar propiedad
      if (
        req.user?.rol === 'usuario' &&
        !req.user?.permissions?.requisiciones_editar_todas
      ) {
        if (existing.rows[0].solicitante_id !== req.user.id) {
          res.status(403).json({
            success: false,
            message: 'Solo puedes eliminar tus propias requisiciones',
          });
          return;
        }
      }

      await query('DELETE FROM requisiciones WHERE id = $1', [id]);

      res.json({
        success: true,
        message: 'Requisición eliminada permanentemente',
      });
    },
  ),
);

// Buscar items
router.get(
  '/items/search',
  authenticateToken,
  asyncHandler(
    async (
      req: Request<
        object,
        object,
        object,
        { q?: string; project_id?: string; categoria_id?: string }
      >,
      res: Response,
    ): Promise<void> => {
      const { q, project_id, categoria_id } = req.query;

      let whereClause = 'WHERE 1=1';
      const params: unknown[] = [];
      let paramCount = 0;

      if (q) {
        paramCount++;
        whereClause += ` AND ri.descripcion ILIKE $${paramCount}`;
        params.push(`%${q}%`);
      }

      if (project_id) {
        paramCount++;
        whereClause += ` AND r.project_id = $${paramCount}`;
        params.push(project_id);
      }

      if (categoria_id) {
        paramCount++;
        whereClause += ` AND ri.categoria_id = $${paramCount}`;
        params.push(categoria_id);
      }

      const result = await query<
        RequisicionItemRow & {
          requisicion_numero: string;
          proveedor: string;
          requisicion_estado: string;
          requisicion_fecha: Date;
          proyecto_nombre: string;
          proyecto_corto: string;
        }
      >(
        `
    SELECT ri.*, r.numero as requisicion_numero, r.proveedor, r.estado as requisicion_estado,
           r.fecha as requisicion_fecha, p.nombre as proyecto_nombre, p.nombre_corto as proyecto_corto,
           pec.nombre as categoria_nombre
    FROM requisicion_items ri
    JOIN requisiciones r ON ri.requisicion_id = r.id
    LEFT JOIN proyectos p ON r.project_id = p.id
    LEFT JOIN project_expense_categories pec ON ri.categoria_id = pec.id
    ${whereClause}
    ORDER BY r.fecha DESC, ri.id
    LIMIT 100
  `,
        params,
      );

      res.json({ success: true, items: result.rows });
    },
  ),
);

export default router;
