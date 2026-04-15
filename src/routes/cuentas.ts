import { Router, Request, Response } from 'express';
import { body, param, validationResult } from 'express-validator';
import multer from 'multer';
import crypto from 'crypto';
import { query, pool } from '../database/config.js';
import { authenticateToken, checkPermission } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { uploadFile, deleteFile, downloadFile } from '../services/storage.js';
import { registrarAudit } from '../services/auditLog.js';

const router = Router();
router.use(authenticateToken, checkPermission('cuentas'));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

const sanitizeFilename = (name: string): string =>
  name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);

// Transiciones permitidas por tipo de flujo (solo privado en Phase 1).
const TRANSICIONES_PRIVADO: Record<string, string[]> = {
  borrador: ['enviada'],
  enviada: ['observaciones', 'aprobada'],
  observaciones: ['enviada'],
  aprobada: ['pagada'],
  pagada: [],
};

interface CuentaRow {
  id: number;
  proyecto_id: number;
  numero: number;
  es_final: boolean;
  monto_total: string;
  periodo_inicio: string | null;
  periodo_fin: string | null;
  avance_porcentaje: string | null;
  estado: string;
  fecha_primera_submision: string | null;
  fecha_ultima_resubmision: string | null;
  fecha_pagada: string | null;
  observaciones_pago: string | null;
  active: boolean;
  created_by: number;
  created_at: Date;
  updated_at: Date;
}

async function userCanAccessProject(
  userId: number,
  rol: string,
  proyectoId: number,
): Promise<boolean> {
  if (rol === 'admin' || rol === 'co-admin') return true;
  const r = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM user_project_access
     WHERE user_id = $1 AND proyecto_id = $2`,
    [userId, proyectoId],
  );
  return Number(r.rows[0].count) > 0;
}

// GET / — lista de cuentas. Filtros: proyecto_id, estado, active.
router.get(
  '/',
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const user = req.user!;
    const { proyecto_id, estado, active } = req.query as Record<string, string>;

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (proyecto_id) {
      params.push(Number(proyecto_id));
      conditions.push(`c.proyecto_id = $${params.length}`);
    }
    if (estado) {
      params.push(estado);
      conditions.push(`c.estado = $${params.length}`);
    }
    if (active === undefined || active === 'true') {
      conditions.push(`c.active = TRUE`);
    } else if (active === 'false') {
      conditions.push(`c.active = FALSE`);
    }

    // Restringir por acceso a proyecto si no es admin/co-admin.
    if (user.rol !== 'admin' && user.rol !== 'co-admin') {
      params.push(user.id);
      conditions.push(
        `c.proyecto_id IN (SELECT proyecto_id FROM user_project_access WHERE user_id = $${params.length})`,
      );
    }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const result = await query(
      `SELECT c.*, p.nombre AS proyecto_nombre, p.tipo AS proyecto_tipo, p.tiene_ipt AS proyecto_tiene_ipt
       FROM cuentas c
       JOIN proyectos p ON p.id = c.proyecto_id
       ${where}
       ORDER BY c.created_at DESC`,
      params,
    );

    res.json({ success: true, data: result.rows });
  }),
);

// GET /:id — detalle con eventos y adjuntos.
router.get(
  '/:id',
  [param('id').isInt()],
  asyncHandler(
    async (req: Request<{ id: string }>, res: Response): Promise<void> => {
      const user = req.user!;
      const id = Number(req.params.id);

      const cuentaRes = await query<CuentaRow & { proyecto_nombre: string; proyecto_tipo: string; proyecto_tiene_ipt: boolean }>(
        `SELECT c.*, p.nombre AS proyecto_nombre, p.tipo AS proyecto_tipo, p.tiene_ipt AS proyecto_tiene_ipt
         FROM cuentas c
         JOIN proyectos p ON p.id = c.proyecto_id
         WHERE c.id = $1`,
        [id],
      );
      if (cuentaRes.rows.length === 0) {
        res.status(404).json({ success: false, error: 'Cuenta no encontrada' });
        return;
      }
      const cuenta = cuentaRes.rows[0];

      if (!(await userCanAccessProject(user.id, user.rol, cuenta.proyecto_id))) {
        res.status(403).json({ success: false, error: 'Sin acceso al proyecto' });
        return;
      }

      const eventos = await query(
        `SELECT e.*, u.nombre AS creado_por_nombre
         FROM cuentas_eventos e
         JOIN users u ON u.id = e.creado_por
         WHERE e.cuenta_id = $1
         ORDER BY e.created_at ASC`,
        [id],
      );

      const adjuntos = await query(
        `SELECT a.*, u.nombre AS subido_por_nombre
         FROM cuentas_adjuntos a
         JOIN users u ON u.id = a.subido_por
         WHERE a.cuenta_id = $1
         ORDER BY a.created_at ASC`,
        [id],
      );

      res.json({
        success: true,
        data: {
          ...cuenta,
          eventos: eventos.rows,
          adjuntos: adjuntos.rows,
        },
      });
    },
  ),
);

// POST / — crear cuenta.
router.post(
  '/',
  [
    body('proyecto_id').isInt(),
    body('monto_total').isFloat({ gt: 0 }),
    body('periodo_inicio').optional().isISO8601(),
    body('periodo_fin').optional().isISO8601(),
    body('avance_porcentaje').optional().isFloat({ min: 0, max: 100 }),
    body('es_final').optional().isBoolean(),
  ],
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, error: 'Datos inválidos', details: errors.array() });
      return;
    }

    const user = req.user!;
    const {
      proyecto_id,
      monto_total,
      periodo_inicio,
      periodo_fin,
      avance_porcentaje,
      es_final,
    } = req.body;

    if (!(await userCanAccessProject(user.id, user.rol, proyecto_id))) {
      res.status(403).json({ success: false, error: 'Sin acceso al proyecto' });
      return;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const nextRes = await client.query<{ max: number | null }>(
        `SELECT MAX(numero) AS max FROM cuentas WHERE proyecto_id = $1`,
        [proyecto_id],
      );
      const numero = (nextRes.rows[0].max ?? 0) + 1;

      const insert = await client.query<{ id: number }>(
        `INSERT INTO cuentas (
          proyecto_id, numero, es_final, monto_total,
          periodo_inicio, periodo_fin, avance_porcentaje,
          estado, created_by
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'borrador', $8)
        RETURNING id`,
        [
          proyecto_id,
          numero,
          !!es_final,
          monto_total,
          periodo_inicio || null,
          periodo_fin || null,
          avance_porcentaje ?? null,
          user.id,
        ],
      );

      await client.query('COMMIT');

      await registrarAudit(user.id, 'crear', 'cuenta', insert.rows[0].id, {
        proyecto_id,
        numero,
        es_final: !!es_final,
        monto_total,
      });

      res.status(201).json({ success: true, data: { id: insert.rows[0].id, numero } });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }),
);

// PUT /:id — editar header (solo en borrador).
router.put(
  '/:id',
  [
    param('id').isInt(),
    body('monto_total').optional().isFloat({ gt: 0 }),
    body('periodo_inicio').optional({ nullable: true }).isISO8601(),
    body('periodo_fin').optional({ nullable: true }).isISO8601(),
    body('avance_porcentaje').optional({ nullable: true }).isFloat({ min: 0, max: 100 }),
    body('es_final').optional().isBoolean(),
  ],
  asyncHandler(
    async (req: Request<{ id: string }>, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({ success: false, error: 'Datos inválidos' });
        return;
      }

      const user = req.user!;
      const id = Number(req.params.id);

      const cur = await query<CuentaRow>(
        'SELECT * FROM cuentas WHERE id = $1 AND active = TRUE',
        [id],
      );
      if (cur.rows.length === 0) {
        res.status(404).json({ success: false, error: 'Cuenta no encontrada' });
        return;
      }
      const cuenta = cur.rows[0];
      if (!(await userCanAccessProject(user.id, user.rol, cuenta.proyecto_id))) {
        res.status(403).json({ success: false, error: 'Sin acceso al proyecto' });
        return;
      }
      if (cuenta.estado !== 'borrador') {
        res.status(400).json({
          success: false,
          error: 'Solo se puede editar una cuenta en borrador',
        });
        return;
      }

      const sets: string[] = [];
      const params: unknown[] = [];
      const fields = [
        'monto_total',
        'periodo_inicio',
        'periodo_fin',
        'avance_porcentaje',
        'es_final',
      ] as const;
      for (const f of fields) {
        if (f in req.body) {
          params.push(req.body[f]);
          sets.push(`${f} = $${params.length}`);
        }
      }
      if (sets.length === 0) {
        res.status(400).json({ success: false, error: 'Nada que actualizar' });
        return;
      }
      params.push(id);
      await query(
        `UPDATE cuentas SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $${params.length}`,
        params,
      );

      await registrarAudit(user.id, 'editar', 'cuenta', id, req.body);
      res.json({ success: true });
    },
  ),
);

// POST /:id/transicion — transición de estado.
router.post(
  '/:id/transicion',
  [
    param('id').isInt(),
    body('estado_hacia').isString().notEmpty(),
    body('comentario').optional({ nullable: true }).isString(),
  ],
  asyncHandler(
    async (req: Request<{ id: string }>, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({ success: false, error: 'Datos inválidos' });
        return;
      }

      const user = req.user!;
      const id = Number(req.params.id);
      const { estado_hacia, comentario } = req.body as {
        estado_hacia: string;
        comentario?: string;
      };

      const cur = await query<CuentaRow>(
        'SELECT * FROM cuentas WHERE id = $1 AND active = TRUE',
        [id],
      );
      if (cur.rows.length === 0) {
        res.status(404).json({ success: false, error: 'Cuenta no encontrada' });
        return;
      }
      const cuenta = cur.rows[0];
      if (!(await userCanAccessProject(user.id, user.rol, cuenta.proyecto_id))) {
        res.status(403).json({ success: false, error: 'Sin acceso al proyecto' });
        return;
      }

      const permitidos = TRANSICIONES_PRIVADO[cuenta.estado] || [];
      if (!permitidos.includes(estado_hacia)) {
        res.status(400).json({
          success: false,
          error: `Transición no permitida: "${cuenta.estado}" → "${estado_hacia}"`,
        });
        return;
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const sets: string[] = ['estado = $1', 'updated_at = CURRENT_TIMESTAMP'];
        const params: unknown[] = [estado_hacia];

        if (cuenta.estado === 'borrador' && estado_hacia === 'enviada') {
          params.push();
          sets.push(`fecha_primera_submision = CURRENT_DATE`);
        }
        if (cuenta.estado === 'observaciones' && estado_hacia === 'enviada') {
          sets.push(`fecha_ultima_resubmision = CURRENT_DATE`);
        }
        if (estado_hacia === 'pagada') {
          sets.push(`fecha_pagada = CURRENT_DATE`);
          if (comentario) {
            params.push(comentario);
            sets.push(`observaciones_pago = $${params.length}`);
          }
        }

        params.push(id);
        await client.query(
          `UPDATE cuentas SET ${sets.join(', ')} WHERE id = $${params.length}`,
          params,
        );

        await client.query(
          `INSERT INTO cuentas_eventos (cuenta_id, tipo, estado_desde, estado_hacia, comentario, creado_por)
           VALUES ($1, 'transicion', $2, $3, $4, $5)`,
          [id, cuenta.estado, estado_hacia, comentario || null, user.id],
        );

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      await registrarAudit(user.id, 'transicion', 'cuenta', id, {
        estado_desde: cuenta.estado,
        estado_hacia,
        comentario: comentario || null,
      });

      res.json({ success: true });
    },
  ),
);

// POST /:id/comentario — comentario suelto (sin cambio de estado).
router.post(
  '/:id/comentario',
  [param('id').isInt(), body('comentario').isString().notEmpty()],
  asyncHandler(
    async (req: Request<{ id: string }>, res: Response): Promise<void> => {
      const user = req.user!;
      const id = Number(req.params.id);
      const { comentario } = req.body as { comentario: string };

      const cur = await query<CuentaRow>(
        'SELECT * FROM cuentas WHERE id = $1 AND active = TRUE',
        [id],
      );
      if (cur.rows.length === 0) {
        res.status(404).json({ success: false, error: 'Cuenta no encontrada' });
        return;
      }
      if (!(await userCanAccessProject(user.id, user.rol, cur.rows[0].proyecto_id))) {
        res.status(403).json({ success: false, error: 'Sin acceso al proyecto' });
        return;
      }

      await query(
        `INSERT INTO cuentas_eventos (cuenta_id, tipo, comentario, creado_por)
         VALUES ($1, 'comentario', $2, $3)`,
        [id, comentario, user.id],
      );

      await registrarAudit(user.id, 'comentario', 'cuenta', id, { comentario });
      res.json({ success: true });
    },
  ),
);

// POST /:id/adjuntos — subir archivo.
router.post(
  '/:id/adjuntos',
  upload.single('file'),
  [param('id').isInt()],
  asyncHandler(
    async (req: Request<{ id: string }>, res: Response): Promise<void> => {
      const user = req.user!;
      const id = Number(req.params.id);

      if (!req.file) {
        res.status(400).json({ success: false, error: 'Archivo requerido' });
        return;
      }

      const cur = await query<CuentaRow>(
        'SELECT * FROM cuentas WHERE id = $1 AND active = TRUE',
        [id],
      );
      if (cur.rows.length === 0) {
        res.status(404).json({ success: false, error: 'Cuenta no encontrada' });
        return;
      }
      if (!(await userCanAccessProject(user.id, user.rol, cur.rows[0].proyecto_id))) {
        res.status(403).json({ success: false, error: 'Sin acceso al proyecto' });
        return;
      }

      const safeName = sanitizeFilename(req.file.originalname);
      const r2Key = `cuentas/${id}/${crypto.randomUUID()}_${safeName}`;
      await uploadFile(r2Key, req.file.buffer, req.file.mimetype);

      const ins = await query<{ id: number }>(
        `INSERT INTO cuentas_adjuntos (cuenta_id, nombre_original, r2_key, tipo_mime, tamano, subido_por)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [id, req.file.originalname, r2Key, req.file.mimetype, req.file.size, user.id],
      );

      await registrarAudit(user.id, 'adjuntar', 'cuenta', id, {
        adjunto_id: ins.rows[0].id,
        nombre: req.file.originalname,
      });

      res.json({ success: true, data: { id: ins.rows[0].id } });
    },
  ),
);

// GET /:id/adjuntos/:adjuntoId/download
router.get(
  '/:id/adjuntos/:adjuntoId/download',
  [param('id').isInt(), param('adjuntoId').isInt()],
  asyncHandler(
    async (
      req: Request<{ id: string; adjuntoId: string }>,
      res: Response,
    ): Promise<void> => {
      const user = req.user!;
      const id = Number(req.params.id);
      const adjuntoId = Number(req.params.adjuntoId);

      const r = await query<{
        r2_key: string;
        tipo_mime: string;
        nombre_original: string;
        proyecto_id: number;
      }>(
        `SELECT a.r2_key, a.tipo_mime, a.nombre_original, c.proyecto_id
         FROM cuentas_adjuntos a
         JOIN cuentas c ON c.id = a.cuenta_id
         WHERE a.id = $1 AND a.cuenta_id = $2`,
        [adjuntoId, id],
      );
      if (r.rows.length === 0) {
        res.status(404).json({ success: false, error: 'Adjunto no encontrado' });
        return;
      }
      if (!(await userCanAccessProject(user.id, user.rol, r.rows[0].proyecto_id))) {
        res.status(403).json({ success: false, error: 'Sin acceso al proyecto' });
        return;
      }

      const buffer = await downloadFile(r.rows[0].r2_key);
      res.setHeader('Content-Type', r.rows[0].tipo_mime);
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${encodeURIComponent(r.rows[0].nombre_original)}"`,
      );
      res.send(buffer);
    },
  ),
);

// DELETE /:id/adjuntos/:adjuntoId
router.delete(
  '/:id/adjuntos/:adjuntoId',
  [param('id').isInt(), param('adjuntoId').isInt()],
  asyncHandler(
    async (
      req: Request<{ id: string; adjuntoId: string }>,
      res: Response,
    ): Promise<void> => {
      const user = req.user!;
      const id = Number(req.params.id);
      const adjuntoId = Number(req.params.adjuntoId);

      const r = await query<{ r2_key: string; proyecto_id: number }>(
        `SELECT a.r2_key, c.proyecto_id
         FROM cuentas_adjuntos a
         JOIN cuentas c ON c.id = a.cuenta_id
         WHERE a.id = $1 AND a.cuenta_id = $2`,
        [adjuntoId, id],
      );
      if (r.rows.length === 0) {
        res.status(404).json({ success: false, error: 'Adjunto no encontrado' });
        return;
      }
      if (!(await userCanAccessProject(user.id, user.rol, r.rows[0].proyecto_id))) {
        res.status(403).json({ success: false, error: 'Sin acceso al proyecto' });
        return;
      }

      try {
        await deleteFile(r.rows[0].r2_key);
      } catch {
        /* ignorar error de R2; continuar con borrado en DB */
      }
      await query('DELETE FROM cuentas_adjuntos WHERE id = $1', [adjuntoId]);

      await registrarAudit(user.id, 'eliminar_adjunto', 'cuenta', id, {
        adjunto_id: adjuntoId,
      });
      res.json({ success: true });
    },
  ),
);

// DELETE /:id — soft delete (solo en borrador).
router.delete(
  '/:id',
  [param('id').isInt()],
  asyncHandler(
    async (req: Request<{ id: string }>, res: Response): Promise<void> => {
      const user = req.user!;
      const id = Number(req.params.id);

      const cur = await query<CuentaRow>(
        'SELECT * FROM cuentas WHERE id = $1 AND active = TRUE',
        [id],
      );
      if (cur.rows.length === 0) {
        res.status(404).json({ success: false, error: 'Cuenta no encontrada' });
        return;
      }
      const cuenta = cur.rows[0];
      if (!(await userCanAccessProject(user.id, user.rol, cuenta.proyecto_id))) {
        res.status(403).json({ success: false, error: 'Sin acceso al proyecto' });
        return;
      }
      if (cuenta.estado !== 'borrador') {
        res.status(400).json({
          success: false,
          error: 'Solo se pueden eliminar cuentas en borrador',
        });
        return;
      }
      await query(
        'UPDATE cuentas SET active = FALSE, updated_at = CURRENT_TIMESTAMP WHERE id = $1',
        [id],
      );
      await registrarAudit(user.id, 'eliminar', 'cuenta', id, {});
      res.json({ success: true });
    },
  ),
);

export default router;
