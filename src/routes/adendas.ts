import { Router, Request, Response } from 'express';
import type { PoolClient } from 'pg';
import { query, pool } from '../database/config.js';
import { authenticateToken, requireManager, checkProjectAccess } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { registrarAudit } from '../services/auditLog.js';
import type { Adenda as AdendaRow, AdendaType as AdendaTipo } from '../types/models.js';

// Las adendas de un proyecto. Todas las rutas cuelgan de /project/:projectId:
// así el acceso al proyecto lo revisa checkProjectAccess antes de entrar, y una
// adenda solo se toca si de verdad es de ese proyecto.
//
// Una adenda lleva UN monto, con ITBMS y en negativo si reduce el contrato
// (migración 184). Borrarla la esconde; no se pierde.

const router = Router();

type AdendaEstado = AdendaRow['estado'];

const TIPOS: readonly AdendaTipo[] = ['tiempo', 'costo', 'mixta'];
const ESTADOS: readonly AdendaEstado[] = ['en_proceso', 'aprobada', 'rechazada'];

/** Los campos que se pueden escribir, ya validados. */
interface Campos {
  tipo: AdendaTipo;
  estado: AdendaEstado;
  nueva_fecha_fin: string | null;
  dias_extension: number | null;
  monto: string | null;
  observaciones: string | null;
  fecha_aprobacion: string | null;
}

const COLUMNAS = `
  id, proyecto_id, numero_adenda, tipo, estado,
  TO_CHAR(nueva_fecha_fin, 'YYYY-MM-DD') AS nueva_fecha_fin,
  dias_extension, monto::text AS monto, observaciones,
  TO_CHAR(fecha_solicitud, 'YYYY-MM-DD') AS fecha_solicitud,
  TO_CHAR(fecha_aprobacion, 'YYYY-MM-DD') AS fecha_aprobacion`;

// El día de hoy en Panamá. CURRENT_DATE es el del servidor de la base, que va
// en UTC: después de las 7 de la noche ya sería mañana.
const HOY_PANAMA = `(now() AT TIME ZONE 'America/Panama')::date`;

class Invalido extends Error {}

function leerFecha(v: unknown, nombre: string): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    throw new Invalido(`${nombre}: la fecha no es válida`);
  }
  const d = new Date(`${v}T12:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) {
    throw new Invalido(`${nombre}: la fecha no es válida`);
  }
  return v;
}

function leerDias(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isInteger(n)) throw new Invalido('Los días de extensión tienen que ser un número entero');
  return n;
}

/** El monto con dos decimales, como texto para que no pase por un float. */
function leerMonto(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  const s = typeof v === 'number' ? v.toFixed(2) : String(v).trim();
  if (!/^-?\d{1,13}(\.\d{1,2})?$/.test(s)) throw new Invalido('El monto de la adenda no es válido');
  if (Number(s) === 0) throw new Invalido('El monto de la adenda no puede ser cero');
  return s;
}

function leerTexto(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

/**
 * Pasa los campos del cuerpo que vinieron por encima de `base` (vacío al crear).
 * Lo que no vino se queda como estaba: no venir no es lo mismo que venir vacío.
 */
function mezclar(base: Campos, cuerpo: Record<string, unknown>): Campos {
  const c = { ...base };
  const tiene = (k: string) => Object.prototype.hasOwnProperty.call(cuerpo, k);
  if (tiene('tipo')) {
    if (!TIPOS.includes(cuerpo.tipo as AdendaTipo)) throw new Invalido('Tipo debe ser tiempo, costo o mixta');
    c.tipo = cuerpo.tipo as AdendaTipo;
  }
  if (tiene('estado')) {
    if (!ESTADOS.includes(cuerpo.estado as AdendaEstado)) throw new Invalido('Estado inválido');
    c.estado = cuerpo.estado as AdendaEstado;
  }
  if (tiene('nueva_fecha_fin')) c.nueva_fecha_fin = leerFecha(cuerpo.nueva_fecha_fin, 'Nueva fecha de terminación');
  if (tiene('dias_extension')) c.dias_extension = leerDias(cuerpo.dias_extension);
  if (tiene('monto')) c.monto = leerMonto(cuerpo.monto);
  if (tiene('observaciones')) c.observaciones = leerTexto(cuerpo.observaciones);
  if (tiene('fecha_aprobacion')) c.fecha_aprobacion = leerFecha(cuerpo.fecha_aprobacion, 'Fecha de aprobación');

  // Cada tipo lleva lo suyo. Cambiar de «tiempo y costo» a «tiempo» suelta el
  // monto; no se queda escondido contando para el contrato.
  if (c.tipo === 'tiempo') c.monto = null;
  if (c.tipo === 'costo') {
    c.nueva_fecha_fin = null;
    c.dias_extension = null;
  }
  if ((c.tipo === 'tiempo' || c.tipo === 'mixta') && !c.nueva_fecha_fin) {
    throw new Invalido('Nueva fecha de terminación es requerida para adendas de tiempo');
  }
  if ((c.tipo === 'costo' || c.tipo === 'mixta') && !c.monto) {
    throw new Invalido('El monto es requerido para adendas de costo');
  }
  // Solo una aprobada tiene fecha de aprobación.
  if (c.estado !== 'aprobada') c.fecha_aprobacion = null;
  return c;
}

const VACIO: Campos = {
  tipo: 'tiempo',
  estado: 'en_proceso',
  nueva_fecha_fin: null,
  dias_extension: null,
  monto: null,
  observaciones: null,
  fecha_aprobacion: null,
};

async function enTransaccion<T>(fn: (db: PoolClient) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const r = await fn(db);
    await db.query('COMMIT');
    return r;
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  } finally {
    db.release();
  }
}

function responderInvalido(res: Response, e: unknown): boolean {
  if (e instanceof Invalido) {
    res.status(400).json({ success: false, message: e.message });
    return true;
  }
  return false;
}

// Las adendas vigentes de un proyecto (las borradas no salen).
router.get(
  '/project/:projectId',
  authenticateToken,
  checkProjectAccess('projectId'),
  asyncHandler(async (req: Request<{ projectId: string }>, res: Response): Promise<void> => {
    const result = await query<AdendaRow>(
      `SELECT ${COLUMNAS} FROM adendas
        WHERE proyecto_id = $1 AND activo = TRUE
        ORDER BY numero_adenda`,
      [req.params.projectId],
    );
    res.json({ success: true, data: result.rows });
  }),
);

// Crear una adenda. El número es el siguiente del proyecto contando también las
// borradas: un número no se repite nunca.
router.post(
  '/project/:projectId',
  authenticateToken,
  requireManager,
  checkProjectAccess('projectId'),
  asyncHandler(async (req: Request<{ projectId: string }>, res: Response): Promise<void> => {
    const proyectoId = Number(req.params.projectId);
    let campos: Campos;
    try {
      if (!Object.prototype.hasOwnProperty.call(req.body ?? {}, 'tipo')) throw new Invalido('Falta el tipo de adenda');
      campos = mezclar(VACIO, (req.body ?? {}) as Record<string, unknown>);
    } catch (e) {
      if (responderInvalido(res, e)) return;
      throw e;
    }

    const creada = await enTransaccion(async (db) => {
      // El proyecto bloqueado mientras se saca el número: dos adendas creadas a
      // la vez no pueden llevarse el mismo.
      const p = await db.query('SELECT id FROM proyectos WHERE id = $1 FOR UPDATE', [proyectoId]);
      if (p.rows.length === 0) return null;
      const r = await db.query<AdendaRow>(
        `INSERT INTO adendas (
           proyecto_id, numero_adenda, tipo, estado, nueva_fecha_fin, dias_extension,
           monto, observaciones, fecha_solicitud, fecha_aprobacion)
         VALUES (
           $1, (SELECT COALESCE(MAX(numero_adenda), 0) + 1 FROM adendas WHERE proyecto_id = $1),
           $2, $3, $4, $5, $6, $7, ${HOY_PANAMA},
           CASE WHEN $9 THEN COALESCE($8::date, ${HOY_PANAMA}) END)
         RETURNING ${COLUMNAS}`,
        [
          proyectoId,
          campos.tipo,
          campos.estado,
          campos.nueva_fecha_fin,
          campos.dias_extension,
          campos.monto,
          campos.observaciones,
          campos.fecha_aprobacion,
          campos.estado === 'aprobada',
        ],
      );
      const a = r.rows[0];
      await registrarAudit(req.user!.id, 'crear', 'adenda', a.id, { proyecto_id: proyectoId, adenda: a }, db);
      return a;
    });

    if (!creada) {
      res.status(404).json({ success: false, message: 'Proyecto no encontrado' });
      return;
    }
    res.status(201).json({ success: true, data: creada, message: 'Adenda creada' });
  }),
);

// Editar una adenda. Solo cambia lo que vino en el cuerpo.
router.put(
  '/project/:projectId/:id',
  authenticateToken,
  requireManager,
  checkProjectAccess('projectId'),
  asyncHandler(async (req: Request<{ projectId: string; id: string }>, res: Response): Promise<void> => {
    const proyectoId = Number(req.params.projectId);
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ success: false, message: 'ID de adenda inválido' });
      return;
    }

    const resultado = await enTransaccion(async (db) => {
      const actual = await db.query<AdendaRow>(
        `SELECT ${COLUMNAS} FROM adendas
          WHERE id = $1 AND proyecto_id = $2 AND activo = TRUE FOR UPDATE`,
        [id, proyectoId],
      );
      if (actual.rows.length === 0) return { tipo: 'no_existe' as const };
      const antes = actual.rows[0];
      const base: Campos = {
        tipo: antes.tipo,
        estado: antes.estado,
        nueva_fecha_fin: antes.nueva_fecha_fin,
        dias_extension: antes.dias_extension,
        monto: antes.monto,
        observaciones: antes.observaciones,
        fecha_aprobacion: antes.fecha_aprobacion,
      };
      let nuevos: Campos;
      try {
        nuevos = mezclar(base, (req.body ?? {}) as Record<string, unknown>);
      } catch (e) {
        if (e instanceof Invalido) return { tipo: 'invalido' as const, error: e };
        throw e;
      }

      // Recién aprobada y sin fecha dicha: hoy. Solo al pasar a aprobada: las
      // que ya lo estaban sin fecha (las hay de antes) no se fechan al editarlas.
      const aprobadaHoy = antes.estado !== 'aprobada' && nuevos.estado === 'aprobada' && !nuevos.fecha_aprobacion;

      // Solo las columnas que cambiaron.
      const sets: string[] = [];
      const params: unknown[] = [];
      for (const k of Object.keys(nuevos) as (keyof Campos)[]) {
        if (k === 'fecha_aprobacion' && aprobadaHoy) continue;
        const v = nuevos[k];
        const era = base[k];
        const igual = k === 'monto' ? (v === null ? era === null : era !== null && Number(v) === Number(era)) : v === era;
        if (igual) continue;
        params.push(v);
        sets.push(`${k} = $${params.length}`);
      }
      if (aprobadaHoy) sets.push(`fecha_aprobacion = ${HOY_PANAMA}`);
      if (sets.length === 0) return { tipo: 'ok' as const, adenda: antes };

      params.push(id);
      const r = await db.query<AdendaRow>(
        `UPDATE adendas SET ${sets.join(', ')}, updated_at = now()
          WHERE id = $${params.length}
          RETURNING ${COLUMNAS}`,
        params,
      );
      const despues = r.rows[0];
      await registrarAudit(
        req.user!.id,
        'editar',
        'adenda',
        id,
        { proyecto_id: proyectoId, antes, despues },
        db,
      );
      return { tipo: 'ok' as const, adenda: despues };
    });

    if (resultado.tipo === 'no_existe') {
      res.status(404).json({ success: false, message: 'Adenda no encontrada' });
      return;
    }
    if (resultado.tipo === 'invalido') {
      responderInvalido(res, resultado.error);
      return;
    }
    res.json({ success: true, data: resultado.adenda, message: 'Adenda actualizada' });
  }),
);

// Borrar una adenda: se esconde y deja de contar para el contrato.
router.delete(
  '/project/:projectId/:id',
  authenticateToken,
  requireManager,
  checkProjectAccess('projectId'),
  asyncHandler(async (req: Request<{ projectId: string; id: string }>, res: Response): Promise<void> => {
    const proyectoId = Number(req.params.projectId);
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ success: false, message: 'ID de adenda inválido' });
      return;
    }
    const borrada = await enTransaccion(async (db) => {
      const r = await db.query<AdendaRow>(
        `UPDATE adendas SET activo = FALSE, updated_at = now()
          WHERE id = $1 AND proyecto_id = $2 AND activo = TRUE
          RETURNING ${COLUMNAS}`,
        [id, proyectoId],
      );
      if (r.rows.length === 0) return null;
      await registrarAudit(req.user!.id, 'eliminar', 'adenda', id, { proyecto_id: proyectoId, adenda: r.rows[0] }, db);
      return r.rows[0];
    });
    if (!borrada) {
      res.status(404).json({ success: false, message: 'Adenda no encontrada' });
      return;
    }
    res.json({ success: true, message: 'Adenda eliminada' });
  }),
);

export default router;
