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
  desglose_id: number | null;
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

      // Ficha del desglose con el que se armó la cuenta, para poder listarlo
      // entre los documentos de la cuenta. Filas y total salen de la FOTO
      // congelada (cuenta_lineas), no del desglose vivo.
      let desglose: {
        id: number;
        descripcion: string;
        filas: number;
        total: string;
      } | null = null;
      if (cuenta.desglose_id != null) {
        const d = await query<{ descripcion: string; filas: string; total: string }>(
          `SELECT d.nombre AS descripcion,
                  (SELECT COUNT(*) FROM cuenta_lineas cl WHERE cl.cuenta_id = $1) AS filas,
                  (SELECT COALESCE(SUM(cl.cantidad_presupuesto * cl.precio_unitario), 0)
                     FROM cuenta_lineas cl WHERE cl.cuenta_id = $1) AS total
             FROM desgloses d
            WHERE d.id = $2`,
          [id, cuenta.desglose_id],
        );
        if (d.rows.length) {
          desglose = {
            id: cuenta.desglose_id,
            descripcion: d.rows[0].descripcion,
            filas: Number(d.rows[0].filas),
            total: d.rows[0].total,
          };
        }
      }

      // El desglose se activa (y se quita) SOLO desde la primera cuenta del
      // proyecto: un proyecto no mezcla cuentas a mano con cuentas con
      // desglose. De la segunda en adelante el modo ya quedó decidido.
      const primeraRes = await query<{ min: number | null }>(
        `SELECT MIN(numero) AS min FROM cuentas WHERE proyecto_id = $1 AND activo = TRUE`,
        [cuenta.proyecto_id],
      );
      const es_primera_cuenta = Number(primeraRes.rows[0].min) === cuenta.numero;

      const oficialRes = await query<{ id: number }>(
        `SELECT id FROM desgloses
          WHERE proyecto_id = $1 AND tipo = 'oficial' AND activo = TRUE
          LIMIT 1`,
        [cuenta.proyecto_id],
      );

      res.json({
        success: true,
        data: {
          ...cuenta,
          eventos: eventos.rows,
          adjuntos: adjuntos.rows,
          ipt: iptRes.rows[0] || null,
          ajustes: ajustes.rows,
          ajuste_opciones: ajusteOpciones,
          desglose,
          es_primera_cuenta,
          desglose_oficial_id: oficialRes.rows[0]?.id ?? null,
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
    body('ajustes').optional().isArray(),
    body('ajustes.*.tipo').optional().isIn(['aumento', 'disminucion']),
    body('ajustes.*.descripcion').optional().isString().trim().notEmpty(),
    body('ajustes.*.monto').optional().isFloat({ min: 0 }),
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
    const ajustesIncoming = (req.body as { ajustes?: AjusteInput[] }).ajustes;

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

      if (ajustesIncoming && ajustesIncoming.length > 0) {
        let orden = 0;
        for (const aj of ajustesIncoming) {
          await client.query(
            `INSERT INTO cuenta_ajustes (cuenta_id, tipo, descripcion, monto, orden, creado_por)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              insert.rows[0].id,
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
      // Con desglose activo el monto y el avance son DERIVADOS de las
      // cantidades del periodo (actualizarEspejoCuenta): no se escriben a mano.
      if (cuenta.desglose_id != null) {
        delete req.body.monto_total;
        delete req.body.avance_porcentaje;
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

// GET /proyecto/:projectId/ajuste-opciones — opciones para usar al crear
// una cuenta nueva, antes de que exista la cuenta. Devuelve los globales
// + los del proyecto, con la misma forma que GET /cuentas/:id retorna
// en su campo ajuste_opciones.
router.get(
  '/proyecto/:projectId/ajuste-opciones',
  [param('projectId').isInt()],
  asyncHandler(
    async (req: Request<{ projectId: string }>, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({ success: false, error: 'Datos inválidos' });
        return;
      }

      const user = req.user!;
      const projectId = Number(req.params.projectId);

      if (!(await userCanAccessProject(user.id, user.rol, projectId))) {
        res.status(403).json({ success: false, error: 'Sin acceso al proyecto' });
        return;
      }

      const proyecto = await query(
        `SELECT id, tipo, descripcion, orden
         FROM cuenta_ajuste_opciones
         WHERE proyecto_id = $1
         ORDER BY orden ASC, id ASC`,
        [projectId],
      );

      const globales = await query(
        `SELECT id, tipo, descripcion, orden
         FROM cuenta_ajuste_opciones_globales
         ORDER BY orden ASC, id ASC`,
      );

      const merged = [
        ...globales.rows.map((r) => ({ ...r, es_global: true })),
        ...proyecto.rows.map((r) => ({ ...r, es_global: false })),
      ];

      res.json({ success: true, data: merged });
    },
  ),
);

// POST /proyecto/:projectId/ajuste-opciones — crear una opción de ajuste
// para un proyecto sin necesidad de tener una cuenta. Misma semántica
// que POST /:id/ajuste-opciones pero ataca el proyecto directamente.
router.post(
  '/proyecto/:projectId/ajuste-opciones',
  [
    param('projectId').isInt(),
    body('tipo').isIn(['aumento', 'disminucion']),
    body('descripcion').isString().trim().notEmpty(),
  ],
  asyncHandler(
    async (req: Request<{ projectId: string }>, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({ success: false, error: 'Datos inválidos' });
        return;
      }

      const user = req.user!;
      const projectId = Number(req.params.projectId);
      const { tipo, descripcion } = req.body as { tipo: string; descripcion: string };
      const trimmed = descripcion.trim();

      if (!(await userCanAccessProject(user.id, user.rol, projectId))) {
        res.status(403).json({ success: false, error: 'Sin acceso al proyecto' });
        return;
      }

      const nextOrden = await query<{ max: number | null }>(
        'SELECT MAX(orden) AS max FROM cuenta_ajuste_opciones WHERE proyecto_id = $1',
        [projectId],
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
          [projectId, tipo, trimmed, orden, user.id],
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
        proyecto_id: projectId,
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

// ─── Cuadro de cuenta (desglose + avance por fila) ───────────────────────────
//
// Una cuenta "detallada" es el Cuadro de Presentación de Cuenta (tipo ETESA):
// se arma a partir de un desglose y guarda una FOTO CONGELADA de sus filas en
// cuenta_lineas. El único dato de entrada por fila es la cantidad ejecutada de
// ESTE periodo; el % y los valores se calculan (en el frontend, a la precisión
// que se pida). El "ejecutado hasta el periodo anterior" NO se guarda: se suma
// la cantidad_ejecutada de las cuentas previas del proyecto que comparten la
// misma fila (row_uid). ITBMS y pago siguen por el flujo de ajustes de siempre.

interface DesgloseItemSnapshotRow {
  id: number;
  row_uid: string;
  parent_id: number | null;
  tipo: 'grupo' | 'item';
  item: string;
  descripcion: string;
  unidad: string | null;
  cantidad: string | null;
  precio_unitario: string | null;
  orden: number;
}

/** Copia las filas del desglose a cuenta_lineas (foto congelada). El árbol se
 *  guarda por parent_row_uid, resuelto del parent_id vía el mapa id->row_uid. */
async function snapshotDesgloseLines(
  client: { query: typeof pool.query },
  cuentaId: number,
  desgloseId: number,
): Promise<number> {
  const src = await client.query<DesgloseItemSnapshotRow>(
    `SELECT id, row_uid, parent_id, tipo, item, descripcion, unidad, cantidad, precio_unitario, orden
       FROM desglose_items WHERE desglose_id = $1 ORDER BY orden`,
    [desgloseId],
  );
  const uidById = new Map<number, string>();
  for (const r of src.rows) uidById.set(r.id, r.row_uid);
  for (const [i, r] of src.rows.entries()) {
    await client.query(
      `INSERT INTO cuenta_lineas
         (cuenta_id, row_uid, parent_row_uid, tipo, item, descripcion, unidad,
          cantidad_presupuesto, precio_unitario, cantidad_ejecutada, orden)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0, $10)`,
      [
        cuentaId,
        r.row_uid,
        r.parent_id != null ? uidById.get(r.parent_id) ?? null : null,
        r.tipo,
        r.item,
        r.descripcion,
        r.unidad,
        r.cantidad,
        r.precio_unitario,
        i,
      ],
    );
  }
  return src.rows.length;
}

interface CuadroLineaRow {
  row_uid: string;
  parent_row_uid: string | null;
  tipo: 'grupo' | 'item';
  item: string;
  descripcion: string;
  unidad: string | null;
  cantidad_presupuesto: string | null;
  precio_unitario: string | null;
  cantidad_ejecutada: string;
  cantidad_anterior: string;
}

/** Cuadro completo de una cuenta: meta + filas con el "hasta anterior" ya
 *  encadenado por row_uid. Los NUMERIC de pg llegan como string; se parsean. */
async function loadCuadro(cuentaId: number) {
  const c = await query<{
    id: number;
    numero: number;
    estado: string;
    proyecto_id: number;
    periodo_inicio: string | null;
    periodo_fin: string | null;
    desglose_id: number | null;
    itbms_tasa: string | null;
  }>(
    `SELECT c.id, c.numero, c.estado, c.proyecto_id,
            to_char(c.periodo_inicio, 'YYYY-MM-DD') AS periodo_inicio,
            to_char(c.periodo_fin, 'YYYY-MM-DD') AS periodo_fin,
            c.desglose_id, d.itbms_tasa
       FROM cuentas c
       LEFT JOIN desgloses d ON d.id = c.desglose_id
      WHERE c.id = $1 AND c.activo = TRUE`,
    [cuentaId],
  );
  if (!c.rows.length) return null;
  const cuenta = c.rows[0];

  const lineas = await query<CuadroLineaRow>(
    `SELECT cl.row_uid, cl.parent_row_uid, cl.tipo, cl.item, cl.descripcion, cl.unidad,
            cl.cantidad_presupuesto, cl.precio_unitario, cl.cantidad_ejecutada,
            COALESCE((
              SELECT SUM(cl2.cantidad_ejecutada)
                FROM cuenta_lineas cl2
                JOIN cuentas c2 ON c2.id = cl2.cuenta_id
               WHERE c2.proyecto_id = $2 AND c2.activo = TRUE AND c2.numero < $3
                 AND cl2.row_uid = cl.row_uid
            ), 0) AS cantidad_anterior
       FROM cuenta_lineas cl
      WHERE cl.cuenta_id = $1
      ORDER BY cl.orden`,
    [cuentaId, cuenta.proyecto_id, cuenta.numero],
  );

  const num = (s: string | null): number | null => (s != null ? parseFloat(s) : null);
  return {
    cuenta: {
      id: cuenta.id,
      numero: cuenta.numero,
      estado: cuenta.estado,
      periodo_inicio: cuenta.periodo_inicio,
      periodo_fin: cuenta.periodo_fin,
      desglose_id: cuenta.desglose_id,
      itbms_tasa: num(cuenta.itbms_tasa),
    },
    lineas: lineas.rows.map((r) => ({
      row_uid: r.row_uid,
      parent_row_uid: r.parent_row_uid,
      tipo: r.tipo,
      item: r.item,
      descripcion: r.descripcion,
      unidad: r.unidad,
      cantidad_presupuesto: num(r.cantidad_presupuesto),
      precio_unitario: num(r.precio_unitario),
      cantidad_ejecutada: parseFloat(r.cantidad_ejecutada),
      cantidad_anterior: parseFloat(r.cantidad_anterior),
    })),
  };
}

/** Espejo hacia las columnas escalares de la cuenta, para que la lista y el
 *  resumen (que suman avance_porcentaje) sigan cuadrando sin tocarlos:
 *    monto_total       = suma del valor de "este periodo" (cantidad_ejec × PU)
 *    avance_porcentaje = % del periodo = ese valor ÷ subtotal presupuestado
 *  Los contenedores (PU nulo) aportan 0. El cuadro detallado calcula fresco a
 *  full precision; este escalar (NUMERIC(5,2)) es solo para las vistas viejas. */
async function actualizarEspejoCuenta(
  client: { query: typeof pool.query },
  cuentaId: number,
): Promise<void> {
  const r = await client.query<{ este: string | null; presupuesto: string | null }>(
    `SELECT COALESCE(SUM(cantidad_ejecutada * precio_unitario), 0) AS este,
            COALESCE(SUM(cantidad_presupuesto * precio_unitario), 0) AS presupuesto
       FROM cuenta_lineas WHERE cuenta_id = $1`,
    [cuentaId],
  );
  const este = parseFloat(r.rows[0].este ?? '0');
  const presupuesto = parseFloat(r.rows[0].presupuesto ?? '0');
  const avance = presupuesto > 0 ? Math.round((este / presupuesto) * 10000) / 100 : 0;
  await client.query(
    `UPDATE cuentas SET monto_total = $2, avance_porcentaje = $3, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1`,
    [cuentaId, este, avance],
  );
}

// POST /detalle — crear una cuenta detallada a partir de un desglose (foto
// congelada de sus filas). Cuenta 1 elige el desglose; cuenta 2+ usa el mismo
// desglose del proyecto (editado en su lugar) — el arrastre se calcula al leer.
router.post(
  '/detalle',
  [
    body('proyecto_id').isInt(),
    body('desglose_id').isInt(),
    body('periodo_inicio').optional({ nullable: true }).isISO8601(),
    body('periodo_fin').optional({ nullable: true }).isISO8601(),
    body('es_final').optional().isBoolean(),
  ],
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, error: 'Datos inválidos', details: errors.array() });
      return;
    }

    const user = req.user!;
    const { proyecto_id, desglose_id, periodo_inicio, periodo_fin, es_final } = req.body as {
      proyecto_id: number;
      desglose_id: number;
      periodo_inicio?: string | null;
      periodo_fin?: string | null;
      es_final?: boolean;
    };

    if (!(await userCanAccessProject(user.id, user.rol, proyecto_id))) {
      res.status(403).json({ success: false, error: 'Sin acceso al proyecto' });
      return;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // El desglose debe existir, estar activo y ser DEL MISMO PROYECTO.
      const d = await client.query<{ id: number }>(
        `SELECT id FROM desgloses WHERE id = $1 AND proyecto_id = $2 AND activo = TRUE`,
        [desglose_id, proyecto_id],
      );
      if (!d.rows.length) {
        await client.query('ROLLBACK');
        res.status(400).json({ success: false, error: 'El desglose no existe en este proyecto' });
        return;
      }

      const nextRes = await client.query<{ max: number | null }>(
        `SELECT MAX(numero) AS max FROM cuentas WHERE proyecto_id = $1 AND activo = TRUE`,
        [proyecto_id],
      );
      const numero = (nextRes.rows[0].max ?? 0) + 1;

      const insert = await client.query<{ id: number }>(
        `INSERT INTO cuentas (
           proyecto_id, numero, es_final, monto_total,
           periodo_inicio, periodo_fin, avance_porcentaje,
           estado, desglose_id, creado_por
         ) VALUES ($1, $2, $3, 0, $4, $5, 0, 'borrador', $6, $7)
         RETURNING id`,
        [proyecto_id, numero, !!es_final, periodo_inicio || null, periodo_fin || null, desglose_id, user.id],
      );
      const cuentaId = insert.rows[0].id;

      await client.query(
        `INSERT INTO cuentas_eventos (cuenta_id, tipo, comentario, creado_por)
         VALUES ($1, 'creacion', $2, $3)`,
        [cuentaId, `Período de Cuenta ${numero} iniciado`, user.id],
      );

      // IPT automático para proyectos publico_ipt (igual que POST /).
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
          [cuentaId, user.id],
        );
      }

      const filas = await snapshotDesgloseLines(client, cuentaId, desglose_id);

      await client.query('COMMIT');

      await registrarAudit(user.id, 'crear', 'cuenta', cuentaId, {
        proyecto_id,
        numero,
        desglose_id,
        filas,
        detalle: true,
      });

      res.status(201).json({ success: true, data: { id: cuentaId, numero } });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }),
);

// GET /:id/cuadro — la foto congelada + el "hasta anterior" encadenado por fila.
router.get(
  '/:id/cuadro',
  [param('id').isInt()],
  asyncHandler(async (req: Request<{ id: string }>, res: Response): Promise<void> => {
    const user = req.user!;
    const id = Number(req.params.id);

    const acc = await query<{ proyecto_id: number }>(
      'SELECT proyecto_id FROM cuentas WHERE id = $1 AND activo = TRUE',
      [id],
    );
    if (!acc.rows.length) {
      res.status(404).json({ success: false, error: 'Cuenta no encontrada' });
      return;
    }
    if (!(await userCanAccessProject(user.id, user.rol, acc.rows[0].proyecto_id))) {
      res.status(403).json({ success: false, error: 'Sin acceso al proyecto' });
      return;
    }

    const cuadro = await loadCuadro(id);
    if (!cuadro) {
      res.status(404).json({ success: false, error: 'Cuenta no encontrada' });
      return;
    }
    res.json({ success: true, data: cuadro });
  }),
);

// PUT /:id/cuadro — guardar las cantidades ejecutadas de este periodo. Solo
// actualiza cantidad_ejecutada de las filas existentes (el set de filas quedó
// fijo en la foto); recalcula el espejo escalar. No permitido si LOCKED.
router.put(
  '/:id/cuadro',
  [
    param('id').isInt(),
    body('lineas').isArray(),
    body('lineas.*.row_uid').isUUID(),
    body('lineas.*.cantidad_ejecutada').isFloat({ min: 0 }),
  ],
  asyncHandler(async (req: Request<{ id: string }>, res: Response): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, error: 'Datos inválidos', details: errors.array() });
      return;
    }

    const user = req.user!;
    const id = Number(req.params.id);
    const lineas = (req.body as { lineas: { row_uid: string; cantidad_ejecutada: number }[] }).lineas;

    const cur = await query<CuentaRow>('SELECT * FROM cuentas WHERE id = $1 AND activo = TRUE', [id]);
    if (!cur.rows.length) {
      res.status(404).json({ success: false, error: 'Cuenta no encontrada' });
      return;
    }
    const cuenta = cur.rows[0];
    if (!(await userCanAccessProject(user.id, user.rol, cuenta.proyecto_id))) {
      res.status(403).json({ success: false, error: 'Sin acceso al proyecto' });
      return;
    }
    const LOCKED_STATES = ['aprobada', 'pagada', 'aprobada_institucion', 'aprobada_contraloria'];
    if (LOCKED_STATES.includes(cuenta.estado)) {
      res.status(400).json({ success: false, error: 'No se puede editar una cuenta aprobada o pagada' });
      return;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const l of lineas) {
        await client.query(
          `UPDATE cuenta_lineas SET cantidad_ejecutada = $3
             WHERE cuenta_id = $1 AND row_uid = $2`,
          [id, l.row_uid, l.cantidad_ejecutada],
        );
      }
      await actualizarEspejoCuenta(client, id);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    await registrarAudit(user.id, 'editar', 'cuenta', id, { accion: 'cuadro', filas: lineas.length });

    res.json({ success: true, data: await loadCuadro(id) });
  }),
);

// ─── Activar / quitar el desglose de una cuenta ─────────────────────────────
//
// Una cuenta nace SENCILLA (el monto se escribe a mano). Desde su detalle se
// le puede activar el desglose del proyecto: se congela una foto de sus filas
// en cuenta_lineas y a partir de ahí el monto y el % salen calculados de las
// cantidades del periodo.
//
// Reglas (acordadas con el negocio):
//  - Un proyecto NO mezcla: o todas sus cuentas llevan desglose o ninguna. Por
//    eso activar/quitar solo se permite en la PRIMERA cuenta del proyecto.
//  - El desglose que se usa es el OFICIAL del proyecto (Información → Desglose).
//  - Nada de esto en una cuenta aprobada o pagada.

const LOCKED_STATES_CUENTA = ['aprobada', 'pagada', 'aprobada_institucion', 'aprobada_contraloria'];

/** Cuenta + validaciones comunes de activar/quitar desglose. Responde y
 *  devuelve null cuando algo no cuadra. */
async function cuentaParaModoDesglose(
  req: Request<{ id: string }>,
  res: Response,
): Promise<CuentaRow | null> {
  const user = req.user!;
  const id = Number(req.params.id);

  const cur = await query<CuentaRow>(
    'SELECT * FROM cuentas WHERE id = $1 AND activo = TRUE',
    [id],
  );
  if (!cur.rows.length) {
    res.status(404).json({ success: false, error: 'Cuenta no encontrada' });
    return null;
  }
  const cuenta = cur.rows[0];

  if (!(await userCanAccessProject(user.id, user.rol, cuenta.proyecto_id))) {
    res.status(403).json({ success: false, error: 'Sin acceso al proyecto' });
    return null;
  }
  if (LOCKED_STATES_CUENTA.includes(cuenta.estado)) {
    res.status(400).json({ success: false, error: 'No se puede editar una cuenta aprobada o pagada' });
    return null;
  }

  const primera = await query<{ min: number | null }>(
    'SELECT MIN(numero) AS min FROM cuentas WHERE proyecto_id = $1 AND activo = TRUE',
    [cuenta.proyecto_id],
  );
  if (Number(primera.rows[0].min) !== cuenta.numero) {
    res.status(400).json({
      success: false,
      error: 'El desglose solo se puede activar o quitar en la primera cuenta del proyecto',
    });
    return null;
  }

  return cuenta;
}

// POST /:id/desglose — activar el desglose oficial en esta cuenta.
router.post(
  '/:id/desglose',
  [param('id').isInt()],
  asyncHandler(async (req: Request<{ id: string }>, res: Response): Promise<void> => {
    const user = req.user!;
    const id = Number(req.params.id);

    const cuenta = await cuentaParaModoDesglose(req, res);
    if (!cuenta) return;

    if (cuenta.desglose_id != null) {
      res.status(400).json({ success: false, error: 'La cuenta ya tiene un desglose' });
      return;
    }

    const oficial = await query<{ id: number }>(
      `SELECT id FROM desgloses
        WHERE proyecto_id = $1 AND tipo = 'oficial' AND activo = TRUE
        LIMIT 1`,
      [cuenta.proyecto_id],
    );
    if (!oficial.rows.length) {
      res.status(400).json({ success: false, error: 'El proyecto no tiene un desglose oficial' });
      return;
    }
    const desgloseId = oficial.rows[0].id;

    const filasRes = await query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM desglose_items WHERE desglose_id = $1',
      [desgloseId],
    );
    if (Number(filasRes.rows[0].count) === 0) {
      res.status(400).json({ success: false, error: 'El desglose oficial no tiene filas' });
      return;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM cuenta_lineas WHERE cuenta_id = $1', [id]);
      const filas = await snapshotDesgloseLines(client, id, desgloseId);
      await client.query('UPDATE cuentas SET desglose_id = $2 WHERE id = $1', [id, desgloseId]);
      // Sin cantidades todavía: el monto calculado arranca en 0.
      await actualizarEspejoCuenta(client, id);
      await client.query('COMMIT');

      await registrarAudit(user.id, 'editar', 'cuenta', id, {
        accion: 'activar_desglose',
        desglose_id: desgloseId,
        filas,
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    res.json({ success: true, data: { desglose_id: desgloseId } });
  }),
);

// DELETE /:id/desglose — quitar el desglose y volver a monto a mano. Borra la
// foto congelada; el monto queda en el último valor calculado, editable.
router.delete(
  '/:id/desglose',
  [param('id').isInt()],
  asyncHandler(async (req: Request<{ id: string }>, res: Response): Promise<void> => {
    const user = req.user!;
    const id = Number(req.params.id);

    const cuenta = await cuentaParaModoDesglose(req, res);
    if (!cuenta) return;

    if (cuenta.desglose_id == null) {
      res.status(400).json({ success: false, error: 'La cuenta no tiene desglose' });
      return;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM cuenta_lineas WHERE cuenta_id = $1', [id]);
      await client.query('UPDATE cuentas SET desglose_id = NULL WHERE id = $1', [id]);
      await client.query('COMMIT');

      await registrarAudit(user.id, 'editar', 'cuenta', id, {
        accion: 'quitar_desglose',
        desglose_id: cuenta.desglose_id,
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    res.json({ success: true });
  }),
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
