import { Router, Request, Response } from 'express';
import { body, param, validationResult } from 'express-validator';
import multer from 'multer';
import crypto from 'crypto';
import { query, pool } from '../database/config.js';
import { authenticateToken, checkPermission } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { uploadFile, deleteFile, getFileSignedUrl } from '../services/storage.js';
import { registrarAudit } from '../services/auditLog.js';

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
    const { proyectoId } = req.params;

    const result = await query<CajaMenudaRow>(
      `SELECT cm.id, cm.proyecto_id, cm.responsable_id, cm.nombre,
              cm.monto_asignado, cm.estado, cm.created_at,
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
    const { id } = req.params;

    const result = await query<CajaMenudaRow>(
      `SELECT cm.id, cm.proyecto_id, cm.responsable_id, cm.nombre,
              cm.monto_asignado, cm.estado, cm.created_by,
              cm.created_at, cm.updated_at,
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

// POST / — create caja menuda
router.post(
  '/',
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

    await registrarAudit(user.id, 'crear', 'caja_menuda', result.rows[0].id, {
      proyecto_id, responsable_id, nombre, monto_asignado,
    });

    res.status(201).json({ success: true, data: { id: result.rows[0].id } });
  }),
);

// PUT /:id — edit (nombre, responsable_id, estado)
router.put(
  '/:id',
  [
    param('id').isInt(),
    body('nombre').optional().isString().trim().notEmpty(),
    body('responsable_id').optional().isInt(),
    body('estado').optional().isIn(['abierta', 'cerrada']),
  ],
  asyncHandler(async (req: Request<{ id: string }>, res: Response): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, error: 'Datos inválidos', details: errors.array() });
      return;
    }

    const { id } = req.params;
    const { nombre, responsable_id, estado } = req.body;
    const user = req.user!;

    const sets: string[] = ['updated_at = CURRENT_TIMESTAMP'];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (nombre !== undefined) {
      sets.push(`nombre = $${paramIdx++}`);
      params.push(nombre);
    }
    if (responsable_id !== undefined) {
      sets.push(`responsable_id = $${paramIdx++}`);
      params.push(responsable_id);
    }
    if (estado !== undefined) {
      sets.push(`estado = $${paramIdx++}`);
      params.push(estado);
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
    });

    res.json({ success: true, data: { id: Number(id) } });
  }),
);

// PUT /:id/monto — change assigned amount with history (transaction)
router.put(
  '/:id/monto',
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

      await client.query(
        `INSERT INTO cajas_menudas_historial_monto (caja_menuda_id, monto_anterior, monto_nuevo, cambiado_por)
         VALUES ($1, $2, $3, $4)`,
        [id, montoAnterior, monto_asignado, user.id],
      );

      await client.query(
        `UPDATE cajas_menudas SET monto_asignado = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
        [monto_asignado, id],
      );

      await client.query('COMMIT');

      await registrarAudit(user.id, 'editar', 'caja_menuda', Number(id), {
        campo: 'monto_asignado',
        monto_anterior: montoAnterior,
        monto_nuevo: monto_asignado,
      });

      res.json({ success: true, data: { id: Number(id) } });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }),
);
