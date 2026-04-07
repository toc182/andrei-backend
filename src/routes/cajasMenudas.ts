import { Router, Request, Response } from 'express';
import { body, param, validationResult } from 'express-validator';
import multer from 'multer';
import crypto from 'crypto';
import { query, pool } from '../database/config.js';
import { authenticateToken, checkPermission } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { uploadFile, deleteFile, downloadFile, getFileSignedUrl } from '../services/storage.js';
import { registrarAudit } from '../services/auditLog.js';
import { PDFDocument } from 'pdf-lib';
import { generateNumero } from './solicitudesPago.js';

const router = Router();

router.use(authenticateToken, checkPermission('caja_menuda'));

// ─── Interfaces ──────────────────────────────────────────────────────────────

interface CajaMenudaRow {
  id: number;
  proyecto_id: number;
  responsable_id: number;
  nombre: string;
  monto_asignado: string; // NUMERIC comes as string from pg
  estado: string;
  created_by: number;
  created_at: Date;
  updated_at: Date;
  proyecto_nombre?: string;
  responsable_nombre?: string;
  saldo?: string;
  total_gastado?: string;
}

interface GastoRow {
  id: number;
  caja_menuda_id: number;
  fecha: Date;
  proveedor: string;
  descripcion: string;
  monto: string;
  itbms: string;
  monto_total: string;
  solicitud_reembolso_id: number | null;
  registrado_por: number;
  created_at: Date;
  registrado_por_nombre?: string;
}

interface AdjuntoRow {
  id: number;
  caja_menuda_id: number;
  nombre_original: string;
  r2_key: string;
  tipo_mime: string;
  tamano: number;
  subido_por: number;
  created_at: Date;
  subido_por_nombre?: string;
}

// ─── Multer + helper ─────────────────────────────────────────────────────────

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['application/pdf', 'image/jpeg', 'image/png'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Tipo de archivo no permitido. Solo PDF, JPG y PNG.'));
    }
  },
});

function sanitizeFilename(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_');
}

// ─── Endpoints ────────────────────────────────────────────────────────────────

// GET / — list all cajas menudas
router.get(
  '/',
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const user = req.user!;
    const isAdmin = user.rol === 'admin' || user.rol === 'co-admin';

    let whereClause = '';
    const params: unknown[] = [];

    if (!isAdmin) {
      whereClause = `WHERE cm.proyecto_id IN (
        SELECT proyecto_id FROM user_project_access WHERE user_id = $1
      )`;
      params.push(user.id);
    }

    const result = await query<CajaMenudaRow>(
      `SELECT cm.id, cm.proyecto_id, cm.responsable_id, cm.nombre,
              cm.monto_asignado, cm.estado, cm.created_at,
              cm.comprobante_apertura_r2_key IS NOT NULL AS tiene_comprobante_apertura,
              EXISTS (
                SELECT 1 FROM cajas_menudas_historial_monto h
                WHERE h.caja_menuda_id = cm.id
                  AND h.comprobante_r2_key IS NULL
              ) AS historial_sin_comprobante,
              COALESCE(p.nombre_corto, p.nombre) AS proyecto_nombre,
              u.nombre AS responsable_nombre,
              cm.monto_asignado - COALESCE(
                (SELECT SUM(g.monto_total) FROM cajas_menudas_gastos g
                 WHERE g.caja_menuda_id = cm.id AND g.solicitud_reembolso_id IS NULL), 0
              ) AS saldo
       FROM cajas_menudas cm
       JOIN proyectos p ON p.id = cm.proyecto_id
       JOIN users u ON u.id = cm.responsable_id
       ${whereClause}
       ORDER BY cm.created_at DESC`,
      params,
    );

    res.json({ success: true, data: result.rows });
  }),
);

// GET /proyecto/:proyectoId — cajas for a specific project
router.get(
  '/proyecto/:proyectoId',
  [param('proyectoId').isInt()],
  asyncHandler(async (req: Request<{ proyectoId: string }>, res: Response): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, error: 'Datos inválidos', details: errors.array() });
      return;
    }

    const { proyectoId } = req.params;
    const user = req.user!;
    const isAdmin = user.rol === 'admin' || user.rol === 'co-admin';

    // Non-admin users can only see cajas from their assigned projects
    if (!isAdmin) {
      const access = await query(
        'SELECT 1 FROM user_project_access WHERE user_id = $1 AND proyecto_id = $2',
        [user.id, proyectoId],
      );
      if (access.rows.length === 0) {
        res.status(403).json({ success: false, error: 'No tienes acceso a este proyecto' });
        return;
      }
    }

    const result = await query<CajaMenudaRow>(
      `SELECT cm.id, cm.proyecto_id, cm.responsable_id, cm.nombre,
              cm.monto_asignado, cm.estado, cm.created_at,
              cm.comprobante_apertura_r2_key IS NOT NULL AS tiene_comprobante_apertura,
              EXISTS (
                SELECT 1 FROM cajas_menudas_historial_monto h
                WHERE h.caja_menuda_id = cm.id
                  AND h.comprobante_r2_key IS NULL
              ) AS historial_sin_comprobante,
              u.nombre AS responsable_nombre,
              cm.monto_asignado - COALESCE(
                (SELECT SUM(g.monto_total) FROM cajas_menudas_gastos g
                 WHERE g.caja_menuda_id = cm.id AND g.solicitud_reembolso_id IS NULL), 0
              ) AS saldo
       FROM cajas_menudas cm
       JOIN users u ON u.id = cm.responsable_id
       WHERE cm.proyecto_id = $1
       ORDER BY cm.created_at DESC`,
      [proyectoId],
    );

    res.json({ success: true, data: result.rows });
  }),
);

// GET /:id — detail with saldo, total_gastado, historial_montos, and past reembolsos
router.get(
  '/:id',
  [param('id').isInt()],
  asyncHandler(async (req: Request<{ id: string }>, res: Response): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, error: 'Datos inválidos', details: errors.array() });
      return;
    }

    const { id } = req.params;

    const result = await query<CajaMenudaRow>(
      `SELECT cm.id, cm.proyecto_id, cm.responsable_id, cm.nombre,
              cm.monto_asignado, cm.estado, cm.created_by,
              cm.created_at, cm.updated_at,
              cm.comprobante_cierre_r2_key, cm.comprobante_cierre_nombre,
              cm.comprobante_apertura_r2_key, cm.comprobante_apertura_nombre,
              cm.comprobante_apertura_r2_key IS NOT NULL AS tiene_comprobante_apertura,
              EXISTS (
                SELECT 1 FROM cajas_menudas_historial_monto h
                WHERE h.caja_menuda_id = cm.id
                  AND h.comprobante_r2_key IS NULL
              ) AS historial_sin_comprobante,
              COALESCE(p.nombre_corto, p.nombre) AS proyecto_nombre,
              u.nombre AS responsable_nombre,
              cm.monto_asignado - COALESCE(
                (SELECT SUM(g.monto_total) FROM cajas_menudas_gastos g
                 WHERE g.caja_menuda_id = cm.id AND g.solicitud_reembolso_id IS NULL), 0
              ) AS saldo,
              COALESCE(
                (SELECT SUM(g.monto_total) FROM cajas_menudas_gastos g
                 WHERE g.caja_menuda_id = cm.id AND g.solicitud_reembolso_id IS NULL), 0
              ) AS total_gastado
       FROM cajas_menudas cm
       JOIN proyectos p ON p.id = cm.proyecto_id
       JOIN users u ON u.id = cm.responsable_id
       WHERE cm.id = $1`,
      [id],
    );

    if (result.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Caja menuda no encontrada' });
      return;
    }

    const historial = await query(
      `SELECT h.*, u.nombre AS cambiado_por_nombre
       FROM cajas_menudas_historial_monto h
       JOIN users u ON u.id = h.cambiado_por
       WHERE h.caja_menuda_id = $1
       ORDER BY h.created_at DESC`,
      [id],
    );

    const reembolsos = await query(
      `SELECT DISTINCT sp.id, sp.numero, sp.estado, sp.monto_total, sp.created_at
       FROM solicitudes_pago sp
       WHERE sp.id IN (
         SELECT DISTINCT g.solicitud_reembolso_id
         FROM cajas_menudas_gastos g
         WHERE g.caja_menuda_id = $1 AND g.solicitud_reembolso_id IS NOT NULL
       )
       ORDER BY sp.created_at DESC`,
      [id],
    );

    res.json({
      success: true,
      data: {
        ...result.rows[0],
        historial_montos: historial.rows,
        reembolsos: reembolsos.rows,
      },
    });
  }),
);

// POST / — create caja menuda (opening comprobante optional)
router.post(
  '/',
  upload.single('comprobante_apertura'),
  [
    body('proyecto_id').isInt(),
    body('responsable_id').isInt(),
    body('nombre').isString().trim().notEmpty(),
    body('monto_asignado').isFloat({ gt: 0 }),
  ],
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, error: 'Datos inválidos', details: errors.array() });
      return;
    }

    const { proyecto_id, responsable_id, nombre, monto_asignado } = req.body;
    const user = req.user!;

    const result = await query<{ id: number }>(
      `INSERT INTO cajas_menudas (proyecto_id, responsable_id, nombre, monto_asignado, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [proyecto_id, responsable_id, nombre, monto_asignado, user.id],
    );

    const cajaId = result.rows[0].id;

    // Handle optional opening comprobante
    if (req.file) {
      const safeName = sanitizeFilename(req.file.originalname);
      const r2Key = `cajas-menudas/${cajaId}/comprobante-apertura-${crypto.randomUUID()}_${safeName}`;
      await uploadFile(r2Key, req.file.buffer, req.file.mimetype);
      await query(
        `UPDATE cajas_menudas
         SET comprobante_apertura_r2_key = $1, comprobante_apertura_nombre = $2
         WHERE id = $3`,
        [r2Key, req.file.originalname, cajaId],
      );
    }

    await registrarAudit(user.id, 'crear', 'caja_menuda', cajaId, {
      proyecto_id, responsable_id, nombre, monto_asignado,
      con_comprobante_apertura: !!req.file,
    });

    res.status(201).json({ success: true, data: { id: cajaId } });
  }),
);

// PUT /:id — edit (nombre, responsable_id, estado + optional comprobantes)
// Accepts two optional file fields: comprobante_cierre (required when closing
// if the caja has none yet) and comprobante_apertura (always optional, replaces
// the current one if present).
router.put(
  '/:id',
  [param('id').isInt()],
  upload.fields([
    { name: 'comprobante_cierre', maxCount: 1 },
    { name: 'comprobante_apertura', maxCount: 1 },
  ]),
  asyncHandler(async (req: Request<{ id: string }>, res: Response): Promise<void> => {
    const { id } = req.params;
    const { nombre, responsable_id, estado } = req.body;
    const user = req.user!;

    const filesMap = (req.files || {}) as Record<string, Express.Multer.File[]>;
    const cierreFile = filesMap.comprobante_cierre?.[0];
    const aperturaFile = filesMap.comprobante_apertura?.[0];

    // Validate estado value
    if (estado !== undefined && estado !== 'abierta' && estado !== 'cerrada') {
      res.status(400).json({ success: false, error: 'Estado debe ser abierta o cerrada' });
      return;
    }

    // Reject closing if there are pending gastos
    if (estado === 'cerrada') {
      const pendingGastos = await query<{ count: string }>(
        'SELECT COUNT(*)::text as count FROM cajas_menudas_gastos WHERE caja_menuda_id = $1 AND solicitud_reembolso_id IS NULL',
        [id],
      );
      if (Number(pendingGastos.rows[0].count) > 0) {
        res.status(400).json({ success: false, error: 'No se puede cerrar la caja menuda con gastos pendientes de reembolso' });
        return;
      }
    }

    // Require comprobante when closing
    if (estado === 'cerrada' && !cierreFile) {
      // Check if already has comprobante (re-saving without changing estado)
      const existing = await query<{ comprobante_cierre_r2_key: string | null }>(
        'SELECT comprobante_cierre_r2_key FROM cajas_menudas WHERE id = $1',
        [id],
      );
      if (!existing.rows[0]?.comprobante_cierre_r2_key) {
        res.status(400).json({ success: false, error: 'Se requiere un comprobante de cierre' });
        return;
      }
    }

    const sets: string[] = ['updated_at = CURRENT_TIMESTAMP'];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (nombre !== undefined && nombre !== '') {
      sets.push(`nombre = $${paramIdx++}`);
      params.push(nombre);
    }
    if (responsable_id !== undefined && responsable_id !== '') {
      sets.push(`responsable_id = $${paramIdx++}`);
      params.push(Number(responsable_id));
    }
    if (estado !== undefined && estado !== '') {
      sets.push(`estado = $${paramIdx++}`);
      params.push(estado);
    }

    // Handle closing comprobante upload
    if (cierreFile) {
      const safeName = sanitizeFilename(cierreFile.originalname);
      const r2Key = `cajas-menudas/${id}/comprobante-cierre-${crypto.randomUUID()}_${safeName}`;
      await uploadFile(r2Key, cierreFile.buffer, cierreFile.mimetype);

      sets.push(`comprobante_cierre_r2_key = $${paramIdx++}`);
      params.push(r2Key);
      sets.push(`comprobante_cierre_nombre = $${paramIdx++}`);
      params.push(cierreFile.originalname);
    }

    // Handle opening comprobante upload (replaces existing if any)
    if (aperturaFile) {
      // Delete previous opening comprobante from R2 if any
      const previous = await query<{ comprobante_apertura_r2_key: string | null }>(
        'SELECT comprobante_apertura_r2_key FROM cajas_menudas WHERE id = $1',
        [id],
      );
      const prevKey = previous.rows[0]?.comprobante_apertura_r2_key;
      if (prevKey) {
        try {
          await deleteFile(prevKey);
        } catch (err) {
          console.error('Error deleting previous opening comprobante:', prevKey, err);
        }
      }

      const safeName = sanitizeFilename(aperturaFile.originalname);
      const r2Key = `cajas-menudas/${id}/comprobante-apertura-${crypto.randomUUID()}_${safeName}`;
      await uploadFile(r2Key, aperturaFile.buffer, aperturaFile.mimetype);

      sets.push(`comprobante_apertura_r2_key = $${paramIdx++}`);
      params.push(r2Key);
      sets.push(`comprobante_apertura_nombre = $${paramIdx++}`);
      params.push(aperturaFile.originalname);
    }

    params.push(id);

    const result = await query(
      `UPDATE cajas_menudas SET ${sets.join(', ')} WHERE id = $${paramIdx} RETURNING id`,
      params,
    );

    if (result.rowCount === 0) {
      res.status(404).json({ success: false, error: 'Caja menuda no encontrada' });
      return;
    }

    await registrarAudit(user.id, 'editar', 'caja_menuda', Number(id), {
      nombre, responsable_id, estado,
      comprobante_apertura_actualizado: !!aperturaFile,
      comprobante_cierre_actualizado: !!cierreFile,
    });

    res.json({ success: true, data: { id: Number(id) } });
  }),
);

// PUT /:id/monto — change assigned amount with history (transaction).
// Optionally accepts a `comprobante` file that documents the new transfer.
router.put(
  '/:id/monto',
  upload.single('comprobante'),
  [
    param('id').isInt(),
    body('monto_asignado').isFloat({ gt: 0 }),
  ],
  asyncHandler(async (req: Request<{ id: string }>, res: Response): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, error: 'Datos inválidos', details: errors.array() });
      return;
    }

    const { id } = req.params;
    const { monto_asignado } = req.body;
    const user = req.user!;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const current = await client.query<{ monto_asignado: string }>(
        'SELECT monto_asignado FROM cajas_menudas WHERE id = $1 FOR UPDATE',
        [id],
      );

      if (current.rows.length === 0) {
        await client.query('ROLLBACK');
        res.status(404).json({ success: false, error: 'Caja menuda no encontrada' });
        return;
      }

      const montoAnterior = current.rows[0].monto_asignado;

      // Reject no-op amount changes — no historial row should be created for a
      // save that did not actually modify the amount.
      if (Number(montoAnterior) === Number(monto_asignado)) {
        await client.query('ROLLBACK');
        res.status(400).json({
          success: false,
          error: 'El monto asignado no ha cambiado',
        });
        return;
      }

      const historialResult = await client.query<{ id: number }>(
        `INSERT INTO cajas_menudas_historial_monto (caja_menuda_id, monto_anterior, monto_nuevo, cambiado_por)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [id, montoAnterior, monto_asignado, user.id],
      );
      const historialId = historialResult.rows[0].id;

      // Upload the optional comprobante and link it to this historial row
      if (req.file) {
        const safeName = sanitizeFilename(req.file.originalname);
        const r2Key = `cajas-menudas/${id}/historial-monto-${historialId}-${crypto.randomUUID()}_${safeName}`;
        await uploadFile(r2Key, req.file.buffer, req.file.mimetype);
        await client.query(
          `UPDATE cajas_menudas_historial_monto
           SET comprobante_r2_key = $1, comprobante_nombre = $2
           WHERE id = $3`,
          [r2Key, req.file.originalname, historialId],
        );
      }

      await client.query(
        `UPDATE cajas_menudas SET monto_asignado = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
        [monto_asignado, id],
      );

      await client.query('COMMIT');

      await registrarAudit(user.id, 'editar', 'caja_menuda', Number(id), {
        campo: 'monto_asignado',
        monto_anterior: montoAnterior,
        monto_nuevo: monto_asignado,
        con_comprobante: !!req.file,
      });

      res.json({ success: true, data: { id: Number(id), historial_id: historialId } });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }),
);

// GET /:id/gastos — list expenses, optionally filtered by solicitud_reembolso_id
router.get(
  '/:id/gastos',
  [param('id').isInt()],
  asyncHandler(async (req: Request<{ id: string }>, res: Response): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, error: 'Datos inválidos', details: errors.array() });
      return;
    }

    const { id } = req.params;
    const { solicitud_reembolso_id } = req.query;

    let whereClause = 'WHERE g.caja_menuda_id = $1';
    const params: unknown[] = [id];

    if (solicitud_reembolso_id === 'null') {
      whereClause += ' AND g.solicitud_reembolso_id IS NULL';
    } else if (solicitud_reembolso_id) {
      whereClause += ' AND g.solicitud_reembolso_id = $2';
      params.push(solicitud_reembolso_id);
    }

    const result = await query<GastoRow>(
      `SELECT g.*, u.nombre AS registrado_por_nombre
       FROM cajas_menudas_gastos g
       JOIN users u ON u.id = g.registrado_por
       ${whereClause}
       ORDER BY g.fecha DESC, g.id DESC`,
      params,
    );

    res.json({ success: true, data: result.rows });
  }),
);

// POST /:id/gastos — register expense
router.post(
  '/:id/gastos',
  [
    param('id').isInt(),
    body('fecha').isDate(),
    body('proveedor').isString().trim().notEmpty(),
    body('descripcion').isString().trim().notEmpty(),
    body('monto').isFloat({ gt: 0 }),
    body('itbms').optional().isFloat({ min: 0 }),
    body('monto_total').isFloat({ gt: 0 }),
  ],
  asyncHandler(async (req: Request<{ id: string }>, res: Response): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, error: 'Datos inválidos', details: errors.array() });
      return;
    }

    const { id } = req.params;
    const { fecha, proveedor, descripcion, monto, itbms, monto_total } = req.body;
    const user = req.user!;

    // Verify caja exists and is open
    const caja = await query<{ estado: string }>('SELECT estado FROM cajas_menudas WHERE id = $1', [id]);
    if (caja.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Caja menuda no encontrada' });
      return;
    }
    if (caja.rows[0].estado !== 'abierta') {
      res.status(400).json({ success: false, error: 'La caja menuda está cerrada' });
      return;
    }

    const result = await query<{ id: number }>(
      `INSERT INTO cajas_menudas_gastos (caja_menuda_id, fecha, proveedor, descripcion, monto, itbms, monto_total, registrado_por)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [id, fecha, proveedor, descripcion, monto, itbms ?? 0, monto_total, user.id],
    );

    await registrarAudit(user.id, 'crear', 'caja_menuda_gasto', result.rows[0].id, {
      caja_menuda_id: Number(id), proveedor, monto_total,
    });

    res.status(201).json({ success: true, data: { id: result.rows[0].id } });
  }),
);

// PUT /:id/gastos/:gastoId — edit (only if not reimbursed)
router.put(
  '/:id/gastos/:gastoId',
  [
    param('id').isInt(),
    param('gastoId').isInt(),
    body('fecha').optional().isDate(),
    body('proveedor').optional().isString().trim().notEmpty(),
    body('descripcion').optional().isString().trim().notEmpty(),
    body('monto').optional().isFloat({ gt: 0 }),
    body('itbms').optional().isFloat({ min: 0 }),
    body('monto_total').optional().isFloat({ gt: 0 }),
  ],
  asyncHandler(async (req: Request<{ id: string; gastoId: string }>, res: Response): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, error: 'Datos inválidos', details: errors.array() });
      return;
    }

    const { id, gastoId } = req.params;
    const user = req.user!;

    // Verify gasto exists, belongs to this caja, and is not reimbursed
    const gasto = await query<{ solicitud_reembolso_id: number | null }>(
      'SELECT solicitud_reembolso_id FROM cajas_menudas_gastos WHERE id = $1 AND caja_menuda_id = $2',
      [gastoId, id],
    );

    if (gasto.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Gasto no encontrado' });
      return;
    }
    if (gasto.rows[0].solicitud_reembolso_id !== null) {
      res.status(400).json({ success: false, error: 'No se puede editar un gasto ya reembolsado' });
      return;
    }

    const { fecha, proveedor, descripcion, monto, itbms, monto_total } = req.body;

    const sets: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (fecha !== undefined) { sets.push(`fecha = $${paramIdx++}`); params.push(fecha); }
    if (proveedor !== undefined) { sets.push(`proveedor = $${paramIdx++}`); params.push(proveedor); }
    if (descripcion !== undefined) { sets.push(`descripcion = $${paramIdx++}`); params.push(descripcion); }
    if (monto !== undefined) { sets.push(`monto = $${paramIdx++}`); params.push(monto); }
    if (itbms !== undefined) { sets.push(`itbms = $${paramIdx++}`); params.push(itbms); }
    if (monto_total !== undefined) { sets.push(`monto_total = $${paramIdx++}`); params.push(monto_total); }

    if (sets.length === 0) {
      res.status(400).json({ success: false, error: 'No hay campos para actualizar' });
      return;
    }

    params.push(gastoId);

    await query(
      `UPDATE cajas_menudas_gastos SET ${sets.join(', ')} WHERE id = $${paramIdx}`,
      params,
    );

    await registrarAudit(user.id, 'editar', 'caja_menuda_gasto', Number(gastoId), {
      caja_menuda_id: Number(id), campos: Object.keys(req.body),
    });

    res.json({ success: true, data: { id: Number(gastoId) } });
  }),
);

// DELETE /:id/gastos/:gastoId — delete (only if not reimbursed)
router.delete(
  '/:id/gastos/:gastoId',
  [param('id').isInt(), param('gastoId').isInt()],
  asyncHandler(async (req: Request<{ id: string; gastoId: string }>, res: Response): Promise<void> => {
    const { id, gastoId } = req.params;
    const user = req.user!;

    const gasto = await query<{ solicitud_reembolso_id: number | null }>(
      'SELECT solicitud_reembolso_id FROM cajas_menudas_gastos WHERE id = $1 AND caja_menuda_id = $2',
      [gastoId, id],
    );

    if (gasto.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Gasto no encontrado' });
      return;
    }
    if (gasto.rows[0].solicitud_reembolso_id !== null) {
      res.status(400).json({ success: false, error: 'No se puede eliminar un gasto ya reembolsado' });
      return;
    }

    await query('DELETE FROM cajas_menudas_gastos WHERE id = $1', [gastoId]);

    await registrarAudit(user.id, 'eliminar', 'caja_menuda_gasto', Number(gastoId), {
      caja_menuda_id: Number(id),
    });

    res.json({ success: true, message: 'Gasto eliminado' });
  }),
);

// POST /:id/adjuntos — upload file to R2
router.post(
  '/:id/adjuntos',
  [param('id').isInt()],
  upload.single('archivo'),
  asyncHandler(async (req: Request<{ id: string }>, res: Response): Promise<void> => {
    const { id } = req.params;
    const user = req.user!;
    const file = req.file;

    if (!file) {
      res.status(400).json({ success: false, error: 'No se proporcionó archivo' });
      return;
    }

    // Verify caja exists
    const caja = await query<{ id: number }>('SELECT id FROM cajas_menudas WHERE id = $1', [id]);
    if (caja.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Caja menuda no encontrada' });
      return;
    }

    const safeName = sanitizeFilename(file.originalname);
    const r2Key = `cajas-menudas/${id}/${crypto.randomUUID()}_${safeName}`;

    await uploadFile(r2Key, file.buffer, file.mimetype);

    const result = await query<{ id: number }>(
      `INSERT INTO cajas_menudas_adjuntos (caja_menuda_id, nombre_original, r2_key, tipo_mime, tamano, subido_por)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [id, file.originalname, r2Key, file.mimetype, file.size, user.id],
    );

    await registrarAudit(user.id, 'crear', 'caja_menuda_adjunto', result.rows[0].id, {
      caja_menuda_id: Number(id), nombre: file.originalname,
    });

    res.status(201).json({ success: true, data: { id: result.rows[0].id, nombre_original: file.originalname } });
  }),
);

// GET /:id/adjuntos — list adjuntos
router.get(
  '/:id/adjuntos',
  [param('id').isInt()],
  asyncHandler(async (req: Request<{ id: string }>, res: Response): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, error: 'Datos inválidos', details: errors.array() });
      return;
    }

    const { id } = req.params;
    const { solicitud_reembolso_id } = req.query;

    let whereClause = 'WHERE a.caja_menuda_id = $1';
    const params: unknown[] = [id];

    if (solicitud_reembolso_id === 'null') {
      whereClause += ' AND a.solicitud_reembolso_id IS NULL';
    } else if (solicitud_reembolso_id) {
      whereClause += ' AND a.solicitud_reembolso_id = $2';
      params.push(solicitud_reembolso_id);
    }

    const result = await query<AdjuntoRow>(
      `SELECT a.*, u.nombre AS subido_por_nombre
       FROM cajas_menudas_adjuntos a
       JOIN users u ON u.id = a.subido_por
       ${whereClause}
       ORDER BY a.created_at DESC`,
      params,
    );

    res.json({ success: true, data: result.rows });
  }),
);

// GET /:id/adjuntos/:adjuntoId/download — get signed download URL
// GET /:id/comprobante-apertura/download — signed URL for opening comprobante
router.get(
  '/:id/comprobante-apertura/download',
  [param('id').isInt()],
  asyncHandler(async (req: Request<{ id: string }>, res: Response): Promise<void> => {
    const { id } = req.params;
    const result = await query<{ comprobante_apertura_r2_key: string | null; comprobante_apertura_nombre: string | null }>(
      'SELECT comprobante_apertura_r2_key, comprobante_apertura_nombre FROM cajas_menudas WHERE id = $1',
      [id],
    );
    if (result.rows.length === 0 || !result.rows[0].comprobante_apertura_r2_key) {
      res.status(404).json({ success: false, error: 'Comprobante de apertura no encontrado' });
      return;
    }
    const url = await getFileSignedUrl(result.rows[0].comprobante_apertura_r2_key);
    res.json({ success: true, data: { url, nombre: result.rows[0].comprobante_apertura_nombre } });
  }),
);

// GET /:id/comprobante-cierre/download — signed URL for closing comprobante (fixes #34)
router.get(
  '/:id/comprobante-cierre/download',
  [param('id').isInt()],
  asyncHandler(async (req: Request<{ id: string }>, res: Response): Promise<void> => {
    const { id } = req.params;
    const result = await query<{ comprobante_cierre_r2_key: string | null; comprobante_cierre_nombre: string | null }>(
      'SELECT comprobante_cierre_r2_key, comprobante_cierre_nombre FROM cajas_menudas WHERE id = $1',
      [id],
    );
    if (result.rows.length === 0 || !result.rows[0].comprobante_cierre_r2_key) {
      res.status(404).json({ success: false, error: 'Comprobante de cierre no encontrado' });
      return;
    }
    const url = await getFileSignedUrl(result.rows[0].comprobante_cierre_r2_key);
    res.json({ success: true, data: { url, nombre: result.rows[0].comprobante_cierre_nombre } });
  }),
);

// POST /:id/historial-monto/:historialId/comprobante — upload (or replace) a comprobante on an existing historial row
router.post(
  '/:id/historial-monto/:historialId/comprobante',
  upload.single('comprobante'),
  [param('id').isInt(), param('historialId').isInt()],
  asyncHandler(async (req: Request<{ id: string; historialId: string }>, res: Response): Promise<void> => {
    const { id, historialId } = req.params;
    const user = req.user!;

    if (!req.file) {
      res.status(400).json({ success: false, error: 'Archivo requerido' });
      return;
    }

    const existing = await query<{ comprobante_r2_key: string | null }>(
      `SELECT comprobante_r2_key FROM cajas_menudas_historial_monto
       WHERE id = $1 AND caja_menuda_id = $2`,
      [historialId, id],
    );
    if (existing.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Historial no encontrado' });
      return;
    }

    // Delete previous file from R2 if replacing
    const prevKey = existing.rows[0].comprobante_r2_key;
    if (prevKey) {
      try {
        await deleteFile(prevKey);
      } catch (err) {
        console.error('Error deleting previous historial comprobante:', prevKey, err);
      }
    }

    const safeName = sanitizeFilename(req.file.originalname);
    const r2Key = `cajas-menudas/${id}/historial-monto-${historialId}-${crypto.randomUUID()}_${safeName}`;
    await uploadFile(r2Key, req.file.buffer, req.file.mimetype);
    await query(
      `UPDATE cajas_menudas_historial_monto
       SET comprobante_r2_key = $1, comprobante_nombre = $2
       WHERE id = $3`,
      [r2Key, req.file.originalname, historialId],
    );

    await registrarAudit(user.id, 'editar', 'caja_menuda', Number(id), {
      accion: 'comprobante_historial_monto',
      historial_id: Number(historialId),
      nombre: req.file.originalname,
    });

    res.json({ success: true, message: 'Comprobante guardado' });
  }),
);

// GET /:id/historial-monto/:historialId/comprobante/download — signed URL for a historial_monto comprobante
router.get(
  '/:id/historial-monto/:historialId/comprobante/download',
  [param('id').isInt(), param('historialId').isInt()],
  asyncHandler(async (req: Request<{ id: string; historialId: string }>, res: Response): Promise<void> => {
    const { id, historialId } = req.params;
    const result = await query<{ comprobante_r2_key: string | null; comprobante_nombre: string | null }>(
      `SELECT comprobante_r2_key, comprobante_nombre
       FROM cajas_menudas_historial_monto
       WHERE id = $1 AND caja_menuda_id = $2`,
      [historialId, id],
    );
    if (result.rows.length === 0 || !result.rows[0].comprobante_r2_key) {
      res.status(404).json({ success: false, error: 'Comprobante no encontrado' });
      return;
    }
    const url = await getFileSignedUrl(result.rows[0].comprobante_r2_key);
    res.json({ success: true, data: { url, nombre: result.rows[0].comprobante_nombre } });
  }),
);

router.get(
  '/:id/adjuntos/:adjuntoId/download',
  [param('id').isInt(), param('adjuntoId').isInt()],
  asyncHandler(async (req: Request<{ id: string; adjuntoId: string }>, res: Response): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, error: 'Datos inválidos', details: errors.array() });
      return;
    }

    const { id, adjuntoId } = req.params;

    const result = await query<{ r2_key: string; nombre_original: string }>(
      'SELECT r2_key, nombre_original FROM cajas_menudas_adjuntos WHERE id = $1 AND caja_menuda_id = $2',
      [adjuntoId, id],
    );

    if (result.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Adjunto no encontrado' });
      return;
    }

    const url = await getFileSignedUrl(result.rows[0].r2_key);
    res.json({ success: true, data: { url, nombre: result.rows[0].nombre_original } });
  }),
);

// DELETE /:id/adjuntos/:adjuntoId — delete file from R2 + DB
router.delete(
  '/:id/adjuntos/:adjuntoId',
  [param('id').isInt(), param('adjuntoId').isInt()],
  asyncHandler(async (req: Request<{ id: string; adjuntoId: string }>, res: Response): Promise<void> => {
    const { id, adjuntoId } = req.params;
    const user = req.user!;

    const result = await query<{ r2_key: string }>(
      'SELECT r2_key FROM cajas_menudas_adjuntos WHERE id = $1 AND caja_menuda_id = $2',
      [adjuntoId, id],
    );

    if (result.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Adjunto no encontrado' });
      return;
    }

    await deleteFile(result.rows[0].r2_key);
    await query('DELETE FROM cajas_menudas_adjuntos WHERE id = $1', [adjuntoId]);

    await registrarAudit(user.id, 'eliminar', 'caja_menuda_adjunto', Number(adjuntoId), {
      caja_menuda_id: Number(id),
    });

    res.json({ success: true, message: 'Adjunto eliminado' });
  }),
);

// POST /:id/reembolso — generate solicitud de pago from pending expenses
router.post(
  '/:id/reembolso',
  [param('id').isInt()],
  asyncHandler(async (req: Request<{ id: string }>, res: Response): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, error: 'Datos inválidos', details: errors.array() });
      return;
    }

    const { id } = req.params;
    const user = req.user!;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Get caja menuda info
      const cajaResult = await client.query<{ proyecto_id: number; nombre: string; estado: string }>(
        'SELECT proyecto_id, nombre, estado FROM cajas_menudas WHERE id = $1 FOR UPDATE',
        [id],
      );

      if (cajaResult.rows.length === 0) {
        await client.query('ROLLBACK');
        res.status(404).json({ success: false, error: 'Caja menuda no encontrada' });
        return;
      }

      const caja = cajaResult.rows[0];

      if (caja.estado !== 'abierta') {
        await client.query('ROLLBACK');
        res.status(400).json({ success: false, error: 'La caja menuda está cerrada' });
        return;
      }

      // Get pending gastos
      const gastosResult = await client.query<{ monto_total: string; fecha: string }>(
        `SELECT monto_total, fecha FROM cajas_menudas_gastos
         WHERE caja_menuda_id = $1 AND solicitud_reembolso_id IS NULL
         ORDER BY fecha ASC`,
        [id],
      );

      if (gastosResult.rows.length === 0) {
        await client.query('ROLLBACK');
        res.status(400).json({ success: false, error: 'No hay gastos pendientes de reembolso' });
        return;
      }

      // Calculate total and date range
      const total = gastosResult.rows.reduce((sum, g) => sum + Number(g.monto_total), 0);
      const fechaMin = gastosResult.rows[0].fecha;
      const fechaMax = gastosResult.rows[gastosResult.rows.length - 1].fecha;

      const formatFecha = (f: string | Date) => {
        const d = f instanceof Date ? f : new Date(f + 'T00:00:00');
        return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
      };

      // Generate solicitud numero (reembolso → uses M-suffixed sequence)
      let numero: string;
      try {
        numero = await generateNumero(caja.proyecto_id, 'reembolso', client);
      } catch (err) {
        await client.query('ROLLBACK');
        if ((err as Error).message === 'PREFIJO_NO_CONFIGURADO') {
          res.status(400).json({ success: false, error: 'El proyecto no tiene prefijo de solicitud configurado' });
          return;
        }
        throw err;
      }

      // Generate verification code
      const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
      const bytes = crypto.randomBytes(8);
      let codigoVerificacion = '';
      for (let i = 0; i < 8; i++) {
        codigoVerificacion += chars[bytes[i] % chars.length];
      }

      // Create solicitud de pago
      const descripcionItem = `Reembolso de caja menuda ${caja.nombre} — ${formatFecha(fechaMin)} a ${formatFecha(fechaMax)}`;

      const solicitudResult = await client.query<{ id: number }>(
        `INSERT INTO solicitudes_pago (
          proyecto_id, numero, fecha, proveedor, preparado_por,
          subtotal, descuentos, impuestos, monto_total,
          estado, observaciones, codigo_verificacion, tipo
        ) VALUES ($1, $2, CURRENT_DATE, $3, $4, $5, 0, 0, $5, 'pendiente', $6, $7, 'reembolso')
        RETURNING id`,
        [
          caja.proyecto_id,
          numero,
          `Reembolso Caja Menuda - ${caja.nombre}`,
          user.id,
          total,
          descripcionItem,
          codigoVerificacion,
        ],
      );

      const solicitudId = solicitudResult.rows[0].id;

      // Create single item
      await client.query(
        `INSERT INTO solicitud_pago_items (solicitud_pago_id, descripcion, cantidad, precio_unitario, precio_total, orden)
         VALUES ($1, $2, 1, $3, $3, 0)`,
        [solicitudId, descripcionItem, total],
      );

      // Link pending gastos to the new solicitud
      await client.query(
        `UPDATE cajas_menudas_gastos SET solicitud_reembolso_id = $1
         WHERE caja_menuda_id = $2 AND solicitud_reembolso_id IS NULL`,
        [solicitudId, id],
      );

      // Get pending adjuntos (for merge later) and mark them as linked
      const pendingAdjuntos = await client.query<{
        nombre_original: string; r2_key: string; tipo_mime: string; tamano: number;
      }>(
        `SELECT nombre_original, r2_key, tipo_mime, tamano
         FROM cajas_menudas_adjuntos
         WHERE caja_menuda_id = $1 AND solicitud_reembolso_id IS NULL`,
        [id],
      );

      // Mark adjuntos as linked to this reembolso
      await client.query(
        `UPDATE cajas_menudas_adjuntos SET solicitud_reembolso_id = $1
         WHERE caja_menuda_id = $2 AND solicitud_reembolso_id IS NULL`,
        [solicitudId, id],
      );

      await client.query('COMMIT');

      // Merge adjuntos into a single PDF (outside transaction — non-critical)
      if (pendingAdjuntos.rows.length > 0) {
        try {
          const mergedPdf = await PDFDocument.create();

          for (const adj of pendingAdjuntos.rows) {
            try {
              const fileBuffer = await downloadFile(adj.r2_key);

              if (adj.tipo_mime === 'application/pdf') {
                const attachedPdf = await PDFDocument.load(fileBuffer);
                const pages = await mergedPdf.copyPages(attachedPdf, attachedPdf.getPageIndices());
                for (const page of pages) {
                  mergedPdf.addPage(page);
                }
              } else if (adj.tipo_mime === 'image/jpeg' || adj.tipo_mime === 'image/png') {
                const img = adj.tipo_mime === 'image/jpeg'
                  ? await mergedPdf.embedJpg(fileBuffer)
                  : await mergedPdf.embedPng(fileBuffer);

                const pageW = 612;
                const pageH = 792;
                const margin = 40;
                const maxW = pageW - margin * 2;
                const maxH = pageH - margin * 2;
                const scale = Math.min(maxW / img.width, maxH / img.height, 1);
                const drawW = img.width * scale;
                const drawH = img.height * scale;

                const page = mergedPdf.addPage([pageW, pageH]);
                page.drawImage(img, {
                  x: (pageW - drawW) / 2,
                  y: (pageH - drawH) / 2,
                  width: drawW,
                  height: drawH,
                });
              }
            } catch (err) {
              console.error(`Error procesando adjunto ${adj.nombre_original}:`, err);
            }
          }

          if (mergedPdf.getPageCount() > 0) {
            const pdfBytes = await mergedPdf.save();
            const pdfBuffer = Buffer.from(pdfBytes);
            const mergedKey = `cajas-menudas/${id}/reembolso-${solicitudId}-adjuntos.pdf`;

            await uploadFile(mergedKey, pdfBuffer, 'application/pdf');

            await query(
              `INSERT INTO solicitud_pago_adjuntos (solicitud_pago_id, nombre_original, r2_key, tipo_mime, tamano, subido_por)
               VALUES ($1, $2, $3, 'application/pdf', $4, $5)`,
              [solicitudId, `Adjuntos Caja Menuda - ${caja.nombre}.pdf`, mergedKey, pdfBuffer.length, user.id],
            );
          }
        } catch (err) {
          console.error('Error generando PDF consolidado de adjuntos:', err);
        }
      }

      await registrarAudit(user.id, 'crear', 'caja_menuda_reembolso', solicitudId, {
        caja_menuda_id: Number(id),
        monto_total: total,
        gastos_count: gastosResult.rows.length,
        numero,
      });

      res.status(201).json({
        success: true,
        data: {
          solicitud_id: solicitudId,
          numero,
          monto_total: total,
          gastos_count: gastosResult.rows.length,
        },
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }),
);

export default router;
