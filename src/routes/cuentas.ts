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

// Transiciones permitidas por tipo de flujo.
const TRANSICIONES: Record<string, Record<string, string[]>> = {
  privado: {
    borrador: ['enviada'],
    enviada: ['observaciones', 'aprobada'],
    observaciones: ['enviada'],
    aprobada: ['pagada'],
    pagada: [],
  },
  publico_normal: {
    borrador: ['enviada_institucion'],
    enviada_institucion: ['observaciones_institucion', 'aprobada_institucion'],
    observaciones_institucion: ['enviada_institucion'],
    aprobada_institucion: ['enviada_contraloria'],
    enviada_contraloria: ['observaciones_contraloria', 'aprobada_contraloria'],
    observaciones_contraloria: ['enviada_contraloria'],
    aprobada_contraloria: ['pagada'],
    pagada: [],
  },
  publico_ipt: {
    borrador: ['enviada_institucion'],
    enviada_institucion: ['observaciones_institucion', 'aprobada_institucion'],
    observaciones_institucion: ['enviada_institucion'],
    // Aprobada por institución puede regresar a observaciones si el IPT
    // recibe feedback de Contraloría/MEF que obliga a ajustar la cuenta.
    aprobada_institucion: ['observaciones_institucion', 'pagada'],
    pagada: [],
  },
};

function getFlow(proyectoTipo: string, tieneIpt: boolean): string {
  if (proyectoTipo === 'privado') return 'privado';
  // proyectoTipo === 'estado' (government/public) or legacy 'publico'
  if (tieneIpt) return 'publico_ipt';
  return 'publico_normal';
}

async function iptIsAprobado(cuentaId: number): Promise<boolean> {
  const r = await query<{ estado: string }>(
    'SELECT estado FROM cuentas_ipt WHERE cuenta_id = $1 AND activo = true',
    [cuentaId],
  );
  return r.rows.length > 0 && r.rows[0].estado === 'aprobado';
}

function isEnviadaEstado(estado: string): boolean {
  return estado === 'enviada' || estado === 'enviada_institucion' || estado === 'enviada_contraloria';
}
function isObservacionesEstado(estado: string): boolean {
  return (
    estado === 'observaciones' ||
    estado === 'observaciones_institucion' ||
    estado === 'observaciones_contraloria'
  );
}

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
  activo: boolean;
  creado_por: number;
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

// GET /resumen — project-level aggregation for the general view.
// Returns one entry per project with: current cuenta, pending cuentas, accumulated avance, etc.
router.get(
  '/resumen',
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const user = req.user!;

    // Get all projects with active cuentas that the user can access
    const accessFilter =
      user.rol === 'admin' || user.rol === 'co-admin'
        ? ''
        : `AND p.id IN (SELECT proyecto_id FROM user_project_access WHERE user_id = ${Number(user.id)})`;

    const projects = await query<{
      proyecto_id: number;
      proyecto_nombre: string;
      proyecto_nombre_corto: string | null;
      cliente_nombre: string | null;
      cliente_abreviatura: string | null;
      cliente_tipo: string | null;
      tiene_ipt: boolean;
      fecha_inicio: string | null;
    }>(
      `SELECT DISTINCT p.id AS proyecto_id, p.nombre AS proyecto_nombre, p.nombre_corto AS proyecto_nombre_corto,
              cl.nombre AS cliente_nombre, cl.abreviatura AS cliente_abreviatura, cl.tipo AS cliente_tipo,
              p.tiene_ipt,
              TO_CHAR(p.fecha_inicio, 'YYYY-MM-DD') AS fecha_inicio
       FROM cuentas c
       JOIN proyectos p ON p.id = c.proyecto_id
       LEFT JOIN clientes cl ON cl.id = p.cliente_id
       WHERE c.activo = TRUE ${accessFilter}
       ORDER BY p.nombre`,
      [],
    );

    if (projects.rows.length === 0) {
      res.json({ success: true, data: [] });
      return;
    }

    const projectIds = projects.rows.map((p) => p.proyecto_id);

    // Get all active cuentas for these projects
    const cuentas = await query<CuentaRow & { proyecto_id: number }>(
      `SELECT c.*
       FROM cuentas c
       WHERE c.proyecto_id = ANY($1) AND c.activo = TRUE
       ORDER BY c.numero ASC`,
      [projectIds],
    );

    // Group cuentas by project
    const cuentasByProject = new Map<number, (CuentaRow & { proyecto_id: number })[]>();
    for (const c of cuentas.rows) {
      if (!cuentasByProject.has(c.proyecto_id)) cuentasByProject.set(c.proyecto_id, []);
      cuentasByProject.get(c.proyecto_id)!.push(c);
    }

    const PAGADA_STATES = ['pagada'];
    const PENDING_STATES = [
      'enviada', 'observaciones', 'aprobada',
      'enviada_institucion', 'observaciones_institucion', 'aprobada_institucion',
      'enviada_contraloria', 'observaciones_contraloria', 'aprobada_contraloria',
    ];

    const result = projects.rows.map((proj) => {
      const allCuentas = cuentasByProject.get(proj.proyecto_id) || [];
      const sorted = [...allCuentas].sort((a, b) => a.numero - b.numero);

      // Pending: submitted but not paid
      const pendientes = sorted.filter((c) => PENDING_STATES.includes(c.estado));

      // Current: first cuenta not yet submitted (borrador or no-iniciada concept)
      // = the one after the last submitted/paid cuenta, OR the first if none submitted
      const lastSubmittedIdx = sorted.reduce(
        (max, c, i) => (c.estado !== 'borrador' ? i : max),
        -1,
      );
      const currentCuenta = lastSubmittedIdx < sorted.length - 1
        ? sorted[lastSubmittedIdx + 1]
        : null;

      // Pagadas
      const pagadas = sorted.filter((c) => PAGADA_STATES.includes(c.estado));

      // Avance from previous cuentas (sum of all before current)
      const currentIdx = currentCuenta
        ? sorted.findIndex((c) => c.id === currentCuenta.id)
        : sorted.length;
      const avancePrevio = sorted
        .slice(0, currentIdx)
        .reduce((sum, c) => sum + (c.avance_porcentaje ? Number(c.avance_porcentaje) : 0), 0);

      // Accumulated avance: sum of all cuentas including current
      const avanceAcum = sorted.reduce((sum, c) => {
        const v = c.avance_porcentaje ? Number(c.avance_porcentaje) : 0;
        return sum + v;
      }, 0);

      // Days since project started
      const diasInicio = proj.fecha_inicio
        ? Math.floor((Date.now() - new Date(proj.fecha_inicio).getTime()) / 86400000)
        : null;

      // Days since last submittal
      const lastSubmitDate = sorted
        .filter((c) => c.fecha_primera_submision)
        .reduce((latest: string | null, c) => {
          if (!latest) return c.fecha_primera_submision;
          return c.fecha_primera_submision! > latest ? c.fecha_primera_submision! : latest;
        }, null);
      const diasUltimoEnvio = lastSubmitDate
        ? Math.floor((Date.now() - new Date(lastSubmitDate).getTime()) / 86400000)
        : null;

      return {
        proyecto_id: proj.proyecto_id,
        proyecto_nombre: proj.proyecto_nombre,
        proyecto_nombre_corto: proj.proyecto_nombre_corto,
        cliente_nombre: proj.cliente_nombre,
        cliente_abreviatura: proj.cliente_abreviatura,
        cliente_tipo: proj.cliente_tipo,
        tiene_ipt: proj.tiene_ipt,
        avance_acumulado: avanceAcum,
        avance_previo: avancePrevio,
        dias_inicio: diasInicio,
        dias_ultimo_envio: diasUltimoEnvio,
        cuenta_actual: currentCuenta,
        pendientes: pendientes.map((c) => {
          const idx = sorted.findIndex((s) => s.id === c.id);
          const prevAvance = sorted
            .slice(0, idx)
            .reduce((sum, s) => sum + (s.avance_porcentaje ? Number(s.avance_porcentaje) : 0), 0);
          return {
            id: c.id,
            numero: c.numero,
            estado: c.estado,
            monto_total: c.monto_total,
            periodo_inicio: c.periodo_inicio,
            periodo_fin: c.periodo_fin,
            avance_porcentaje: c.avance_porcentaje,
            avance_previo: prevAvance,
            fecha_primera_submision: c.fecha_primera_submision,
          };
        }),
        pagadas: pagadas.length,
        total_cuentas: allCuentas.length,
        all_paid: pagadas.length === allCuentas.length && allCuentas.length > 0,
      };
    });

    res.json({ success: true, data: result });
  }),
);

// GET / — lista de cuentas. Filtros: proyecto_id, estado, activo.
router.get(
  '/',
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const user = req.user!;
    const { proyecto_id, estado, activo } = req.query as Record<string, string>;

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
    if (activo === undefined || activo === 'true') {
      conditions.push(`c.activo = TRUE`);
    } else if (activo === 'false') {
      conditions.push(`c.activo = FALSE`);
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
      `SELECT c.*, p.nombre AS proyecto_nombre, cl.tipo AS proyecto_tipo, p.tiene_ipt AS proyecto_tiene_ipt
       FROM cuentas c
       JOIN proyectos p ON p.id = c.proyecto_id
       LEFT JOIN clientes cl ON cl.id = p.cliente_id
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
        `SELECT c.*, p.nombre AS proyecto_nombre, cl.tipo AS proyecto_tipo, p.tiene_ipt AS proyecto_tiene_ipt
         FROM cuentas c
         JOIN proyectos p ON p.id = c.proyecto_id
       LEFT JOIN clientes cl ON cl.id = p.cliente_id
         WHERE c.id = $1 AND c.activo = TRUE`,
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
         WHERE e.cuenta_id = $1 AND e.activo = true
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

      const iptRes = await query(
        `SELECT i.*, um.nombre AS firma_ministro_nombre, ume.nombre AS firma_mef_nombre, uc.nombre AS firma_contralor_nombre
         FROM cuentas_ipt i
         LEFT JOIN users um ON um.id = i.firma_ministro_por
         LEFT JOIN users ume ON ume.id = i.firma_mef_por
         LEFT JOIN users uc ON uc.id = i.firma_contralor_por
         WHERE i.cuenta_id = $1 AND i.activo = true`,
        [id],
      );

      res.json({
        success: true,
        data: {
          ...cuenta,
          eventos: eventos.rows,
          adjuntos: adjuntos.rows,
          ipt: iptRes.rows[0] || null,
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
        `SELECT MAX(numero) AS max FROM cuentas WHERE proyecto_id = $1 AND activo = TRUE`,
        [proyecto_id],
      );
      const numero = (nextRes.rows[0].max ?? 0) + 1;

      const insert = await client.query<{ id: number }>(
        `INSERT INTO cuentas (
          proyecto_id, numero, es_final, monto_total,
          periodo_inicio, periodo_fin, avance_porcentaje,
          estado, creado_por
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

      // Initial timeline event
      await client.query(
        `INSERT INTO cuentas_eventos (cuenta_id, tipo, comentario, creado_por)
         VALUES ($1, 'creacion', $2, $3)`,
        [insert.rows[0].id, `Período de Cuenta ${numero} iniciado`, user.id],
      );

      // Auto-create IPT row for publico_ipt projects.
      const projInfo = await client.query<{ cliente_tipo: string | null; tiene_ipt: boolean | null }>(
        `SELECT cl.tipo AS cliente_tipo, p.tiene_ipt
         FROM proyectos p LEFT JOIN clientes cl ON cl.id = p.cliente_id
         WHERE p.id = $1`,
        [proyecto_id],
      );
      const tipo = projInfo.rows[0]?.cliente_tipo || 'privado';
      const tieneIpt = !!projInfo.rows[0]?.tiene_ipt;
      if (getFlow(tipo, tieneIpt) === 'publico_ipt') {
        await client.query(
          `INSERT INTO cuentas_ipt (cuenta_id, estado, creado_por) VALUES ($1, 'pendiente', $2)`,
          [insert.rows[0].id, user.id],
        );
      }

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
        'SELECT * FROM cuentas WHERE id = $1 AND activo = TRUE',
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
      const LOCKED_STATES = [
        'aprobada', 'pagada',
        'aprobada_institucion', 'aprobada_contraloria',
      ];
      if (LOCKED_STATES.includes(cuenta.estado)) {
        res.status(400).json({
          success: false,
          error: 'No se puede editar una cuenta aprobada o pagada',
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
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      for (const f of fields) {
        if (f in req.body) {
          const oldVal = cuenta[f as keyof CuentaRow];
          const newVal = req.body[f];
          if (String(oldVal ?? '') !== String(newVal ?? '')) {
            changes[f] = { from: oldVal, to: newVal };
          }
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
        `UPDATE cuentas SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $${params.length} AND activo = TRUE`,
        params,
      );

      // Log edit as event if the cuenta was already submitted (not borrador)
      if (cuenta.estado !== 'borrador' && Object.keys(changes).length > 0) {
        const changeDesc = Object.entries(changes)
          .map(([k, v]) => `${k}: ${v.from ?? '—'} → ${v.to ?? '—'}`)
          .join(', ');
        await query(
          `INSERT INTO cuentas_eventos (cuenta_id, tipo, comentario, creado_por)
           VALUES ($1, 'edicion', $2, $3)`,
          [id, changeDesc, user.id],
        );
      }

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

      const cur = await query<CuentaRow & { proyecto_tipo: string; proyecto_tiene_ipt: boolean }>(
        `SELECT c.*, cl.tipo AS proyecto_tipo, p.tiene_ipt AS proyecto_tiene_ipt
         FROM cuentas c
         JOIN proyectos p ON p.id = c.proyecto_id
         LEFT JOIN clientes cl ON cl.id = p.cliente_id
         WHERE c.id = $1 AND c.activo = TRUE`,
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

      const flow = getFlow(cuenta.proyecto_tipo, cuenta.proyecto_tiene_ipt);
      const matrix = TRANSICIONES[flow];
      if (!matrix) {
        res.status(400).json({
          success: false,
          error: `Flujo "${flow}" no soportado aún`,
        });
        return;
      }
      const permitidos = matrix[cuenta.estado] || [];
      if (!permitidos.includes(estado_hacia)) {
        res.status(400).json({
          success: false,
          error: `Transición no permitida: "${cuenta.estado}" → "${estado_hacia}"`,
        });
        return;
      }

      // IPT guard: en flujo publico_ipt, solo se puede marcar pagada si el IPT está aprobado.
      if (flow === 'publico_ipt' && estado_hacia === 'pagada') {
        if (!(await iptIsAprobado(Number(id)))) {
          res.status(400).json({
            success: false,
            error: 'No se puede marcar pagada hasta que el IPT esté aprobado',
          });
          return;
        }
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const sets: string[] = ['estado = $1', 'updated_at = CURRENT_TIMESTAMP'];
        const params: unknown[] = [estado_hacia];

        if (cuenta.estado === 'borrador' && isEnviadaEstado(estado_hacia)) {
          sets.push(`fecha_primera_submision = CURRENT_DATE`);
        }
        if (isObservacionesEstado(cuenta.estado) && isEnviadaEstado(estado_hacia)) {
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
          `UPDATE cuentas SET ${sets.join(', ')} WHERE id = $${params.length} AND activo = TRUE`,
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
        'SELECT * FROM cuentas WHERE id = $1 AND activo = TRUE',
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
        'SELECT * FROM cuentas WHERE id = $1 AND activo = TRUE',
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
         JOIN cuentas c ON c.id = a.cuenta_id AND c.activo = TRUE
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
         JOIN cuentas c ON c.id = a.cuenta_id AND c.activo = TRUE
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
        'SELECT * FROM cuentas WHERE id = $1 AND activo = TRUE',
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
        'UPDATE cuentas SET activo = FALSE, updated_at = CURRENT_TIMESTAMP WHERE id = $1',
        [id],
      );
      await registrarAudit(user.id, 'eliminar', 'cuenta', id, {});
      res.json({ success: true });
    },
  ),
);

// ─── IPT endpoints ──────────────────────────────────────────────────────────

// PATCH /:id/ipt — update IPT signatures, estado, observaciones.
// Body may contain any of:
//   estado: 'pendiente' | 'con_observaciones' | 'aprobado'
//   observaciones_texto: string | null
//   firma_ministro: boolean   (true = set today's date + user; false = clear)
//   firma_mef: boolean
//   firma_contralor: boolean
router.patch(
  '/:id/ipt',
  [param('id').isInt()],
  asyncHandler(
    async (req: Request<{ id: string }>, res: Response): Promise<void> => {
      const user = req.user!;
      const id = Number(req.params.id);

      const cur = await query<CuentaRow>(
        'SELECT * FROM cuentas WHERE id = $1 AND activo = TRUE',
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

      const existing = await query<{ id: number }>(
        'SELECT id FROM cuentas_ipt WHERE cuenta_id = $1 AND activo = true',
        [id],
      );
      if (existing.rows.length === 0) {
        res.status(400).json({
          success: false,
          error: 'Esta cuenta no tiene IPT (proyecto no marcado con IPT)',
        });
        return;
      }

      const { estado, observaciones_texto, firma_ministro, firma_mef, firma_contralor } =
        req.body as {
          estado?: string;
          observaciones_texto?: string | null;
          firma_ministro?: boolean;
          firma_mef?: boolean;
          firma_contralor?: boolean;
        };

      const sets: string[] = ['updated_at = CURRENT_TIMESTAMP'];
      const params: unknown[] = [];

      if (estado !== undefined) {
        if (!['pendiente', 'con_observaciones', 'aprobado'].includes(estado)) {
          res.status(400).json({ success: false, error: 'Estado de IPT inválido' });
          return;
        }
        params.push(estado);
        sets.push(`estado = $${params.length}`);
      }
      if (observaciones_texto !== undefined) {
        params.push(observaciones_texto);
        sets.push(`observaciones_texto = $${params.length}`);
      }
      if (firma_ministro !== undefined) {
        if (firma_ministro) {
          params.push(user.id);
          sets.push(`firma_ministro_por = $${params.length}`);
          sets.push(`fecha_firma_ministro = CURRENT_DATE`);
        } else {
          sets.push(`firma_ministro_por = NULL`);
          sets.push(`fecha_firma_ministro = NULL`);
        }
      }
      if (firma_mef !== undefined) {
        if (firma_mef) {
          params.push(user.id);
          sets.push(`firma_mef_por = $${params.length}`);
          sets.push(`fecha_firma_mef = CURRENT_DATE`);
        } else {
          sets.push(`firma_mef_por = NULL`);
          sets.push(`fecha_firma_mef = NULL`);
        }
      }
      if (firma_contralor !== undefined) {
        if (firma_contralor) {
          params.push(user.id);
          sets.push(`firma_contralor_por = $${params.length}`);
          sets.push(`fecha_firma_contralor = CURRENT_DATE`);
        } else {
          sets.push(`firma_contralor_por = NULL`);
          sets.push(`fecha_firma_contralor = NULL`);
        }
      }

      params.push(id);
      await query(
        `UPDATE cuentas_ipt SET ${sets.join(', ')} WHERE cuenta_id = $${params.length} AND activo = true`,
        params,
      );

      await registrarAudit(user.id, 'ipt_actualizar', 'cuenta', id, req.body);
      res.json({ success: true });
    },
  ),
);

export default router;
