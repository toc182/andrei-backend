import { Router, Request, Response } from 'express';
import { body, param, validationResult } from 'express-validator';
import multer from 'multer';
import crypto from 'crypto';
import { query, pool } from '../database/config.js';
import { authenticateToken, checkPermission } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { uploadFile, deleteFile, downloadFile } from '../services/storage.js';
import { registrarAudit } from '../services/auditLog.js';
import { fixUploadEncoding } from '../utils/fileEncoding.js';

const router = Router();
router.use(authenticateToken, checkPermission('cuentas'));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

const sanitizeFilename = (name: string): string =>
  name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);

// Pretty-printers for the historial "edicion" comentario.
const FIELD_LABELS: Record<string, string> = {
  monto_total: 'Monto bruto',
  periodo_inicio: 'Período inicio',
  periodo_fin: 'Período fin',
  avance_porcentaje: 'Avance',
  es_final: 'Cuenta final',
};

const labelOf = (k: string): string => FIELD_LABELS[k] ?? k;

const TIPO_LABELS: Record<string, string> = {
  aumento: 'Aumento',
  disminucion: 'Disminución',
};

function formatMontoCurrency(n: number): string {
  return `B/. ${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Normalize values for change-detection. The DB returns DATE columns as
// JS Date at UTC midnight and NUMERIC columns as strings, but the request
// body has YYYY-MM-DD strings and numeric values — naive String() comparison
// always reports a change. Normalize both sides to a canonical form first.
function normalizeForCompare(field: string, val: unknown): string {
  if (val === null || val === undefined || val === '') return '';
  if (field === 'periodo_inicio' || field === 'periodo_fin') {
    if (val instanceof Date) {
      const y = val.getUTCFullYear();
      const m = String(val.getUTCMonth() + 1).padStart(2, '0');
      const d = String(val.getUTCDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    }
    if (typeof val === 'string') return val.slice(0, 10);
    return String(val);
  }
  if (field === 'monto_total' || field === 'avance_porcentaje') {
    const n = Number(val);
    return Number.isFinite(n) ? n.toString() : String(val);
  }
  if (field === 'es_final') return val ? 'true' : 'false';
  return String(val);
}

type AjusteCmp = { tipo: string; descripcion: string; monto: number };

function ajusteSummary(a: AjusteCmp): string {
  const label = TIPO_LABELS[a.tipo] ?? a.tipo;
  return `${label} ${a.descripcion} (${formatMontoCurrency(a.monto)})`;
}

function diffAjustesLog(oldList: AjusteCmp[], newList: AjusteCmp[]): string[] {
  const out: string[] = [];
  const matchedOld = new Set<number>();
  const matchedNew = new Set<number>();

  // Match by (tipo, descripcion). Detect monto-only changes as "modificado".
  for (let i = 0; i < oldList.length; i++) {
    const o = oldList[i];
    for (let j = 0; j < newList.length; j++) {
      if (matchedNew.has(j)) continue;
      const n = newList[j];
      if (o.descripcion === n.descripcion && o.tipo === n.tipo) {
        matchedOld.add(i);
        matchedNew.add(j);
        if (Math.abs(o.monto - n.monto) > 0.0001) {
          out.push(
            `Ajuste modificado: ${TIPO_LABELS[o.tipo] ?? o.tipo} ${o.descripcion} (${formatMontoCurrency(o.monto)} → ${formatMontoCurrency(n.monto)})`,
          );
        }
        break;
      }
    }
  }
  for (let i = 0; i < oldList.length; i++) {
    if (!matchedOld.has(i)) out.push(`Ajuste eliminado: ${ajusteSummary(oldList[i])}`);
  }
  for (let j = 0; j < newList.length; j++) {
    if (!matchedNew.has(j)) out.push(`Ajuste agregado: ${ajusteSummary(newList[j])}`);
  }
  return out;
}

function computeMontoAPagar(monto: number, ajustes: AjusteCmp[]): number {
  return ajustes.reduce(
    (acc, a) => acc + (a.tipo === 'aumento' ? a.monto : -a.monto),
    monto,
  );
}

function formatValue(field: string, val: unknown): string {
  if (val === null || val === undefined || val === '') return '—';
  if (field === 'monto_total') {
    const n = Number(val);
    if (Number.isNaN(n)) return String(val);
    return `B/. ${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  if (field === 'avance_porcentaje') {
    const n = Number(val);
    if (Number.isNaN(n)) return String(val);
    return `${n.toFixed(2)}%`;
  }
  if (field === 'es_final') {
    return val ? 'Sí' : 'No';
  }
  if (field === 'periodo_inicio' || field === 'periodo_fin') {
    // pg returns DATE columns as JS Date at UTC midnight. Form values
    // arrive as "YYYY-MM-DD" strings. Normalize both to DD/MM/YYYY.
    if (val instanceof Date) {
      const dd = String(val.getUTCDate()).padStart(2, '0');
      const mm = String(val.getUTCMonth() + 1).padStart(2, '0');
      return `${dd}/${mm}/${val.getUTCFullYear()}`;
    }
    if (typeof val === 'string') {
      const [y, m, d] = val.slice(0, 10).split('-');
      if (y && m && d) return `${d}/${m}/${y}`;
    }
  }
  return String(val);
}

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

// Whitelist of every estado the cuentas table accepts.
// Used as the only validation gate on POST /:id/transicion now that the
// linear TRANSICIONES check is gone.
const VALID_ESTADOS = new Set([
  'borrador',
  'enviada',
  'observaciones',
  'aprobada',
  'enviada_institucion',
  'observaciones_institucion',
  'aprobada_institucion',
  'enviada_contraloria',
  'observaciones_contraloria',
  'aprobada_contraloria',
  'pagada',
]);

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
      `SELECT c.*, p.nombre AS proyecto_nombre, cl.tipo AS proyecto_tipo, p.tiene_ipt AS proyecto_tiene_ipt,
              cl.nombre AS cliente_nombre, cl.abreviatura AS cliente_abreviatura,
              p.monto_total AS proyecto_monto_total
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

      const cuentaRes = await query<
        CuentaRow & {
          proyecto_nombre: string;
          proyecto_tipo: string;
          proyecto_tiene_ipt: boolean;
          cliente_nombre: string | null;
          cliente_abreviatura: string | null;
          avance_acumulado: string;
        }
      >(
        `SELECT c.*,
                p.nombre AS proyecto_nombre,
                cl.tipo AS proyecto_tipo,
                p.tiene_ipt AS proyecto_tiene_ipt,
                cl.nombre AS cliente_nombre,
                cl.abreviatura AS cliente_abreviatura,
                (
                  SELECT COALESCE(SUM(c2.avance_porcentaje), 0)
                  FROM cuentas c2
                  WHERE c2.proyecto_id = c.proyecto_id
                    AND c2.activo = TRUE
                    AND c2.numero <= c.numero
                ) AS avance_acumulado
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

      const ajustes = await query(
        `SELECT id, tipo, descripcion, monto, orden
         FROM cuenta_ajustes
         WHERE cuenta_id = $1
         ORDER BY orden ASC, id ASC`,
        [id],
      );

      const ajusteOpcionesProyecto = await query(
        `SELECT id, tipo, descripcion, orden
         FROM cuenta_ajuste_opciones
         WHERE proyecto_id = $1
         ORDER BY orden ASC, id ASC`,
        [cuenta.proyecto_id],
      );

      const ajusteOpcionesGlobales = await query(
        `SELECT id, tipo, descripcion, orden
         FROM cuenta_ajuste_opciones_globales
         ORDER BY orden ASC, id ASC`,
      );

      const ajusteOpciones = [
        ...ajusteOpcionesGlobales.rows.map((r) => ({ ...r, es_global: true })),
        ...ajusteOpcionesProyecto.rows.map((r) => ({ ...r, es_global: false })),
      ];

      res.json({
        success: true,
        data: {
          ...cuenta,
          eventos: eventos.rows,
          adjuntos: adjuntos.rows,
          ipt: iptRes.rows[0] || null,
          ajustes: ajustes.rows,
          ajuste_opciones: ajusteOpciones,
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

// PUT /:id — editar header y/o ajustes (no permitido en estados LOCKED).
interface AjusteInput {
  tipo: 'aumento' | 'disminucion';
  descripcion: string;
  monto: number;
  orden?: number;
}

router.put(
  '/:id',
  [
    param('id').isInt(),
    body('monto_total').optional().isFloat({ gt: 0 }),
    body('periodo_inicio').optional({ nullable: true }).isISO8601(),
    body('periodo_fin').optional({ nullable: true }).isISO8601(),
    body('avance_porcentaje').optional({ nullable: true }).isFloat({ min: 0, max: 100 }),
    body('es_final').optional().isBoolean(),
    body('ajustes').optional().isArray(),
    body('ajustes.*.tipo').optional().isIn(['aumento', 'disminucion']),
    body('ajustes.*.descripcion').optional().isString().trim().notEmpty(),
    body('ajustes.*.monto').optional().isFloat({ min: 0 }),
    body('ajustes.*.orden').optional().isInt({ min: 0 }),
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

      const headerFields = [
        'monto_total',
        'periodo_inicio',
        'periodo_fin',
        'avance_porcentaje',
        'es_final',
      ] as const;
      const hasHeaderUpdate = headerFields.some((f) => f in req.body);
      const ajustesIncoming = (req.body as { ajustes?: AjusteInput[] }).ajustes;
      const hasAjustesUpdate = Array.isArray(ajustesIncoming);

      if (!hasHeaderUpdate && !hasAjustesUpdate) {
        res.status(400).json({ success: false, error: 'Nada que actualizar' });
        return;
      }

      const changes: Record<string, { from: unknown; to: unknown }> = {};
      const shouldLog = cuenta.estado !== 'borrador';
      let oldAjustes: AjusteCmp[] = [];

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Capture current ajustes BEFORE the snapshot-replace, so the
        // historial diff and the Monto a pagar before/after can be computed.
        if (shouldLog) {
          const r = await client.query<{ tipo: string; descripcion: string; monto: string }>(
            'SELECT tipo, descripcion, monto FROM cuenta_ajustes WHERE cuenta_id = $1 ORDER BY orden',
            [id],
          );
          oldAjustes = r.rows.map((a) => ({
            tipo: a.tipo,
            descripcion: a.descripcion,
            monto: Number(a.monto),
          }));
        }

        if (hasHeaderUpdate) {
          const sets: string[] = [];
          const params: unknown[] = [];
          for (const f of headerFields) {
            if (f in req.body) {
              const oldVal = cuenta[f as keyof CuentaRow];
              const newVal = req.body[f];
              if (normalizeForCompare(f, oldVal) !== normalizeForCompare(f, newVal)) {
                changes[f] = { from: oldVal, to: newVal };
              }
              params.push(req.body[f]);
              sets.push(`${f} = $${params.length}`);
            }
          }
          params.push(id);
          await client.query(
            `UPDATE cuentas SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $${params.length} AND activo = TRUE`,
            params,
          );
        }

        if (hasAjustesUpdate) {
          await client.query('DELETE FROM cuenta_ajustes WHERE cuenta_id = $1', [id]);
          let orden = 0;
          for (const aj of ajustesIncoming!) {
            await client.query(
              `INSERT INTO cuenta_ajustes (cuenta_id, tipo, descripcion, monto, orden, creado_por)
               VALUES ($1, $2, $3, $4, $5, $6)`,
              [
                id,
                aj.tipo,
                aj.descripcion.trim(),
                aj.monto,
                aj.orden ?? orden,
                user.id,
              ],
            );
            orden++;
          }
        }

        // Build the "edicion" timeline comentario from:
        //   - header field changes,
        //   - per-ajuste diff (agregado / eliminado / modificado),
        //   - the resulting Monto a pagar delta.
        // Only logged for non-borrador cuentas (an in-progress draft is the
        // user's scratchpad and doesn't need a timeline entry on every edit).
        if (shouldLog) {
          const lines: string[] = [];

          for (const [k, v] of Object.entries(changes)) {
            lines.push(`${labelOf(k)}: ${formatValue(k, v.from)} → ${formatValue(k, v.to)}`);
          }

          if (hasAjustesUpdate) {
            const newAjustes: AjusteCmp[] = ajustesIncoming!.map((a) => ({
              tipo: a.tipo,
              descripcion: a.descripcion.trim(),
              monto: Number(a.monto),
            }));
            lines.push(...diffAjustesLog(oldAjustes, newAjustes));
          }

          // Monto a pagar delta — captures the effective change to what the
          // client receives. Computed from monto_total + signed ajustes both
          // before and after this PUT.
          const oldMontoTotal = Number(cuenta.monto_total) || 0;
          const newMontoTotal =
            'monto_total' in req.body ? Number(req.body.monto_total) : oldMontoTotal;
          const effectiveNewAjustes: AjusteCmp[] = hasAjustesUpdate
            ? ajustesIncoming!.map((a) => ({
                tipo: a.tipo,
                descripcion: a.descripcion.trim(),
                monto: Number(a.monto),
              }))
            : oldAjustes;
          const oldMP = computeMontoAPagar(oldMontoTotal, oldAjustes);
          const newMP = computeMontoAPagar(newMontoTotal, effectiveNewAjustes);
          if (Math.abs(oldMP - newMP) > 0.0001) {
            lines.push(`Monto a pagar: ${formatMontoCurrency(oldMP)} → ${formatMontoCurrency(newMP)}`);
          }

          if (lines.length > 0) {
            await client.query(
              `INSERT INTO cuentas_eventos (cuenta_id, tipo, comentario, creado_por)
               VALUES ($1, 'edicion', $2, $3)`,
              [id, lines.join('\n'), user.id],
            );
          }
        }

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      await registrarAudit(user.id, 'editar', 'cuenta', id, req.body);
      res.json({ success: true });
    },
  ),
);

// POST /:id/ajuste-opciones — crear una opción de ajuste para el proyecto
// de esta cuenta. Devuelve la opción creada para que el cliente la auto-
// seleccione en la fila que disparó el "Crear nueva opción".
router.post(
  '/:id/ajuste-opciones',
  [
    param('id').isInt(),
    body('tipo').isIn(['aumento', 'disminucion']),
    body('descripcion').isString().trim().notEmpty(),
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
      const { tipo, descripcion } = req.body as { tipo: string; descripcion: string };
      const trimmed = descripcion.trim();

      const cur = await query<{ proyecto_id: number }>(
        'SELECT proyecto_id FROM cuentas WHERE id = $1 AND activo = TRUE',
        [id],
      );
      if (cur.rows.length === 0) {
        res.status(404).json({ success: false, error: 'Cuenta no encontrada' });
        return;
      }
      const proyectoId = cur.rows[0].proyecto_id;
      if (!(await userCanAccessProject(user.id, user.rol, proyectoId))) {
        res.status(403).json({ success: false, error: 'Sin acceso al proyecto' });
        return;
      }

      const nextOrden = await query<{ max: number | null }>(
        'SELECT MAX(orden) AS max FROM cuenta_ajuste_opciones WHERE proyecto_id = $1',
        [proyectoId],
      );
      const orden = (nextOrden.rows[0].max ?? -1) + 1;

      let inserted;
      try {
        inserted = await query<{
          id: number;
          tipo: string;
          descripcion: string;
          orden: number;
        }>(
          `INSERT INTO cuenta_ajuste_opciones (proyecto_id, tipo, descripcion, orden, creado_por)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, tipo, descripcion, orden`,
          [proyectoId, tipo, trimmed, orden, user.id],
        );
      } catch (err) {
        const e = err as { code?: string };
        if (e.code === '23505') {
          res.status(409).json({
            success: false,
            error: 'Ya existe una opción con ese tipo y descripción',
          });
          return;
        }
        throw err;
      }

      await registrarAudit(user.id, 'crear', 'cuenta_ajuste_opcion', inserted.rows[0].id, {
        proyecto_id: proyectoId,
        tipo,
        descripcion: trimmed,
      });

      res.status(201).json({ success: true, data: inserted.rows[0] });
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
      if (!VALID_ESTADOS.has(estado_hacia)) {
        res.status(400).json({
          success: false,
          error: `Estado desconocido: "${estado_hacia}"`,
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

// PATCH /:id/evento/:eventoId — editar comentario, estados o fecha de un evento.
// Cualquier usuario con permiso `cuentas` (y acceso al proyecto) puede editar
// cualquier fila del historial. Cada edición queda registrada en audit_log.
router.patch(
  '/:id/evento/:eventoId',
  [
    param('id').isInt(),
    param('eventoId').isInt(),
    body('comentario').optional({ nullable: true }).isString(),
    body('estado_desde').optional({ nullable: true }).isString(),
    body('estado_hacia').optional({ nullable: true }).isString(),
    body('fecha').optional({ nullable: true }).isString().matches(/^\d{4}-\d{2}-\d{2}$/),
  ],
  asyncHandler(
    async (
      req: Request<{ id: string; eventoId: string }>,
      res: Response,
    ): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({ success: false, error: 'Datos inválidos' });
        return;
      }

      const user = req.user!;
      const cuentaId = Number(req.params.id);
      const eventoId = Number(req.params.eventoId);

      const body = req.body as {
        comentario?: string | null;
        estado_desde?: string | null;
        estado_hacia?: string | null;
        fecha?: string | null;
      };

      // Validate estado values against the whitelist (null allowed).
      for (const key of ['estado_desde', 'estado_hacia'] as const) {
        const v = body[key];
        if (v !== undefined && v !== null && !VALID_ESTADOS.has(v)) {
          res.status(400).json({
            success: false,
            error: `Estado desconocido en ${key}: "${v}"`,
          });
          return;
        }
      }

      // Verify cuenta + project access.
      const cur = await query<{ proyecto_id: number }>(
        'SELECT proyecto_id FROM cuentas WHERE id = $1 AND activo = TRUE',
        [cuentaId],
      );
      if (cur.rows.length === 0) {
        res.status(404).json({ success: false, error: 'Cuenta no encontrada' });
        return;
      }
      if (!(await userCanAccessProject(user.id, user.rol, cur.rows[0].proyecto_id))) {
        res.status(403).json({ success: false, error: 'Sin acceso al proyecto' });
        return;
      }

      // Verify evento exists, belongs to this cuenta, is active.
      const evRes = await query<{ id: number }>(
        'SELECT id FROM cuentas_eventos WHERE id = $1 AND cuenta_id = $2 AND activo = TRUE',
        [eventoId, cuentaId],
      );
      if (evRes.rows.length === 0) {
        res.status(404).json({ success: false, error: 'Evento no encontrado' });
        return;
      }

      // Build dynamic UPDATE. Only the fields the body actually sent.
      const sets: string[] = [];
      const params: unknown[] = [];
      const cambios: Record<string, unknown> = {};

      if ('comentario' in body) {
        const c =
          typeof body.comentario === 'string' ? body.comentario.trim() : null;
        params.push(c && c.length > 0 ? c : null);
        sets.push(`comentario = $${params.length}`);
        cambios.comentario = c;
      }
      if ('estado_desde' in body) {
        params.push(body.estado_desde ?? null);
        sets.push(`estado_desde = $${params.length}`);
        cambios.estado_desde = body.estado_desde ?? null;
      }
      if ('estado_hacia' in body) {
        params.push(body.estado_hacia ?? null);
        sets.push(`estado_hacia = $${params.length}`);
        cambios.estado_hacia = body.estado_hacia ?? null;
      }
      if ('fecha' in body && body.fecha) {
        // Store at noon UTC to keep the date stable across timezones.
        params.push(`${body.fecha} 12:00:00`);
        sets.push(`created_at = $${params.length}::timestamp`);
        cambios.fecha = body.fecha;
      }

      if (sets.length === 0) {
        res.json({ success: true, evento_id: eventoId });
        return;
      }

      params.push(eventoId);
      await query(
        `UPDATE cuentas_eventos SET ${sets.join(', ')} WHERE id = $${params.length}`,
        params,
      );

      await registrarAudit(user.id, 'editar_evento', 'cuenta', cuentaId, {
        evento_id: eventoId,
        cambios,
      });

      res.json({ success: true, evento_id: eventoId });
    },
  ),
);

// DELETE /:id/evento/:eventoId — soft-delete una fila del historial.
router.delete(
  '/:id/evento/:eventoId',
  [param('id').isInt(), param('eventoId').isInt()],
  asyncHandler(
    async (
      req: Request<{ id: string; eventoId: string }>,
      res: Response,
    ): Promise<void> => {
      const user = req.user!;
      const cuentaId = Number(req.params.id);
      const eventoId = Number(req.params.eventoId);

      const cur = await query<{ proyecto_id: number }>(
        'SELECT proyecto_id FROM cuentas WHERE id = $1 AND activo = TRUE',
        [cuentaId],
      );
      if (cur.rows.length === 0) {
        res.status(404).json({ success: false, error: 'Cuenta no encontrada' });
        return;
      }
      if (!(await userCanAccessProject(user.id, user.rol, cur.rows[0].proyecto_id))) {
        res.status(403).json({ success: false, error: 'Sin acceso al proyecto' });
        return;
      }

      const r = await query(
        `UPDATE cuentas_eventos
            SET activo = false
          WHERE id = $1 AND cuenta_id = $2 AND activo = TRUE`,
        [eventoId, cuentaId],
      );
      if (r.rowCount === 0) {
        res.status(404).json({ success: false, error: 'Evento no encontrado' });
        return;
      }

      await registrarAudit(user.id, 'eliminar_evento', 'cuenta', cuentaId, {
        evento_id: eventoId,
      });
      res.json({ success: true });
    },
  ),
);

// POST /:id/adjuntos — subir archivo.
router.post(
  '/:id/adjuntos',
  upload.single('file'),
  fixUploadEncoding,
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

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        await client.query(
          'UPDATE cuentas SET activo = FALSE, updated_at = CURRENT_TIMESTAMP WHERE id = $1',
          [id],
        );

        // Shift every subsequent active cuenta down by 1 to keep the
        // sequence gap-free. Two-step (negate, then assign positive) so
        // PG can't transiently violate the partial unique index.
        await client.query(
          `UPDATE cuentas SET numero = -numero
             WHERE proyecto_id = $1 AND activo = TRUE AND numero > $2`,
          [cuenta.proyecto_id, cuenta.numero],
        );
        await client.query(
          `UPDATE cuentas SET numero = -numero - 1, updated_at = CURRENT_TIMESTAMP
             WHERE proyecto_id = $1 AND activo = TRUE AND numero < 0`,
          [cuenta.proyecto_id],
        );

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      await registrarAudit(user.id, 'eliminar', 'cuenta', id, {
        proyecto_id: cuenta.proyecto_id,
        numero: cuenta.numero,
      });
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
