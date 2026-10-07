/**
 * Requisiciones: lo que un proyecto le pide a la oficina central —materiales,
 * servicios o un pago— con para qué es y para cuándo lo necesita.
 *
 * Lo que manda en este archivo (decisiones de Ivan, 2026-10-02 al 2026-10-06;
 * el detalle está en la migración 183):
 *
 *   * Nace POR APROBAR. Hasta que el que aprueba del proyecto la aprueba con su
 *     contraseña, solo la ven quien la escribió, quien la aprueba y los admins.
 *   * Por aprobar, la corrige quien la escribió o quien la aprueba. Si la
 *     corrige quien la aprueba, queda aprobada al guardar (pide su contraseña).
 *     Lo que cambie queda en requisicion_cambios.
 *   * Por aprobar, la anula quien la aprueba (o un admin). Aprobada ya no se
 *     anula: Compras marca sus líneas como canceladas.
 *   * Aprobada, Compras (llave Atender) marca las líneas, sube cotizaciones y
 *     cuadros comparativos. Las marcas son informativas: no cierran nada.
 *   * Cada cotización queda también en Cotizaciones: una entrada por línea, y la
 *     cotización como oferta en la entrada de cada línea que cubre. Esas filas
 *     solo se escriben desde aquí.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { body, param, validationResult } from 'express-validator';
import multer from 'multer';
import bcrypt from 'bcryptjs';
import type { PoolClient } from 'pg';
import { query, pool } from '../database/config.js';
import { authenticateToken, requireAdmin } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { getFileSignedUrl, uploadFile } from '../services/storage.js';
import { registrarAudit } from '../services/auditLog.js';
import { fixFiles } from '../utils/fileEncoding.js';
import { ES_CONSORCIO_SQL, consorcioDelProyecto } from '../services/consorcioProyecto.js';
import type { UserPermissions } from '../types/auth.js';

const router = Router();

type Estado = 'por_aprobar' | 'aprobada' | 'anulada';
type Prioridad = 'normal' | 'urgente';
type Marca = 'pendiente' | 'atendida' | 'parcial' | 'cancelada';

const PRIORIDADES: Prioridad[] = ['normal', 'urgente'];
const MARCAS: Marca[] = ['pendiente', 'atendida', 'parcial', 'cancelada'];
const TIPOS_CUENTA = ['ahorro', 'corriente'];

interface RequisicionRow {
  id: number;
  proyecto_id: number;
  consecutivo: number;
  numero: string;
  descripcion: string;
  fecha_requerida: Date;
  prioridad: Prioridad;
  notas: string | null;
  beneficiario: string | null;
  banco: string | null;
  tipo_cuenta: string | null;
  numero_cuenta: string | null;
  estado: Estado;
  creado_por: number;
  aprobada_por: number | null;
  aprobada_at: Date | null;
  anulada_por: number | null;
  anulada_at: Date | null;
  created_at: Date;
  updated_at: Date;
  /** De proyectos: quién aprueba las requisiciones de ese proyecto. */
  aprobador_id: number | null;
}

interface LineaRow {
  id: number;
  orden: number;
  cantidad: string;
  unidad: string | null;
  descripcion: string;
  renglon_desglose: string | null;
  marca: Marca;
}

interface LineaEntrada {
  cantidad: number;
  unidad: string | null;
  descripcion: string;
  renglon_desglose: string | null;
}

/** Los campos de la requisición que se escriben tal cual vienen. */
const CAMPOS = [
  'descripcion',
  'fecha_requerida',
  'prioridad',
  'notas',
  'beneficiario',
  'banco',
  'tipo_cuenta',
  'numero_cuenta',
] as const;
type Campo = (typeof CAMPOS)[number];

const ETIQUETAS: Record<Campo, string> = {
  descripcion: 'Descripción',
  fecha_requerida: 'Fecha requerida',
  prioridad: 'Prioridad',
  notas: 'Notas',
  beneficiario: 'Beneficiario',
  banco: 'Banco',
  tipo_cuenta: 'Tipo de cuenta',
  numero_cuenta: 'Número de cuenta',
};

// ---------------------------------------------------------------------------
// Quién puede qué
// ---------------------------------------------------------------------------
const esAdmin = (req: Request): boolean =>
  req.user!.rol === 'admin' || req.user!.rol === 'co-admin';

/** Una llave de usuario. admin y co-admin pasan siempre. */
const tiene = (req: Request, llave: keyof UserPermissions): boolean =>
  esAdmin(req) || !!req.user!.permissions?.[llave];

const veTodosLosProyectos = (req: Request): boolean =>
  req.user!.rol !== 'usuario' || !!req.user!.permissions?.acceso_global;

/** Que el usuario pueda tocar ESE proyecto. admin y co-admin pasan siempre. */
async function puedeElProyecto(req: Request, proyectoId: number): Promise<boolean> {
  if (veTodosLosProyectos(req)) return true;
  const r = await query(
    'SELECT 1 FROM user_project_access WHERE user_id = $1 AND proyecto_id = $2',
    [req.user!.id, proyectoId],
  );
  return r.rows.length > 0;
}

/** El filtro de proyectos que el usuario puede ver, igual que en órdenes. */
function filtroProyectos(req: Request, params: unknown[], alias = 'r'): string {
  if (veTodosLosProyectos(req)) return '';
  params.push(req.user!.id);
  return ` AND ${alias}.proyecto_id IN (SELECT proyecto_id FROM user_project_access WHERE user_id = $${params.length})`;
}

const esAutor = (req: Request, r: RequisicionRow): boolean => r.creado_por === req.user!.id;
const esAprobador = (req: Request, r: RequisicionRow): boolean =>
  r.aprobador_id !== null && r.aprobador_id === req.user!.id;

/**
 * Si la puede ver. Por aprobar es de tres personas; aprobada la ve además quien
 * tenga cualquiera de las tres llaves en ese proyecto.
 */
async function puedeVer(req: Request, r: RequisicionRow): Promise<boolean> {
  if (esAdmin(req) || esAutor(req, r) || esAprobador(req, r)) return true;
  if (r.estado !== 'aprobada') return false;
  const conLlave =
    tiene(req, 'requisiciones_ver') ||
    tiene(req, 'requisiciones_crear') ||
    tiene(req, 'requisiciones_atender');
  return conLlave && (await puedeElProyecto(req, r.proyecto_id));
}

const puedeEditar = (req: Request, r: RequisicionRow): boolean =>
  r.estado === 'por_aprobar' && (esAutor(req, r) || esAprobador(req, r) || esAdmin(req));

const puedeAprobar = (req: Request, r: RequisicionRow): boolean =>
  r.estado === 'por_aprobar' && esAprobador(req, r);

const puedeAnular = (req: Request, r: RequisicionRow): boolean =>
  r.estado === 'por_aprobar' && (esAprobador(req, r) || esAdmin(req));

async function puedeAtender(req: Request, r: RequisicionRow): Promise<boolean> {
  if (r.estado !== 'aprobada') return false;
  if (esAdmin(req)) return true;
  return !!req.user!.permissions?.requisiciones_atender && (await puedeElProyecto(req, r.proyecto_id));
}

// ---------------------------------------------------------------------------
// Lectura y escritura
// ---------------------------------------------------------------------------
type Db = Pick<PoolClient, 'query'>;

async function traer(id: string | number, db: Db = pool, bloquear = false): Promise<RequisicionRow | null> {
  const r = await db.query<RequisicionRow>(
    `SELECT r.*, p.requisicion_aprobador_id AS aprobador_id
       FROM requisiciones r
       JOIN proyectos p ON p.id = r.proyecto_id
      WHERE r.id = $1${bloquear ? ' FOR UPDATE OF r' : ''}`,
    [id],
  );
  return r.rows[0] ?? null;
}

async function lineasDe(id: number, db: Db = pool): Promise<LineaRow[]> {
  const r = await db.query<LineaRow>(
    `SELECT id, orden, cantidad, unidad, descripcion, renglon_desglose, marca
       FROM requisicion_lineas WHERE requisicion_id = $1 ORDER BY orden, id`,
    [id],
  );
  return r.rows;
}

/**
 * pg arma un DATE como Date a la medianoche LOCAL del servidor: se lee con los
 * getters locales. Con toISOString, un servidor al este de Greenwich lo correría
 * un día para atrás.
 */
const aDia = (d: Date | string | null): string | null => {
  if (d === null) return null;
  if (typeof d === 'string') return d.slice(0, 10);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * El número que le toca: REQ-<prefijo>-NNN. Arranca en el número inicial del
 * proyecto mientras no haya ninguna más alta (Santa Isabel arranca en 175).
 * Se cuentan también las anuladas: el número es una secuencia y no se reusa.
 */
async function siguienteNumero(
  db: Db,
  proyectoId: number,
): Promise<{ consecutivo: number; numero: string }> {
  const p = await db.query<{ sp_prefijo: string | null; requisicion_numero_inicial: number }>(
    'SELECT sp_prefijo, requisicion_numero_inicial FROM proyectos WHERE id = $1',
    [proyectoId],
  );
  if (p.rows.length === 0) throw new Error('PROYECTO_NO_ENCONTRADO');
  const prefijo = p.rows[0].sp_prefijo;
  if (!prefijo) throw new Error('PREFIJO_NO_CONFIGURADO');
  const max = await db.query<{ max: number }>(
    'SELECT COALESCE(MAX(consecutivo), 0)::int AS max FROM requisiciones WHERE proyecto_id = $1',
    [proyectoId],
  );
  const consecutivo = Math.max(max.rows[0].max, p.rows[0].requisicion_numero_inicial - 1) + 1;
  return { consecutivo, numero: `REQ-${prefijo}-${String(consecutivo).padStart(3, '0')}` };
}

async function claveCorrecta(userId: number, password: unknown): Promise<boolean> {
  if (typeof password !== 'string' || !password) return false;
  const u = await query<{ password: string | null }>('SELECT password FROM users WHERE id = $1', [userId]);
  const hash = u.rows[0]?.password;
  return !!hash && (await bcrypt.compare(password, hash));
}

/** Aprobarla, dentro de la transacción abierta. */
async function aprobarDentro(db: PoolClient, r: RequisicionRow, userId: number): Promise<void> {
  await db.query(
    `UPDATE requisiciones
        SET estado = 'aprobada', aprobada_por = $2, aprobada_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
      WHERE id = $1`,
    [r.id, userId],
  );
  await registrarAudit(userId, 'aprobar', 'requisicion', r.id, { numero: r.numero }, db);
}

const erroresDeValidacion = (req: Request, res: Response): boolean => {
  const errores = validationResult(req);
  if (errores.isEmpty()) return false;
  res.status(400).json({ success: false, error: errores.array()[0].msg as string });
  return true;
};

// ---------------------------------------------------------------------------
// Lo que llega del formulario
// ---------------------------------------------------------------------------
const texto = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};

const esDia = (v: unknown): boolean => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};

/**
 * Valida y normaliza lo que viene. Con `completa` todo lo obligatorio tiene que
 * estar (crear); sin ella, solo se mira lo que vino (editar). Devuelve el error
 * para la persona, o los valores ya limpios.
 */
function leerCuerpo(
  b: Record<string, unknown>,
  completa: boolean,
): { error: string } | { campos: Partial<Record<Campo, string | null>>; lineas: LineaEntrada[] | null } {
  const campos: Partial<Record<Campo, string | null>> = {};
  const viene = (c: string) => completa || c in b;

  if (viene('descripcion')) {
    const d = texto(b.descripcion);
    if (!d) return { error: 'La descripción es obligatoria' };
    if (d.length > 300) return { error: 'La descripción pasa de 300 letras' };
    campos.descripcion = d;
  }
  if (viene('fecha_requerida')) {
    if (!esDia(b.fecha_requerida)) return { error: 'La fecha requerida es obligatoria' };
    campos.fecha_requerida = b.fecha_requerida as string;
  }
  if (viene('prioridad')) {
    const p = b.prioridad ?? 'normal';
    if (!PRIORIDADES.includes(p as Prioridad)) return { error: 'La prioridad es normal o urgente' };
    campos.prioridad = p as string;
  }
  for (const c of ['notas', 'beneficiario', 'banco', 'numero_cuenta'] as const) {
    if (!(c in b)) continue;
    const v = texto(b[c]);
    const tope = c === 'notas' ? 5000 : c === 'numero_cuenta' ? 100 : 255;
    if (v && v.length > tope) return { error: `${ETIQUETAS[c]} es demasiado largo` };
    campos[c] = v;
  }
  if ('tipo_cuenta' in b) {
    const t = texto(b.tipo_cuenta);
    if (t && !TIPOS_CUENTA.includes(t)) return { error: 'El tipo de cuenta es ahorro o corriente' };
    campos.tipo_cuenta = t;
  }

  let lineas: LineaEntrada[] | null = null;
  if (viene('lineas')) {
    if (!Array.isArray(b.lineas) || b.lineas.length === 0) {
      return { error: 'La requisición necesita al menos una línea' };
    }
    if (b.lineas.length > 200) return { error: 'Una requisición lleva hasta 200 líneas' };
    lineas = [];
    for (const [i, crudo] of (b.lineas as Record<string, unknown>[]).entries()) {
      const n = i + 1;
      const cantidad = Number(crudo?.cantidad);
      const descripcion = texto(crudo?.descripcion);
      if (!descripcion) return { error: `La línea ${n} necesita descripción` };
      if (!Number.isFinite(cantidad) || cantidad <= 0 || cantidad >= 1e11) {
        return { error: `La línea ${n} necesita una cantidad mayor que cero` };
      }
      const unidad = texto(crudo?.unidad);
      const renglon = texto(crudo?.renglon_desglose);
      if (descripcion.length > 500) return { error: `La descripción de la línea ${n} es demasiado larga` };
      if (unidad && unidad.length > 50) return { error: `La unidad de la línea ${n} es demasiado larga` };
      if (renglon && renglon.length > 100) return { error: `El renglón del desglose de la línea ${n} es demasiado largo` };
      lineas.push({ cantidad, unidad, descripcion, renglon_desglose: renglon });
    }
  }
  return { campos, lineas };
}

async function escribirLineas(db: PoolClient, requisicionId: number, lineas: LineaEntrada[]): Promise<void> {
  for (const [i, l] of lineas.entries()) {
    await db.query(
      `INSERT INTO requisicion_lineas (requisicion_id, orden, cantidad, unidad, descripcion, renglon_desglose)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [requisicionId, i, l.cantidad, l.unidad, l.descripcion, l.renglon_desglose],
    );
  }
}

/** Lo que cambió en las líneas, una entrada por cosa, como lo lee una persona. */
function cambiosDeLineas(
  antes: LineaRow[],
  despues: LineaEntrada[],
): { campo: string; antes: unknown; despues: unknown }[] {
  const out: { campo: string; antes: unknown; despues: unknown }[] = [];
  const total = Math.max(antes.length, despues.length);
  for (let i = 0; i < total; i++) {
    const a = antes[i];
    const d = despues[i];
    const n = i + 1;
    if (!d) {
      out.push({ campo: `Línea ${n}`, antes: a.descripcion, despues: null });
      continue;
    }
    if (!a) {
      out.push({ campo: `Línea ${n}`, antes: null, despues: d.descripcion });
      continue;
    }
    if (Number(a.cantidad) !== d.cantidad) out.push({ campo: `Línea ${n} · Cantidad`, antes: Number(a.cantidad), despues: d.cantidad });
    if ((a.unidad ?? null) !== d.unidad) out.push({ campo: `Línea ${n} · Unidad`, antes: a.unidad, despues: d.unidad });
    if (a.descripcion !== d.descripcion) out.push({ campo: `Línea ${n} · Descripción`, antes: a.descripcion, despues: d.descripcion });
    if ((a.renglon_desglose ?? null) !== d.renglon_desglose) {
      out.push({ campo: `Línea ${n} · Renglón del desglose`, antes: a.renglon_desglose, despues: d.renglon_desglose });
    }
  }
  return out;
}

/** «1», «1 y 2», «1, 2 y 3». */
function enumerar(numeros: number[]): string {
  if (numeros.length <= 1) return numeros.join('');
  return `${numeros.slice(0, -1).join(', ')} y ${numeros[numeros.length - 1]}`;
}

/** Los números de línea (1, 2, 3…) de unos ids, en el orden de la requisición. */
async function numerosDeLineas(db: Db, requisicionId: number, ids: number[]): Promise<Map<number, number> | null> {
  const lineas = await lineasDe(requisicionId, db);
  const pos = new Map(lineas.map((l, i) => [l.id, i + 1]));
  for (const id of ids) if (!pos.has(id)) return null;
  return pos;
}

// ---------------------------------------------------------------------------
// GET /pendientes — los globitos rojos
// ---------------------------------------------------------------------------
// Al que aprueba: las que esperan su aprobación. A Compras: las aprobadas que
// todavía tienen alguna línea pendiente. El de Compras sale solo a quien tiene
// la llave Atender puesta (no a los admins por serlo): el globito es trabajo
// asignado, no permiso.
router.get(
  '/pendientes',
  authenticateToken,
  asyncHandler(async (req: Request, res: Response) => {
    const porProyecto: Record<number, number> = {};
    const sumar = (filas: { proyecto_id: number; n: number }[]) => {
      let total = 0;
      for (const f of filas) {
        porProyecto[f.proyecto_id] = (porProyecto[f.proyecto_id] ?? 0) + f.n;
        total += f.n;
      }
      return total;
    };

    const aprobar = await query<{ proyecto_id: number; n: number }>(
      `SELECT r.proyecto_id, COUNT(*)::int AS n
         FROM requisiciones r
         JOIN proyectos p ON p.id = r.proyecto_id
        WHERE r.estado = 'por_aprobar' AND p.requisicion_aprobador_id = $1
        GROUP BY r.proyecto_id`,
      [req.user!.id],
    );
    const porAprobar = sumar(aprobar.rows);

    let porAtender = 0;
    if (req.user!.permissions?.requisiciones_atender) {
      const params: unknown[] = [];
      const filtro = filtroProyectos(req, params);
      const atender = await query<{ proyecto_id: number; n: number }>(
        `SELECT r.proyecto_id, COUNT(*)::int AS n
           FROM requisiciones r
          WHERE r.estado = 'aprobada'
            AND EXISTS (SELECT 1 FROM requisicion_lineas l
                         WHERE l.requisicion_id = r.id AND l.marca = 'pendiente')${filtro}
          GROUP BY r.proyecto_id`,
        params,
      );
      porAtender = sumar(atender.rows);
    }

    // Los proyectos donde aprueba: el menú le enseña Requisiciones aunque no
    // tenga ninguna de las tres llaves, porque aprobar no pide llave.
    const aprueba = await query<{ id: number }>(
      'SELECT id FROM proyectos WHERE requisicion_aprobador_id = $1',
      [req.user!.id],
    );

    res.json({
      success: true,
      data: {
        total: porAprobar + porAtender,
        por_aprobar: porAprobar,
        por_atender: porAtender,
        por_proyecto: porProyecto,
        aprueba_en: aprueba.rows.map((r) => r.id),
      },
    });
  }),
);

// ---------------------------------------------------------------------------
// GET / — la lista: aprobadas, o por aprobar
// ---------------------------------------------------------------------------
// Paginada en el servidor, como los reportes: con los años una obra junta
// cientos. ?vista=aprobadas|por_aprobar &proyecto_id &buscar &solo_pendientes
// &pagina &tamano
router.get(
  '/',
  authenticateToken,
  asyncHandler(async (req: Request, res: Response) => {
    const vista = req.query.vista === 'por_aprobar' ? 'por_aprobar' : 'aprobadas';
    const pagina = Math.max(1, parseInt(String(req.query.pagina ?? '1'), 10) || 1);
    const tamano = Math.min(100, Math.max(1, parseInt(String(req.query.tamano ?? '25'), 10) || 25));
    const params: unknown[] = [];
    const donde: string[] = [];

    params.push(vista === 'por_aprobar' ? 'por_aprobar' : 'aprobada');
    donde.push(`r.estado = $${params.length}`);

    if (req.query.proyecto_id !== undefined) {
      const pid = parseInt(String(req.query.proyecto_id), 10);
      if (!Number.isInteger(pid)) {
        res.status(400).json({ success: false, error: 'Proyecto inválido' });
        return;
      }
      params.push(pid);
      donde.push(`r.proyecto_id = $${params.length}`);
    }

    // Quién ve qué. Por aprobar: lo suyo, lo que le toca aprobar, o todo si es
    // admin. Aprobadas: además, lo de sus proyectos si tiene alguna llave.
    if (!esAdmin(req)) {
      params.push(req.user!.id);
      const yo = `$${params.length}`;
      const propias = `(r.creado_por = ${yo} OR p.requisicion_aprobador_id = ${yo})`;
      const conLlave =
        vista === 'aprobadas' &&
        (tiene(req, 'requisiciones_ver') || tiene(req, 'requisiciones_crear') || tiene(req, 'requisiciones_atender'));
      if (conLlave) {
        const filtro = filtroProyectos(req, params);
        donde.push(`(${propias} OR (true${filtro}))`);
      } else {
        donde.push(propias);
      }
    }

    const buscar = texto(req.query.buscar);
    if (buscar) {
      params.push(`%${buscar}%`);
      const b = `$${params.length}`;
      donde.push(`(r.numero ILIKE ${b} OR r.descripcion ILIKE ${b}
               OR EXISTS (SELECT 1 FROM requisicion_lineas l WHERE l.requisicion_id = r.id AND l.descripcion ILIKE ${b}))`);
    }
    if (req.query.solo_pendientes === 'true') {
      donde.push(`EXISTS (SELECT 1 FROM requisicion_lineas l WHERE l.requisicion_id = r.id AND l.marca = 'pendiente')`);
    }

    const where = donde.join(' AND ');
    const total = await query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM requisiciones r JOIN proyectos p ON p.id = r.proyecto_id WHERE ${where}`,
      params,
    );
    const filas = await query(
      `SELECT r.id, r.numero, r.proyecto_id, COALESCE(NULLIF(p.nombre_corto, ''), p.nombre) AS proyecto_nombre,
              r.descripcion, r.created_at, r.fecha_requerida, r.prioridad, r.estado,
              u.nombre AS creado_por_nombre,
              (SELECT COUNT(*)::int FROM requisicion_lineas l WHERE l.requisicion_id = r.id) AS lineas,
              (SELECT COUNT(*)::int FROM requisicion_lineas l
                WHERE l.requisicion_id = r.id AND l.marca = 'pendiente') AS lineas_pendientes
         FROM requisiciones r
         JOIN proyectos p ON p.id = r.proyecto_id
         JOIN users u ON u.id = r.creado_por
        WHERE ${where}
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, tamano, (pagina - 1) * tamano],
    );

    res.json({ success: true, data: filas.rows, total: total.rows[0].n, pagina, tamano });
  }),
);

// ---------------------------------------------------------------------------
// Ajustes del proyecto: quién aprueba y con qué número arranca
// ---------------------------------------------------------------------------
router.get(
  '/proyecto/:proyectoId/ajustes',
  authenticateToken,
  [param('proyectoId').isInt()],
  asyncHandler(async (req: Request<{ proyectoId: string }>, res: Response) => {
    if (erroresDeValidacion(req, res)) return;
    const pid = Number(req.params.proyectoId);
    if (!(await puedeElProyecto(req, pid))) {
      res.status(403).json({ success: false, error: 'Sin acceso a ese proyecto' });
      return;
    }
    const p = await query<{
      aprobador_id: number | null;
      aprobador_nombre: string | null;
      numero_inicial: number;
      prefijo: string | null;
    }>(
      `SELECT p.requisicion_aprobador_id AS aprobador_id, u.nombre AS aprobador_nombre,
              p.requisicion_numero_inicial AS numero_inicial, p.sp_prefijo AS prefijo
         FROM proyectos p LEFT JOIN users u ON u.id = p.requisicion_aprobador_id
        WHERE p.id = $1`,
      [pid],
    );
    if (p.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Proyecto no encontrado' });
      return;
    }
    const ultima = await query<{ max: number }>(
      'SELECT COALESCE(MAX(consecutivo), 0)::int AS max FROM requisiciones WHERE proyecto_id = $1',
      [pid],
    );
    const fila = p.rows[0];
    const siguiente = Math.max(ultima.rows[0].max, fila.numero_inicial - 1) + 1;
    res.json({
      success: true,
      data: {
        ...fila,
        ultima: ultima.rows[0].max || null,
        siguiente: fila.prefijo ? `REQ-${fila.prefijo}-${String(siguiente).padStart(3, '0')}` : null,
      },
    });
  }),
);

// Cambiarlos es de admin/co-admin, igual que los aprobadores de pagos.
router.put(
  '/proyecto/:proyectoId/ajustes',
  authenticateToken,
  requireAdmin,
  [param('proyectoId').isInt()],
  asyncHandler(async (req: Request<{ proyectoId: string }>, res: Response) => {
    if (erroresDeValidacion(req, res)) return;
    const pid = Number(req.params.proyectoId);
    const actual = await query<{ requisicion_aprobador_id: number | null; requisicion_numero_inicial: number }>(
      'SELECT requisicion_aprobador_id, requisicion_numero_inicial FROM proyectos WHERE id = $1',
      [pid],
    );
    if (actual.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Proyecto no encontrado' });
      return;
    }

    // El SET se arma solo con lo que viene.
    const sets: string[] = [];
    const valores: unknown[] = [];
    const cambios: Record<string, { antes: unknown; despues: unknown }> = {};

    if ('aprobador_id' in req.body) {
      const nuevo = req.body.aprobador_id === null ? null : Number(req.body.aprobador_id);
      if (nuevo !== null) {
        const u = Number.isInteger(nuevo)
          ? await query("SELECT 1 FROM users WHERE id = $1 AND activo = true AND tipo_usuario <> 'externo'", [nuevo])
          : { rows: [] };
        if (u.rows.length === 0) {
          res.status(400).json({ success: false, error: 'Esa persona no es un usuario activo del sistema' });
          return;
        }
      }
      valores.push(nuevo);
      sets.push(`requisicion_aprobador_id = $${valores.length}`);
      cambios.aprobador_id = { antes: actual.rows[0].requisicion_aprobador_id, despues: nuevo };
    }
    if ('numero_inicial' in req.body) {
      const n = Number(req.body.numero_inicial);
      if (!Number.isInteger(n) || n < 1 || n > 999999) {
        res.status(400).json({ success: false, error: 'El número inicial es un entero mayor que cero' });
        return;
      }
      const ultima = await query<{ max: number }>(
        'SELECT COALESCE(MAX(consecutivo), 0)::int AS max FROM requisiciones WHERE proyecto_id = $1',
        [pid],
      );
      if (ultima.rows[0].max > 0 && n <= ultima.rows[0].max) {
        res.status(400).json({
          success: false,
          error: `Este proyecto ya va por la requisición ${ultima.rows[0].max}: el número inicial ya no la cambia`,
        });
        return;
      }
      valores.push(n);
      sets.push(`requisicion_numero_inicial = $${valores.length}`);
      cambios.numero_inicial = { antes: actual.rows[0].requisicion_numero_inicial, despues: n };
    }
    if (sets.length === 0) {
      res.json({ success: true, message: 'Nada que cambiar' });
      return;
    }

    valores.push(pid);
    await query(`UPDATE proyectos SET ${sets.join(', ')} WHERE id = $${valores.length}`, valores);
    await registrarAudit(req.user!.id, 'editar_ajustes_requisiciones', 'proyecto', pid, cambios);
    res.json({ success: true });
  }),
);

// ---------------------------------------------------------------------------
// GET /:id — una requisición por dentro
// ---------------------------------------------------------------------------
router.get(
  '/:id',
  authenticateToken,
  [param('id').isInt()],
  asyncHandler(async (req: Request<{ id: string }>, res: Response) => {
    if (erroresDeValidacion(req, res)) return;
    const r = await traer(req.params.id);
    if (!r || !(await puedeVer(req, r))) {
      res.status(404).json({ success: false, error: 'Requisición no encontrada' });
      return;
    }

    const [cab, lineas, adjuntos, adjLineas, cotiz, cotizLineas, cambios] = await Promise.all([
      query(
        `SELECT COALESCE(NULLIF(p.nombre_corto, ''), p.nombre) AS proyecto_nombre,
                uc.nombre AS creado_por_nombre, ua.nombre AS aprobada_por_nombre,
                un.nombre AS anulada_por_nombre, ap.nombre AS aprobador_nombre
           FROM requisiciones r
           JOIN proyectos p ON p.id = r.proyecto_id
           JOIN users uc ON uc.id = r.creado_por
           LEFT JOIN users ua ON ua.id = r.aprobada_por
           LEFT JOIN users un ON un.id = r.anulada_por
           LEFT JOIN users ap ON ap.id = p.requisicion_aprobador_id
          WHERE r.id = $1`,
        [r.id],
      ),
      query(
        `SELECT l.id, l.orden, l.cantidad, l.unidad, l.descripcion, l.renglon_desglose, l.marca,
                l.marca_at, u.nombre AS marca_por_nombre
           FROM requisicion_lineas l LEFT JOIN users u ON u.id = l.marca_por
          WHERE l.requisicion_id = $1 ORDER BY l.orden, l.id`,
        [r.id],
      ),
      query<{ id: number }>(
        `SELECT a.id, a.tipo, a.nombre_original, a.tipo_mime, a.tamano, a.descripcion, a.created_at,
                u.nombre AS subido_por_nombre
           FROM requisicion_adjuntos a JOIN users u ON u.id = a.subido_por
          WHERE a.requisicion_id = $1 AND a.activo = true ORDER BY a.created_at, a.id`,
        [r.id],
      ),
      query<{ adjunto_id: number; linea_id: number }>(
        `SELECT al.adjunto_id, al.linea_id FROM requisicion_adjunto_lineas al
           JOIN requisicion_adjuntos a ON a.id = al.adjunto_id
          WHERE a.requisicion_id = $1`,
        [r.id],
      ),
      query<{ id: number }>(
        `SELECT c.id, c.proveedor, c.monto, c.nombre_original, c.tipo_mime, c.tamano, c.created_at,
                u.nombre AS subido_por_nombre
           FROM requisicion_cotizaciones c JOIN users u ON u.id = c.subido_por
          WHERE c.requisicion_id = $1 AND c.activo = true ORDER BY c.created_at, c.id`,
        [r.id],
      ),
      // Las líneas que cubre cada cotización salen de sus ofertas en
      // Cotizaciones: una por línea cubierta.
      query<{ cotizacion_id: number; linea_id: number }>(
        `SELECT o.requisicion_cotizacion_id AS cotizacion_id, ct.requisicion_linea_id AS linea_id
           FROM cotizacion_ofertas o
           JOIN cotizaciones ct ON ct.id = o.cotizacion_id
           JOIN requisicion_cotizaciones rc ON rc.id = o.requisicion_cotizacion_id
          WHERE rc.requisicion_id = $1 AND o.activo = true`,
        [r.id],
      ),
      query(
        `SELECT c.id, c.cambios, c.created_at, u.nombre AS user_nombre
           FROM requisicion_cambios c JOIN users u ON u.id = c.user_id
          WHERE c.requisicion_id = $1 ORDER BY c.created_at, c.id`,
        [r.id],
      ),
    ]);

    const agrupar = (pares: [number, number][]) => {
      const m = new Map<number, number[]>();
      for (const [dueno, linea] of pares) m.set(dueno, [...(m.get(dueno) ?? []), linea]);
      return m;
    };
    const lineasDeAdjunto = agrupar(adjLineas.rows.map((f) => [f.adjunto_id, f.linea_id]));
    const lineasDeCotiz = agrupar(cotizLineas.rows.map((f) => [f.cotizacion_id, f.linea_id]));

    const { aprobador_id, ...resto } = r;
    res.json({
      success: true,
      data: {
        ...resto,
        fecha_requerida: aDia(r.fecha_requerida),
        aprobador_id,
        ...cab.rows[0],
        lineas: lineas.rows,
        adjuntos: adjuntos.rows.map((a) => ({ ...a, lineas: lineasDeAdjunto.get(a.id) ?? [] })),
        cotizaciones: cotiz.rows.map((c) => ({ ...c, lineas: lineasDeCotiz.get(c.id) ?? [] })),
        cambios: cambios.rows,
        puede: {
          editar: puedeEditar(req, r),
          aprobar: puedeAprobar(req, r),
          anular: puedeAnular(req, r),
          atender: await puedeAtender(req, r),
        },
      },
    });
  }),
);

// ---------------------------------------------------------------------------
// POST / — escribirla
// ---------------------------------------------------------------------------
// Si quien la escribe es el mismo que aprueba (Hilario escribe la suya), puede
// mandarla ya aprobada con { aprobar: true, password }: es la misma regla de
// cuando la corrige él.
router.post(
  '/',
  authenticateToken,
  [body('proyecto_id').isInt().withMessage('El proyecto es obligatorio')],
  asyncHandler(async (req: Request, res: Response) => {
    if (erroresDeValidacion(req, res)) return;
    const proyectoId = Number(req.body.proyecto_id);

    if (!tiene(req, 'requisiciones_crear')) {
      res.status(403).json({ success: false, error: 'No tienes permiso para escribir requisiciones' });
      return;
    }
    if (!(await puedeElProyecto(req, proyectoId))) {
      res.status(403).json({ success: false, error: 'Sin acceso a ese proyecto' });
      return;
    }
    const leido = leerCuerpo(req.body as Record<string, unknown>, true);
    if ('error' in leido) {
      res.status(400).json({ success: false, error: leido.error });
      return;
    }

    const proy = await query<{ requisicion_aprobador_id: number | null }>(
      'SELECT requisicion_aprobador_id FROM proyectos WHERE id = $1',
      [proyectoId],
    );
    if (proy.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Proyecto no encontrado' });
      return;
    }
    // Sin quién la apruebe se quedaría por aprobar para siempre.
    const aprobador = proy.rows[0].requisicion_aprobador_id;
    if (aprobador === null) {
      res.status(400).json({ success: false, error: 'Configure quién aprueba las requisiciones del proyecto' });
      return;
    }
    const aprobarYa = req.body.aprobar === true;
    if (aprobarYa) {
      if (aprobador !== req.user!.id) {
        res.status(403).json({ success: false, error: 'Solo quien aprueba las requisiciones del proyecto puede mandarla aprobada' });
        return;
      }
      if (!(await claveCorrecta(req.user!.id, req.body.password))) {
        // 403 y no 401: la pantalla toma cualquier 401 como sesión vencida.
        res.status(403).json({ success: false, error: 'Contraseña incorrecta' });
        return;
      }
    }

    const c = leido.campos;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // La numeración se serializa por proyecto, en su propio espacio de
      // candados: no espera a las solicitudes ni a las órdenes.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('requisiciones'), $1)", [proyectoId]);

      let numero: { consecutivo: number; numero: string };
      try {
        numero = await siguienteNumero(client, proyectoId);
      } catch (err) {
        await client.query('ROLLBACK');
        if ((err as Error).message === 'PREFIJO_NO_CONFIGURADO') {
          res.status(400).json({ success: false, error: 'Configure el prefijo del proyecto antes de crear requisiciones' });
          return;
        }
        throw err;
      }

      const nueva = await client.query<RequisicionRow>(
        `INSERT INTO requisiciones (
           proyecto_id, consecutivo, numero, descripcion, fecha_requerida, prioridad, notas,
           beneficiario, banco, tipo_cuenta, numero_cuenta, creado_por
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING *`,
        [
          proyectoId,
          numero.consecutivo,
          numero.numero,
          c.descripcion,
          c.fecha_requerida,
          c.prioridad ?? 'normal',
          c.notas ?? null,
          c.beneficiario ?? null,
          c.banco ?? null,
          c.tipo_cuenta ?? null,
          c.numero_cuenta ?? null,
          req.user!.id,
        ],
      );
      const fila = { ...nueva.rows[0], aprobador_id: aprobador };
      await escribirLineas(client, fila.id, leido.lineas!);
      await registrarAudit(
        req.user!.id,
        'crear',
        'requisicion',
        fila.id,
        { numero: fila.numero, lineas: leido.lineas!.length },
        client,
      );
      if (aprobarYa) await aprobarDentro(client, fila, req.user!.id);
      await client.query('COMMIT');
      res.status(201).json({
        success: true,
        data: { id: fila.id, numero: fila.numero, estado: aprobarYa ? 'aprobada' : 'por_aprobar' },
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }),
);

// ---------------------------------------------------------------------------
// PUT /:id — corregirla antes de aprobar
// ---------------------------------------------------------------------------
// La corrige quien la escribió, quien la aprueba o un admin. Si la corrige
// quien la aprueba, queda aprobada al guardar y por eso pide su contraseña.
router.put(
  '/:id',
  authenticateToken,
  [param('id').isInt()],
  asyncHandler(async (req: Request<{ id: string }>, res: Response) => {
    if (erroresDeValidacion(req, res)) return;
    const antes = await traer(req.params.id);
    if (!antes || !(await puedeVer(req, antes))) {
      res.status(404).json({ success: false, error: 'Requisición no encontrada' });
      return;
    }
    if (!puedeEditar(req, antes)) {
      res.status(antes.estado === 'por_aprobar' ? 403 : 400).json({
        success: false,
        error: antes.estado === 'por_aprobar'
          ? 'No puedes corregir esta requisición'
          : 'Solo se corrige mientras está por aprobar',
      });
      return;
    }
    const leido = leerCuerpo(req.body as Record<string, unknown>, false);
    if ('error' in leido) {
      res.status(400).json({ success: false, error: leido.error });
      return;
    }
    const apruebaAlGuardar = esAprobador(req, antes);
    if (apruebaAlGuardar && !(await claveCorrecta(req.user!.id, req.body.password))) {
      res.status(403).json({ success: false, error: 'Contraseña incorrecta' });
      return;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const r = await traer(antes.id, client, true);
      if (!r || r.estado !== 'por_aprobar') {
        await client.query('ROLLBACK');
        res.status(409).json({ success: false, error: 'Mientras tanto la aprobaron o la anularon' });
        return;
      }

      // El SET se arma SOLO con lo que viene: una lista fija no distingue «no
      // toco esto» de «déjalo en blanco».
      const sets: string[] = [];
      const valores: unknown[] = [];
      const lineas: { campo: string; antes: unknown; despues: unknown }[] = [];
      for (const campo of CAMPOS) {
        if (!(campo in leido.campos)) continue;
        const nuevo = leido.campos[campo] ?? null;
        const viejo = campo === 'fecha_requerida' ? aDia(r.fecha_requerida) : (r[campo] as string | null);
        if ((viejo ?? null) === nuevo) continue;
        valores.push(nuevo);
        sets.push(`${campo} = $${valores.length}`);
        lineas.push({ campo: ETIQUETAS[campo], antes: viejo, despues: nuevo });
      }
      if (leido.lineas) {
        const viejas = await lineasDe(r.id, client);
        const delta = cambiosDeLineas(viejas, leido.lineas);
        if (delta.length > 0) {
          // Por aprobar, las líneas no tienen marcas ni cotizaciones encima:
          // se reescriben.
          await client.query('DELETE FROM requisicion_lineas WHERE requisicion_id = $1', [r.id]);
          await escribirLineas(client, r.id, leido.lineas);
          lineas.push(...delta);
        }
      }

      if (sets.length > 0) {
        valores.push(r.id);
        await client.query(
          `UPDATE requisiciones SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $${valores.length}`,
          valores,
        );
      }
      if (lineas.length > 0) {
        await client.query(
          'INSERT INTO requisicion_cambios (requisicion_id, user_id, cambios) VALUES ($1, $2, $3::jsonb)',
          [r.id, req.user!.id, JSON.stringify(lineas)],
        );
        await registrarAudit(req.user!.id, 'editar', 'requisicion', r.id, { numero: r.numero, cambios: lineas }, client);
      }
      if (apruebaAlGuardar) await aprobarDentro(client, r, req.user!.id);
      await client.query('COMMIT');
      res.json({
        success: true,
        data: { id: r.id, estado: apruebaAlGuardar ? 'aprobada' : 'por_aprobar', cambios: lineas.length },
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }),
);

// ---------------------------------------------------------------------------
// POST /:id/aprobar y /:id/anular
// ---------------------------------------------------------------------------
router.post(
  '/:id/aprobar',
  authenticateToken,
  [param('id').isInt()],
  asyncHandler(async (req: Request<{ id: string }>, res: Response) => {
    if (erroresDeValidacion(req, res)) return;
    const antes = await traer(req.params.id);
    if (!antes || !(await puedeVer(req, antes))) {
      res.status(404).json({ success: false, error: 'Requisición no encontrada' });
      return;
    }
    if (!puedeAprobar(req, antes)) {
      res.status(antes.estado === 'por_aprobar' ? 403 : 400).json({
        success: false,
        error: antes.estado === 'por_aprobar'
          ? 'Solo quien aprueba las requisiciones del proyecto la puede aprobar'
          : 'Esta requisición ya no está por aprobar',
      });
      return;
    }
    if (!(await claveCorrecta(req.user!.id, req.body?.password))) {
      res.status(403).json({ success: false, error: 'Contraseña incorrecta' });
      return;
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const r = await traer(antes.id, client, true);
      if (!r || r.estado !== 'por_aprobar') {
        await client.query('ROLLBACK');
        res.status(409).json({ success: false, error: 'Mientras tanto la aprobaron o la anularon' });
        return;
      }
      await aprobarDentro(client, r, req.user!.id);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    res.json({ success: true, message: 'Requisición aprobada' });
  }),
);

router.post(
  '/:id/anular',
  authenticateToken,
  [param('id').isInt()],
  asyncHandler(async (req: Request<{ id: string }>, res: Response) => {
    if (erroresDeValidacion(req, res)) return;
    const antes = await traer(req.params.id);
    if (!antes || !(await puedeVer(req, antes))) {
      res.status(404).json({ success: false, error: 'Requisición no encontrada' });
      return;
    }
    if (!puedeAnular(req, antes)) {
      res.status(antes.estado === 'por_aprobar' ? 403 : 400).json({
        success: false,
        error: antes.estado === 'por_aprobar'
          ? 'Solo quien aprueba las requisiciones del proyecto la puede anular'
          : 'Ya aprobada no se anula: en Compras se marcan sus líneas como canceladas',
      });
      return;
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const r = await traer(antes.id, client, true);
      if (!r || r.estado !== 'por_aprobar') {
        await client.query('ROLLBACK');
        res.status(409).json({ success: false, error: 'Mientras tanto la aprobaron o la anularon' });
        return;
      }
      await client.query(
        `UPDATE requisiciones
            SET estado = 'anulada', anulada_por = $2, anulada_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP
          WHERE id = $1`,
        [r.id, req.user!.id],
      );
      await registrarAudit(req.user!.id, 'anular', 'requisicion', r.id, { numero: r.numero }, client);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    res.json({ success: true, message: 'Requisición anulada' });
  }),
);

// ---------------------------------------------------------------------------
// PATCH /:id/marcas — Compras marca las líneas
// ---------------------------------------------------------------------------
// { lineas: [{ id, marca }] } o { todas: marca }. Solo informativas: no cierran
// la requisición ni bloquean nada.
router.patch(
  '/:id/marcas',
  authenticateToken,
  [param('id').isInt()],
  asyncHandler(async (req: Request<{ id: string }>, res: Response) => {
    if (erroresDeValidacion(req, res)) return;
    const r = await traer(req.params.id);
    if (!r || !(await puedeVer(req, r))) {
      res.status(404).json({ success: false, error: 'Requisición no encontrada' });
      return;
    }
    if (!(await puedeAtender(req, r))) {
      res.status(r.estado === 'aprobada' ? 403 : 400).json({
        success: false,
        error: r.estado === 'aprobada'
          ? 'Las marcas las pone Compras'
          : 'Solo se marcan las líneas de una requisición aprobada',
      });
      return;
    }

    const lineas = await lineasDe(r.id);
    let pedidas: { id: number; marca: Marca }[];
    if (req.body?.todas !== undefined) {
      if (!MARCAS.includes(req.body.todas)) {
        res.status(400).json({ success: false, error: 'Marca inválida' });
        return;
      }
      pedidas = lineas.map((l) => ({ id: l.id, marca: req.body.todas as Marca }));
    } else if (Array.isArray(req.body?.lineas) && req.body.lineas.length > 0) {
      pedidas = [];
      const propias = new Set(lineas.map((l) => l.id));
      for (const p of req.body.lineas as { id: unknown; marca: unknown }[]) {
        const id = Number(p?.id);
        if (!propias.has(id) || !MARCAS.includes(p?.marca as Marca)) {
          res.status(400).json({ success: false, error: 'Cada línea necesita ser de esta requisición y una marca válida' });
          return;
        }
        pedidas.push({ id, marca: p.marca as Marca });
      }
    } else {
      res.status(400).json({ success: false, error: 'No vino ninguna marca' });
      return;
    }

    const actual = new Map(lineas.map((l, i) => [l.id, { marca: l.marca, n: i + 1 }]));
    const cambian = pedidas.filter((p) => actual.get(p.id)!.marca !== p.marca);
    if (cambian.length === 0) {
      res.json({ success: true, message: 'Nada que cambiar' });
      return;
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const p of cambian) {
        await client.query(
          `UPDATE requisicion_lineas SET marca = $1, marca_por = $2, marca_at = CURRENT_TIMESTAMP
            WHERE id = $3 AND requisicion_id = $4`,
          [p.marca, req.user!.id, p.id, r.id],
        );
      }
      await registrarAudit(
        req.user!.id,
        'marcar',
        'requisicion',
        r.id,
        {
          numero: r.numero,
          marcas: cambian.map((p) => ({ linea: actual.get(p.id)!.n, antes: actual.get(p.id)!.marca, despues: p.marca })),
        },
        client,
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    res.json({ success: true });
  }),
);

// ---------------------------------------------------------------------------
// Archivos: adjuntos del proyecto, cuadros comparativos y cotizaciones
// ---------------------------------------------------------------------------
const subida = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const permitidos = [
      'application/pdf',
      'image/jpeg',
      'image/png',
      'image/webp',
      // Un cuadro comparativo casi siempre es una hoja de Excel.
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
    ];
    if (permitidos.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Tipo de archivo no permitido. Solo PDF, JPG, PNG, WEBP y Excel.'));
  },
});

/** Sin esto, una foto de 12 MB del teléfono falla como «Error interno del servidor». */
function recibirArchivo(req: Request, res: Response, next: NextFunction): void {
  subida.single('archivo')(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      res.status(400).json({
        success: false,
        error: err.code === 'LIMIT_FILE_SIZE' ? 'El archivo pasa de 10 MB' : `No se pudo subir el archivo: ${err.message}`,
      });
      return;
    }
    if (err) {
      res.status(400).json({ success: false, error: (err as Error).message });
      return;
    }
    fixFiles(req);
    next();
  });
}

function limpiarNombre(nombre: string): string {
  return nombre
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_');
}

/** Las líneas que vienen en un formulario con archivo: un JSON con ids. */
function idsDeLineas(crudo: unknown): number[] | null {
  if (crudo === undefined || crudo === null || crudo === '') return [];
  try {
    const v = typeof crudo === 'string' ? JSON.parse(crudo) : crudo;
    if (!Array.isArray(v)) return null;
    const ids = v.map(Number);
    return ids.every(Number.isInteger) ? [...new Set(ids)] : null;
  } catch {
    return null;
  }
}

async function guardarEnR2(numero: string, file: Express.Multer.File): Promise<string> {
  const key = `requisiciones/${numero}/${Date.now()}-${limpiarNombre(file.originalname)}`;
  await uploadFile(key, file.buffer, file.mimetype);
  return key;
}

// POST /:id/adjuntos — tipo 'adjunto' (lo del proyecto, mientras está por
// aprobar) o 'cuadro_comparativo' (Compras, aprobada, amarrado a líneas).
router.post(
  '/:id/adjuntos',
  authenticateToken,
  recibirArchivo,
  [param('id').isInt()],
  asyncHandler(async (req: Request<{ id: string }>, res: Response) => {
    if (erroresDeValidacion(req, res)) return;
    if (!req.file) {
      res.status(400).json({ success: false, error: 'No se recibió ningún archivo' });
      return;
    }
    const r = await traer(req.params.id);
    if (!r || !(await puedeVer(req, r))) {
      res.status(404).json({ success: false, error: 'Requisición no encontrada' });
      return;
    }
    const tipo = req.body.tipo === 'cuadro_comparativo' ? 'cuadro_comparativo' : 'adjunto';
    const ids = idsDeLineas(req.body.lineas);
    if (ids === null) {
      res.status(400).json({ success: false, error: 'Las líneas no vinieron bien' });
      return;
    }
    if (tipo === 'adjunto' && !puedeEditar(req, r)) {
      res.status(403).json({ success: false, error: 'Los adjuntos se suben mientras está por aprobar' });
      return;
    }
    if (tipo === 'cuadro_comparativo') {
      if (!(await puedeAtender(req, r))) {
        res.status(403).json({ success: false, error: 'Los cuadros comparativos los sube Compras' });
        return;
      }
      if (ids.length === 0) {
        res.status(400).json({ success: false, error: 'Marca qué líneas compara el cuadro' });
        return;
      }
    }
    if (ids.length > 0 && !(await numerosDeLineas(pool, r.id, ids))) {
      res.status(400).json({ success: false, error: 'Alguna línea no es de esta requisición' });
      return;
    }

    const key = await guardarEnR2(r.numero, req.file);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const fila = await client.query<{ id: number }>(
        `INSERT INTO requisicion_adjuntos
           (requisicion_id, tipo, nombre_original, r2_key, tipo_mime, tamano, descripcion, subido_por)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [r.id, tipo, req.file.originalname, key, req.file.mimetype, req.file.size, texto(req.body.descripcion), req.user!.id],
      );
      for (const lid of ids) {
        await client.query('INSERT INTO requisicion_adjunto_lineas (adjunto_id, linea_id) VALUES ($1, $2)', [fila.rows[0].id, lid]);
      }
      await registrarAudit(
        req.user!.id,
        tipo === 'adjunto' ? 'adjuntar' : 'agregar_cuadro',
        'requisicion',
        r.id,
        { numero: r.numero, archivo: req.file.originalname },
        client,
      );
      await client.query('COMMIT');
      res.status(201).json({ success: true, data: { id: fila.rows[0].id } });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }),
);

router.delete(
  '/:id/adjuntos/:adjuntoId',
  authenticateToken,
  [param('id').isInt(), param('adjuntoId').isInt()],
  asyncHandler(async (req: Request<{ id: string; adjuntoId: string }>, res: Response) => {
    if (erroresDeValidacion(req, res)) return;
    const r = await traer(req.params.id);
    if (!r || !(await puedeVer(req, r))) {
      res.status(404).json({ success: false, error: 'Requisición no encontrada' });
      return;
    }
    const adj = await query<{ tipo: string; nombre_original: string }>(
      'SELECT tipo, nombre_original FROM requisicion_adjuntos WHERE id = $1 AND requisicion_id = $2 AND activo = true',
      [req.params.adjuntoId, r.id],
    );
    if (adj.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Adjunto no encontrado' });
      return;
    }
    const puede = adj.rows[0].tipo === 'adjunto' ? puedeEditar(req, r) : await puedeAtender(req, r);
    if (!puede) {
      res.status(403).json({ success: false, error: 'No puedes quitar este archivo' });
      return;
    }
    await query('UPDATE requisicion_adjuntos SET activo = false WHERE id = $1', [req.params.adjuntoId]);
    await registrarAudit(req.user!.id, 'quitar_adjunto', 'requisicion', r.id, {
      numero: r.numero,
      archivo: adj.rows[0].nombre_original,
    });
    res.json({ success: true });
  }),
);

// POST /:id/cotizaciones — Compras agrega una cotización: archivo, proveedor,
// monto (opcional) y las líneas que cubre. Queda también en Cotizaciones.
router.post(
  '/:id/cotizaciones',
  authenticateToken,
  recibirArchivo,
  [param('id').isInt()],
  asyncHandler(async (req: Request<{ id: string }>, res: Response) => {
    if (erroresDeValidacion(req, res)) return;
    if (!req.file) {
      res.status(400).json({ success: false, error: 'No se recibió ningún archivo' });
      return;
    }
    const r = await traer(req.params.id);
    if (!r || !(await puedeVer(req, r))) {
      res.status(404).json({ success: false, error: 'Requisición no encontrada' });
      return;
    }
    if (!(await puedeAtender(req, r))) {
      res.status(r.estado === 'aprobada' ? 403 : 400).json({
        success: false,
        error: r.estado === 'aprobada' ? 'Las cotizaciones las agrega Compras' : 'Se cotiza una requisición aprobada',
      });
      return;
    }
    const proveedor = texto(req.body.proveedor);
    if (!proveedor || proveedor.length > 255) {
      res.status(400).json({ success: false, error: 'El proveedor es obligatorio' });
      return;
    }
    const montoCrudo = texto(req.body.monto);
    const monto = montoCrudo === null ? null : Number(montoCrudo);
    if (monto !== null && (!Number.isFinite(monto) || monto < 0 || monto >= 1e12)) {
      res.status(400).json({ success: false, error: 'El monto no es válido' });
      return;
    }
    const ids = idsDeLineas(req.body.lineas);
    if (!ids || ids.length === 0) {
      res.status(400).json({ success: false, error: 'Marca qué líneas cubre la cotización' });
      return;
    }
    const numeros = await numerosDeLineas(pool, r.id, ids);
    if (!numeros) {
      res.status(400).json({ success: false, error: 'Alguna línea no es de esta requisición' });
      return;
    }

    const lineas = (await lineasDe(r.id)).filter((l) => ids.includes(l.id));
    const cubiertas = lineas.map((l) => numeros.get(l.id)!).sort((a, b) => a - b);
    // Lo que se lee en Cotizaciones al lado de la oferta. Si cubre varias, el
    // total es de todas y así lo dice, para que nadie lo tome por el precio de
    // un solo material (Ivan, 2026-10-05).
    const nota =
      cubiertas.length === 1
        ? 'Solo esta línea'
        : `Cubre las líneas ${enumerar(cubiertas)}${monto !== null ? '; el monto es por todas' : ''}`;

    const key = await guardarEnR2(r.numero, req.file);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const rc = await client.query<{ id: number }>(
        `INSERT INTO requisicion_cotizaciones
           (requisicion_id, proveedor, monto, nombre_original, r2_key, tipo_mime, tamano, subido_por)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [r.id, proveedor, monto, req.file.originalname, key, req.file.mimetype, req.file.size, req.user!.id],
      );
      const rcId = rc.rows[0].id;
      for (const l of lineas) {
        // La entrada de esa línea en Cotizaciones: la crea la primera
        // cotización que la cubre. «Pedido por» es quien escribió la
        // requisición, que es quien pidió el material.
        const unidad = l.unidad ? ` ${l.unidad}` : '';
        const titulo = `${l.descripcion} — ${Number(l.cantidad).toLocaleString('en-US', { maximumFractionDigits: 3 })}${unidad}`;
        const entrada = await client.query<{ id: number }>(
          `INSERT INTO cotizaciones (descripcion, descripcion_larga, proyecto_id, creado_por, requisicion_linea_id)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (requisicion_linea_id) WHERE requisicion_linea_id IS NOT NULL
           DO UPDATE SET activo = TRUE, updated_at = CURRENT_TIMESTAMP
           RETURNING id`,
          [titulo.slice(0, 255), `${r.numero} · ${r.descripcion}`, r.proyecto_id, r.creado_por, l.id],
        );
        const oferta = await client.query<{ id: number }>(
          `INSERT INTO cotizacion_ofertas (cotizacion_id, proveedor, monto, nota, creado_por, requisicion_cotizacion_id)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [entrada.rows[0].id, proveedor, monto, nota, req.user!.id, rcId],
        );
        await client.query(
          `INSERT INTO cotizacion_archivos (oferta_id, nombre_original, r2_key, tipo_mime, tamano, subido_por)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [oferta.rows[0].id, req.file.originalname, key, req.file.mimetype, req.file.size, req.user!.id],
        );
      }
      await registrarAudit(
        req.user!.id,
        'agregar_cotizacion',
        'requisicion',
        r.id,
        { numero: r.numero, proveedor, monto, lineas: cubiertas },
        client,
      );
      await client.query('COMMIT');
      res.status(201).json({ success: true, data: { id: rcId } });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }),
);

router.delete(
  '/:id/cotizaciones/:cotizacionId',
  authenticateToken,
  [param('id').isInt(), param('cotizacionId').isInt()],
  asyncHandler(async (req: Request<{ id: string; cotizacionId: string }>, res: Response) => {
    if (erroresDeValidacion(req, res)) return;
    const r = await traer(req.params.id);
    if (!r || !(await puedeVer(req, r))) {
      res.status(404).json({ success: false, error: 'Requisición no encontrada' });
      return;
    }
    if (!(await puedeAtender(req, r))) {
      res.status(403).json({ success: false, error: 'Las cotizaciones las quita Compras' });
      return;
    }
    const rc = await query<{ proveedor: string }>(
      'SELECT proveedor FROM requisicion_cotizaciones WHERE id = $1 AND requisicion_id = $2 AND activo = true',
      [req.params.cotizacionId, r.id],
    );
    if (rc.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Cotización no encontrada' });
      return;
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE requisicion_cotizaciones SET activo = false WHERE id = $1', [req.params.cotizacionId]);
      await client.query(
        'UPDATE cotizacion_ofertas SET activo = false WHERE requisicion_cotizacion_id = $1',
        [req.params.cotizacionId],
      );
      // La entrada de una línea que se queda sin ninguna cotización sale de la
      // lista de Cotizaciones; vuelve sola si llega otra.
      await client.query(
        `UPDATE cotizaciones c SET activo = false, updated_at = CURRENT_TIMESTAMP
          WHERE c.requisicion_linea_id IN (SELECT id FROM requisicion_lineas WHERE requisicion_id = $1)
            AND c.activo = true
            AND NOT EXISTS (SELECT 1 FROM cotizacion_ofertas o WHERE o.cotizacion_id = c.id AND o.activo = true)`,
        [r.id],
      );
      await registrarAudit(
        req.user!.id,
        'quitar_cotizacion',
        'requisicion',
        r.id,
        { numero: r.numero, proveedor: rc.rows[0].proveedor },
        client,
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    res.json({ success: true });
  }),
);

// Los enlaces para abrir los archivos. Son enlaces firmados de R2 que caducan
// solos: el archivo no pasa por este servidor.
router.get(
  '/:id/archivos/urls',
  authenticateToken,
  [param('id').isInt()],
  asyncHandler(async (req: Request<{ id: string }>, res: Response) => {
    if (erroresDeValidacion(req, res)) return;
    const r = await traer(req.params.id);
    if (!r || !(await puedeVer(req, r))) {
      res.status(404).json({ success: false, error: 'Requisición no encontrada' });
      return;
    }
    const [adj, cot] = await Promise.all([
      query<{ id: number; r2_key: string; tipo_mime: string }>(
        'SELECT id, r2_key, tipo_mime FROM requisicion_adjuntos WHERE requisicion_id = $1 AND activo = true',
        [r.id],
      ),
      query<{ id: number; r2_key: string; tipo_mime: string }>(
        'SELECT id, r2_key, tipo_mime FROM requisicion_cotizaciones WHERE requisicion_id = $1 AND activo = true',
        [r.id],
      ),
    ]);
    const firmar = (filas: { id: number; r2_key: string; tipo_mime: string }[]) =>
      Promise.all(filas.map(async (f) => ({ id: f.id, url: await getFileSignedUrl(f.r2_key), tipo_mime: f.tipo_mime })));
    // Arriba y no dentro de data: así lo lee AdjuntosPreview, el mismo recuadro
    // de archivos de las solicitudes y las órdenes.
    res.json({ success: true, adjuntos: await firmar(adj.rows), cotizaciones: await firmar(cot.rows) });
  }),
);

// ---------------------------------------------------------------------------
// GET /:id/pdf — el papel
// ---------------------------------------------------------------------------
router.get(
  '/:id/pdf',
  authenticateToken,
  [param('id').isInt()],
  asyncHandler(async (req: Request<{ id: string }>, res: Response) => {
    if (erroresDeValidacion(req, res)) return;
    const r = await traer(req.params.id);
    if (!r || !(await puedeVer(req, r))) {
      res.status(404).json({ success: false, error: 'Requisición no encontrada' });
      return;
    }
    const cab = await query<{
      proyecto_nombre: string;
      es_consorcio: boolean;
      contratista: string | null;
      logo_consorcio: string | null;
      escrita_por: string;
      aprobada_por: string | null;
    }>(
      `SELECT COALESCE(NULLIF(p.nombre_corto, ''), p.nombre) AS proyecto_nombre,
              ${ES_CONSORCIO_SQL} AS es_consorcio, p.contratista, p.logo_consorcio,
              uc.nombre AS escrita_por, ua.nombre AS aprobada_por
         FROM requisiciones r
         JOIN proyectos p ON p.id = r.proyecto_id
         JOIN users uc ON uc.id = r.creado_por
         LEFT JOIN users ua ON ua.id = r.aprobada_por
        WHERE r.id = $1`,
      [r.id],
    );
    const c = cab.rows[0];
    const lineas = await lineasDe(r.id);

    const { generarRequisicionPDF } = await import('../services/requisicionPdf.js');
    const pdf = await generarRequisicionPDF({
      numero: r.numero,
      creada_at: r.created_at,
      proyecto_nombre: c.proyecto_nombre,
      consorcio: consorcioDelProyecto(c),
      descripcion: r.descripcion,
      fecha_requerida: r.fecha_requerida,
      prioridad: r.prioridad,
      estado: r.estado,
      escrita_por: c.escrita_por,
      aprobada_por: c.aprobada_por,
      aprobada_at: r.aprobada_at,
      notas: r.notas,
      beneficiario: r.beneficiario,
      banco: r.banco,
      tipo_cuenta: r.tipo_cuenta,
      numero_cuenta: r.numero_cuenta,
      lineas: lineas.map((l, i) => ({
        numero: i + 1,
        cantidad: l.cantidad,
        unidad: l.unidad,
        descripcion: l.descripcion,
        renglon_desglose: l.renglon_desglose,
        marca: l.marca,
      })),
      generado_at: new Date(),
    });

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${r.numero}.pdf"`,
      'Content-Length': String(pdf.length),
    });
    res.send(pdf);
  }),
);

export default router;
