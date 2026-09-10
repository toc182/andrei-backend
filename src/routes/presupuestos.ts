// src/routes/presupuestos.ts
// Hoja de Presupuesto. Un proyecto tiene VARIOS, independientes entre si, y uno
// lleva la estrella (es_principal): ese es contra el que compara el control de
// costos.
//
// Dos maneras de armarlo, y cada una tiene su guardado:
//
//   'desglose' — a partir del desglose OFICIAL del proyecto. Al crearlo se
//     COPIAN sus filas con su precio; despues el presupuesto no vuelve a mirar
//     el desglose, asi que si el desglose cambia, este no se mueve. La
//     estructura queda BLOQUEADA y lo unico que se edita es el costo unitario
//     (PUT .../:presupuestoId).
//
//   'cero' — nace vacio y los renglones se escriben en la hoja. Es la unica
//     manera que sirve en un proyecto que todavia no tiene desglose. Aqui la
//     estructura SI se edita, y se guarda entera de una vez
//     (PUT .../:presupuestoId/hoja): borra y reinserta en una transaccion,
//     igual que un desglose.
//
// Todo cuelga de /proyecto/:proyectoId para que checkProjectAccess proteja
// tambien las rutas de un presupuesto concreto (mismo patron que desgloses).

import { Router, type Request, type Response } from 'express';
import { query, pool } from '../database/config.js';
import { authenticateToken, checkPermission, checkProjectAccess } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { registrarAudit } from '../services/auditLog.js';
import type {
  CrearPresupuestoBody, DesgloseDisponibleWire, GuardarCostosBody, GuardarHojaBody,
  PresupuestoListaWire, PresupuestoRenglonInput, PresupuestoRenglonWire,
} from '../types/presupuesto.js';

const router = Router();
router.use(authenticateToken);

// Misma forma canonica que desgloses y cronogramas, para que cargar y guardar
// comparen byte a byte sin corrimientos de zona horaria ni de formato.
const updatedAtSql = (col = 'updated_at') => `to_char(${col}, 'YYYY-MM-DD"T"HH24:MI:SS.MS')`;

class ConflictError extends Error {}
class NotFoundError extends Error {}
/** Un 400 que nace dentro de la transaccion, cuando la fila ya se leyo. */
class BadRequestError extends Error {}

const MAX_NOMBRE = 200;
const MAX_RENGLONES = 5000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const num = (v: string | null): number | null => (v != null ? parseFloat(v) : null);

/** Ids validos en la URL, o null. */
function parseId(raw: string): number | null {
  const n = parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// ---------------------------------------------------------------------------
// Lectura
// ---------------------------------------------------------------------------

/** El desglose oficial del proyecto: es de donde se copian las filas. null si
 *  el proyecto no tiene, y entonces esa manera de armar sale apagada. */
async function desgloseOficial(proyectoId: number): Promise<DesgloseDisponibleWire | null> {
  const d = await query<{ id: number; nombre: string; filas: string }>(
    `SELECT d.id, d.nombre, COUNT(i.id)::text AS filas
       FROM desgloses d
       LEFT JOIN desglose_items i ON i.desglose_id = d.id
      WHERE d.proyecto_id = $1 AND d.tipo = 'oficial' AND d.activo = TRUE
      GROUP BY d.id, d.nombre
      ORDER BY d.id LIMIT 1`,
    [proyectoId],
  );
  if (!d.rows.length) return null;
  return { id: d.rows[0].id, nombre: d.rows[0].nombre, filas: parseInt(d.rows[0].filas, 10) };
}

interface ListaRow {
  id: number;
  nombre: string;
  origen: 'desglose' | 'cero';
  es_principal: boolean;
  creado_at: string;
  costo: string | null;
  precio: string | null;
  renglones: string;
}

/** La lista del proyecto. Los totales se suman en SQL y nunca se guardan.
 *
 *  Un grupo que tiene hijos es contenedor: su total sube desde abajo, asi que
 *  no puede sumar tambien lo suyo o se contaria dos veces. Un grupo sin hijos
 *  es una "seccion de una linea" y si lleva sus propios montos — la misma regla
 *  del desglose, de donde salen estas filas. */
async function listaPresupuestos(proyectoId: number): Promise<PresupuestoListaWire[]> {
  const r = await query<ListaRow>(
    `SELECT p.id, p.nombre, p.origen, p.es_principal,
            to_char(p.created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS creado_at,
            SUM(rr.cantidad * rr.costo_unitario)  AS costo,
            SUM(rr.cantidad * rr.precio_unitario) AS precio,
            COUNT(rr.id)::text AS renglones
       FROM presupuestos p
       LEFT JOIN presupuesto_renglones rr
              ON rr.presupuesto_id = p.id
             AND NOT EXISTS (SELECT 1 FROM presupuesto_renglones h WHERE h.parent_id = rr.id)
      WHERE p.proyecto_id = $1 AND p.activo = TRUE
      GROUP BY p.id
      ORDER BY p.created_at DESC, p.id DESC`,
    [proyectoId],
  );
  return r.rows.map((x) => ({
    id: x.id,
    nombre: x.nombre,
    origen: x.origen,
    esPrincipal: x.es_principal,
    creadoAt: x.creado_at,
    costo: num(x.costo) ?? 0,
    precio: num(x.precio) ?? 0,
    renglones: parseInt(x.renglones, 10),
  }));
}

/** Un proyecto con presupuestos NUNCA se queda sin oficial: si ninguno lleva la
 *  estrella, se le pone al mas reciente.
 *
 *  Cubre los dos huecos: el primero que se crea nace oficial (con uno solo no
 *  hay nada que escoger), y al borrar el oficial la estrella pasa a otro en vez
 *  de dejar al control de costos sin contra que comparar. Mientras haya un
 *  oficial vivo no toca nada: la estrella se queda donde el usuario la puso. */
async function asegurarEstrella(
  ejecutar: (text: string, params: unknown[]) => Promise<unknown>,
  proyectoId: number,
): Promise<void> {
  await ejecutar(
    `UPDATE presupuestos SET es_principal = TRUE
      WHERE id = (
        SELECT c.id FROM presupuestos c
         WHERE c.proyecto_id = $1 AND c.activo = TRUE
         ORDER BY c.created_at DESC, c.id DESC LIMIT 1)
        AND NOT EXISTS (
          SELECT 1 FROM presupuestos o
           WHERE o.proyecto_id = $1 AND o.activo = TRUE AND o.es_principal)`,
    [proyectoId],
  );
}

interface MetaRow {
  id: number;
  proyecto_id: number;
  nombre: string;
  origen: 'desglose' | 'cero';
  es_principal: boolean;
  desglose_id: number | null;
  creado_at: string;
  updated_at: string;
}

const META_COLS = `id, proyecto_id, nombre, origen, es_principal, desglose_id,
  to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS creado_at,
  ${updatedAtSql()} AS updated_at`;

/** Un presupuesto concreto, comprobando que es del proyecto de la URL:
 *  checkProjectAccess valida el proyecto, no el presupuesto. */
async function loadMeta(proyectoId: number, presupuestoId: number): Promise<MetaRow> {
  const m = await query<MetaRow>(
    `SELECT ${META_COLS} FROM presupuestos
      WHERE id = $1 AND proyecto_id = $2 AND activo = TRUE`,
    [presupuestoId, proyectoId],
  );
  if (!m.rows.length) throw new NotFoundError('Presupuesto no encontrado');
  return m.rows[0];
}

/** Una fila del desglose oficial, tal como se lee para copiarla. */
interface FilaDesglose {
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

interface RenglonRow {
  id: number;
  row_uid: string;
  parent_id: number | null;
  tipo: 'grupo' | 'item';
  codigo: string;
  descripcion: string;
  unidad: string | null;
  cantidad: string | null;
  precio_unitario: string | null;
  costo_unitario: string | null;
  orden: number;
}

const rowToWire = (r: RenglonRow): PresupuestoRenglonWire => ({
  id: r.id,
  rowUid: r.row_uid,
  parentId: r.parent_id,
  tipo: r.tipo,
  codigo: r.codigo,
  descripcion: r.descripcion,
  unidad: r.unidad,
  cantidad: num(r.cantidad),
  precioUnitario: num(r.precio_unitario),
  costoUnitario: num(r.costo_unitario),
  orden: r.orden,
});

async function loadDoc(m: MetaRow) {
  const r = await query<RenglonRow>(
    `SELECT id, row_uid, parent_id, tipo, codigo, descripcion, unidad,
            cantidad, precio_unitario, costo_unitario, orden
       FROM presupuesto_renglones WHERE presupuesto_id = $1 ORDER BY orden`,
    [m.id],
  );
  return {
    presupuesto: {
      id: m.id,
      proyectoId: m.proyecto_id,
      nombre: m.nombre,
      origen: m.origen,
      esPrincipal: m.es_principal,
      desgloseId: m.desglose_id,
      creadoAt: m.creado_at,
      updatedAt: m.updated_at,
    },
    renglones: r.rows.map(rowToWire),
  };
}

// ---------------------------------------------------------------------------
// Rutas
// ---------------------------------------------------------------------------

// GET /presupuestos/proyecto/:proyectoId — la lista + si hay desglose del que partir
router.get(
  '/proyecto/:proyectoId',
  checkPermission('costos_ver'),
  checkProjectAccess('proyectoId'),
  asyncHandler(async (req: Request<{ proyectoId: string }>, res: Response) => {
    const proyectoId = parseId(req.params.proyectoId);
    if (proyectoId == null) {
      res.status(400).json({ success: false, message: 'proyectoId invalido' });
      return;
    }
    const [presupuestos, desglose] = await Promise.all([
      listaPresupuestos(proyectoId),
      desgloseOficial(proyectoId),
    ]);
    res.json({ success: true, data: { presupuestos, desglose } });
  }),
);

// POST /presupuestos/proyecto/:proyectoId — crear a partir del desglose oficial
router.post(
  '/proyecto/:proyectoId',
  checkProjectAccess('proyectoId'),
  asyncHandler(async (req: Request<{ proyectoId: string }>, res: Response) => {
    const user = req.user!;
    const proyectoId = parseId(req.params.proyectoId);
    if (proyectoId == null) {
      res.status(400).json({ success: false, message: 'proyectoId invalido' });
      return;
    }
    const body = req.body as CrearPresupuestoBody;
    const nombre = String(body.nombre ?? '').trim().slice(0, MAX_NOMBRE);
    if (!nombre) {
      res.status(400).json({ success: false, message: 'El presupuesto necesita un nombre' });
      return;
    }
    const origen = body.origen ?? 'desglose';
    if (origen !== 'desglose' && origen !== 'cero') {
      res.status(400).json({ success: false, message: 'origen invalido' });
      return;
    }

    // Solo la manera 'desglose' necesita que el proyecto tenga uno. 'cero' nace
    // vacio, y por eso es la unica que sirve en un proyecto donde todavia no
    // hay nada cargado.
    const desglose = origen === 'desglose' ? await desgloseOficial(proyectoId) : null;
    if (origen === 'desglose' && !desglose) {
      res.status(400).json({
        success: false,
        message: 'Este proyecto todavia no tiene desglose, asi que no se puede armar de esta manera',
      });
      return;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const ins = await client.query<{ id: number }>(
        `INSERT INTO presupuestos (proyecto_id, nombre, origen, desglose_id, creado_por)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [proyectoId, nombre, origen, desglose?.id ?? null, user.id],
      );
      const presupuestoId = ins.rows[0].id;

      // Se copian las filas del desglose CON su precio. A partir de aqui el
      // presupuesto vive solo: el desglose puede cambiar y este no se entera.
      // Los padres vienen antes que sus hijos (ORDER BY orden respeta el
      // outline), asi que un solo recorrido resuelve parent_id -> id nuevo.
      // Sin desglose (origen 'cero') no hay nada que copiar: la hoja nace vacia.
      const filas: FilaDesglose[] = desglose == null ? [] : (
        await client.query<FilaDesglose>(
          `SELECT id, row_uid, parent_id, tipo, item, descripcion, unidad,
                  cantidad, precio_unitario, orden
             FROM desglose_items WHERE desglose_id = $1 ORDER BY orden`,
          [desglose.id],
        )
      ).rows;

      const idMap = new Map<number, number>();
      for (const [i, f] of filas.entries()) {
        const nuevo = await client.query<{ id: number }>(
          `INSERT INTO presupuesto_renglones
             (presupuesto_id, parent_id, seccion, tipo, codigo, descripcion, unidad,
              cantidad, precio_unitario, costo_unitario, desglose_row_uid, orden)
           VALUES ($1, $2, 'items', $3, $4, $5, $6, $7, $8, NULL, $9, $10)
           RETURNING id`,
          [
            presupuestoId,
            f.parent_id != null ? (idMap.get(f.parent_id) ?? null) : null,
            f.tipo,
            f.item,
            f.descripcion,
            f.unidad,
            f.cantidad,
            f.precio_unitario,
            f.row_uid,
            i,
          ],
        );
        idMap.set(f.id, nuevo.rows[0].id);
      }
      // El primero de un proyecto nace oficial: con uno solo no hay nada que
      // escoger y verlo sin marcar confunde.
      await asegurarEstrella((t, p) => client.query(t, p as unknown[]), proyectoId);
      await client.query('COMMIT');

      try {
        await registrarAudit(user.id, 'crear', 'presupuesto', presupuestoId, {
          proyecto_id: proyectoId, origen, desglose_id: desglose?.id ?? null,
          renglones: filas.length,
        });
      } catch (auditErr) {
        console.error('Error registrando audit de presupuesto:', auditErr);
      }

      const meta = await loadMeta(proyectoId, presupuestoId);
      res.status(201).json({ success: true, data: await loadDoc(meta) });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }),
);

// GET /presupuestos/proyecto/:proyectoId/:presupuestoId — la hoja
router.get(
  '/proyecto/:proyectoId/:presupuestoId',
  checkPermission('costos_ver'),
  checkProjectAccess('proyectoId'),
  asyncHandler(async (req: Request<{ proyectoId: string; presupuestoId: string }>, res: Response) => {
    const proyectoId = parseId(req.params.proyectoId);
    const presupuestoId = parseId(req.params.presupuestoId);
    if (proyectoId == null || presupuestoId == null) {
      res.status(400).json({ success: false, message: 'Identificador invalido' });
      return;
    }
    try {
      res.json({ success: true, data: await loadDoc(await loadMeta(proyectoId, presupuestoId)) });
    } catch (err) {
      if (err instanceof NotFoundError) {
        res.status(404).json({ success: false, message: err.message });
        return;
      }
      throw err;
    }
  }),
);

// PUT /presupuestos/proyecto/:proyectoId/:presupuestoId — guardar los costos
router.put(
  '/proyecto/:proyectoId/:presupuestoId',
  checkProjectAccess('proyectoId'),
  asyncHandler(async (req: Request<{ proyectoId: string; presupuestoId: string }>, res: Response) => {
    const user = req.user!;
    const proyectoId = parseId(req.params.proyectoId);
    const presupuestoId = parseId(req.params.presupuestoId);
    if (proyectoId == null || presupuestoId == null) {
      res.status(400).json({ success: false, message: 'Identificador invalido' });
      return;
    }
    const body = req.body as GuardarCostosBody;
    const costos = body.costos ?? [];
    if (!Array.isArray(costos)) {
      res.status(400).json({ success: false, message: 'costos debe ser un arreglo' });
      return;
    }
    for (const c of costos) {
      if (!Number.isInteger(c?.id)) {
        res.status(400).json({ success: false, message: 'id de renglon invalido' });
        return;
      }
      if (c.costoUnitario != null && (typeof c.costoUnitario !== 'number' || !Number.isFinite(c.costoUnitario))) {
        res.status(400).json({ success: false, message: 'costo unitario invalido' });
        return;
      }
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const cur = await client.query<{ id: number; updated_at: string }>(
        `SELECT id, ${updatedAtSql()} AS updated_at FROM presupuestos
          WHERE id = $1 AND proyecto_id = $2 AND activo = TRUE FOR UPDATE`,
        [presupuestoId, proyectoId],
      );
      if (!cur.rows.length) throw new NotFoundError('Presupuesto no encontrado');
      if (cur.rows[0].updated_at !== body.baseUpdatedAt) {
        throw new ConflictError('Otro usuario guardo cambios; recarga para combinar');
      }

      // El WHERE lleva presupuesto_id para que un id de otro presupuesto no
      // pueda colarse en el payload y escribir donde no debe.
      for (const c of costos) {
        await client.query(
          `UPDATE presupuesto_renglones SET costo_unitario = $3
            WHERE id = $1 AND presupuesto_id = $2`,
          [c.id, presupuestoId, c.costoUnitario],
        );
      }
      if (body.nombre != null) {
        const nombre = String(body.nombre).trim().slice(0, MAX_NOMBRE);
        if (nombre) {
          await client.query(`UPDATE presupuestos SET nombre = $2 WHERE id = $1`, [presupuestoId, nombre]);
        }
      }
      await client.query(
        `UPDATE presupuestos SET updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [presupuestoId],
      );
      await client.query('COMMIT');

      try {
        await registrarAudit(user.id, 'editar', 'presupuesto', presupuestoId, {
          proyecto_id: proyectoId, costos: costos.length,
        });
      } catch (auditErr) {
        console.error('Error registrando audit de presupuesto:', auditErr);
      }

      res.json({ success: true, data: await loadDoc(await loadMeta(proyectoId, presupuestoId)) });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (err instanceof NotFoundError) {
        res.status(404).json({ success: false, message: err.message });
        return;
      }
      if (err instanceof ConflictError) {
        res.status(409).json({ success: false, message: err.message });
        return;
      }
      throw err;
    } finally {
      client.release();
    }
  }),
);

// ---------------------------------------------------------------------------
// Guardado de la hoja armada desde cero
// ---------------------------------------------------------------------------

/** Cordura del payload: tempIds unicos, y padres que refieren a una fila
 *  ANTERIOR. Esa invariante posicional es lo que permite que un solo recorrido
 *  resuelva parentTempId -> id nuevo. Mismo contrato que el desglose. */
function validateRenglones(renglones: PresupuestoRenglonInput[]): string | null {
  if (!Array.isArray(renglones)) return 'renglones debe ser un arreglo';
  if (renglones.length > MAX_RENGLONES) return `Maximo ${MAX_RENGLONES} filas`;
  const vistos = new Set<number>();
  for (const r of renglones) {
    if (typeof r.tempId !== 'number' || vistos.has(r.tempId)) return 'tempId duplicado o invalido';
    if (r.rowUid != null && (typeof r.rowUid !== 'string' || !UUID_RE.test(r.rowUid))) {
      return 'rowUid invalido';
    }
    if (r.parentTempId != null && !vistos.has(r.parentTempId)) {
      return 'parentTempId debe referir a una fila anterior';
    }
    if (r.tipo !== 'grupo' && r.tipo !== 'item') return 'tipo invalido';
    if (r.cantidad != null && (typeof r.cantidad !== 'number' || !Number.isFinite(r.cantidad))) {
      return 'cantidad invalida';
    }
    if (r.costoUnitario != null
        && (typeof r.costoUnitario !== 'number' || !Number.isFinite(r.costoUnitario))) {
      return 'costo unitario invalido';
    }
    vistos.add(r.tempId);
  }
  return null;
}

/** Reemplaza TODOS los renglones del presupuesto.
 *
 *  `orden` sale de la posicion en el arreglo —la invariante que se valida es
 *  posicional—, no del campo que mande el cliente.
 *
 *  precio_unitario se queda en NULL a proposito: una hoja armada desde cero no
 *  tiene de donde sacar un precio, solo dice lo que la obra CUESTA. */
async function replaceRenglones(
  client: { query: typeof pool.query },
  presupuestoId: number,
  renglones: PresupuestoRenglonInput[],
): Promise<void> {
  await client.query(
    `DELETE FROM presupuesto_renglones WHERE presupuesto_id = $1`,
    [presupuestoId],
  );
  // Un grupo que es padre de alguien es CONTENEDOR: su total sube desde abajo,
  // asi que sus propios montos se anulan o se contarian dos veces. Un grupo sin
  // hijos es una "seccion de una linea" y conserva los suyos — la misma regla
  // del desglose, y la que ya aplican listaPresupuestos() y la hoja.
  const conHijos = new Set<number>();
  for (const r of renglones) if (r.parentTempId != null) conHijos.add(r.parentTempId);

  const idMap = new Map<number, number>();
  for (const [i, r] of renglones.entries()) {
    const contenedor = r.tipo === 'grupo' && conHijos.has(r.tempId);
    // row_uid: se conserva el que manda el cliente, para que la identidad de la
    // fila sobreviva a este borra-y-reinserta; si es nueva, la genera la base.
    const ins = await client.query<{ id: number }>(
      `INSERT INTO presupuesto_renglones
         (presupuesto_id, parent_id, seccion, tipo, codigo, descripcion, unidad,
          cantidad, precio_unitario, costo_unitario, orden, row_uid)
       VALUES ($1, $2, 'items', $3, $4, $5, $6, $7, NULL, $8, $9,
               COALESCE($10::uuid, gen_random_uuid()))
       RETURNING id`,
      [
        presupuestoId,
        r.parentTempId != null ? idMap.get(r.parentTempId)! : null,
        r.tipo,
        String(r.codigo ?? '').slice(0, 60),
        String(r.descripcion ?? ''),
        contenedor || r.unidad == null ? null : String(r.unidad).slice(0, 30),
        contenedor ? null : r.cantidad,
        contenedor ? null : r.costoUnitario,
        i,
        r.rowUid ?? null,
      ],
    );
    idMap.set(r.tempId, ins.rows[0].id);
  }
}

// PUT /presupuestos/proyecto/:proyectoId/:presupuestoId/hoja — guardar la hoja entera
router.put(
  '/proyecto/:proyectoId/:presupuestoId/hoja',
  checkProjectAccess('proyectoId'),
  asyncHandler(async (req: Request<{ proyectoId: string; presupuestoId: string }>, res: Response) => {
    const user = req.user!;
    const proyectoId = parseId(req.params.proyectoId);
    const presupuestoId = parseId(req.params.presupuestoId);
    if (proyectoId == null || presupuestoId == null) {
      res.status(400).json({ success: false, message: 'Identificador invalido' });
      return;
    }
    const body = req.body as GuardarHojaBody;
    const invalido = validateRenglones(body.renglones ?? []);
    if (invalido) {
      res.status(400).json({ success: false, message: invalido });
      return;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const cur = await client.query<{ origen: 'desglose' | 'cero'; updated_at: string }>(
        `SELECT origen, ${updatedAtSql()} AS updated_at FROM presupuestos
          WHERE id = $1 AND proyecto_id = $2 AND activo = TRUE FOR UPDATE`,
        [presupuestoId, proyectoId],
      );
      if (!cur.rows.length) throw new NotFoundError('Presupuesto no encontrado');
      // La estructura de uno copiado del desglose no se toca aqui: alli las
      // filas, las cantidades y los precios son del desglose, y lo unico que se
      // escribe es el costo. Esa es la otra ruta.
      if (cur.rows[0].origen !== 'cero') {
        throw new BadRequestError(
          'Este presupuesto salio de un desglose: sus renglones no se editan, solo sus costos',
        );
      }
      if (cur.rows[0].updated_at !== body.baseUpdatedAt) {
        throw new ConflictError('Otro usuario guardo cambios; recarga para combinar');
      }

      await replaceRenglones(client, presupuestoId, body.renglones);
      if (body.nombre != null) {
        const nombre = String(body.nombre).trim().slice(0, MAX_NOMBRE);
        if (nombre) {
          await client.query(
            `UPDATE presupuestos SET nombre = $2 WHERE id = $1`,
            [presupuestoId, nombre],
          );
        }
      }
      await client.query(
        `UPDATE presupuestos SET updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [presupuestoId],
      );
      await client.query('COMMIT');

      try {
        await registrarAudit(user.id, 'editar', 'presupuesto', presupuestoId, {
          proyecto_id: proyectoId, renglones: body.renglones.length,
        });
      } catch (auditErr) {
        console.error('Error registrando audit de presupuesto:', auditErr);
      }

      res.json({ success: true, data: await loadDoc(await loadMeta(proyectoId, presupuestoId)) });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (err instanceof NotFoundError) {
        res.status(404).json({ success: false, message: err.message });
        return;
      }
      if (err instanceof BadRequestError) {
        res.status(400).json({ success: false, message: err.message });
        return;
      }
      if (err instanceof ConflictError) {
        res.status(409).json({ success: false, message: err.message });
        return;
      }
      throw err;
    } finally {
      client.release();
    }
  }),
);

// PUT /presupuestos/proyecto/:proyectoId/:presupuestoId/principal — poner la estrella
router.put(
  '/proyecto/:proyectoId/:presupuestoId/principal',
  checkProjectAccess('proyectoId'),
  asyncHandler(async (req: Request<{ proyectoId: string; presupuestoId: string }>, res: Response) => {
    const user = req.user!;
    const proyectoId = parseId(req.params.proyectoId);
    const presupuestoId = parseId(req.params.presupuestoId);
    if (proyectoId == null || presupuestoId == null) {
      res.status(400).json({ success: false, message: 'Identificador invalido' });
      return;
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Se apaga la estrella anterior ANTES de encender la nueva: el indice
      // unico parcial solo admite un principal vivo por proyecto.
      const existe = await client.query(
        `SELECT 1 FROM presupuestos WHERE id = $1 AND proyecto_id = $2 AND activo = TRUE`,
        [presupuestoId, proyectoId],
      );
      if (!existe.rows.length) throw new NotFoundError('Presupuesto no encontrado');
      await client.query(
        `UPDATE presupuestos SET es_principal = FALSE
          WHERE proyecto_id = $1 AND es_principal AND id <> $2`,
        [proyectoId, presupuestoId],
      );
      await client.query(`UPDATE presupuestos SET es_principal = TRUE WHERE id = $1`, [presupuestoId]);
      await client.query('COMMIT');

      try {
        await registrarAudit(user.id, 'editar', 'presupuesto', presupuestoId, {
          proyecto_id: proyectoId, es_principal: true,
        });
      } catch (auditErr) {
        console.error('Error registrando audit de presupuesto:', auditErr);
      }

      res.json({ success: true, data: await listaPresupuestos(proyectoId) });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (err instanceof NotFoundError) {
        res.status(404).json({ success: false, message: err.message });
        return;
      }
      throw err;
    } finally {
      client.release();
    }
  }),
);

// DELETE /presupuestos/proyecto/:proyectoId/:presupuestoId — borrado suave
router.delete(
  '/proyecto/:proyectoId/:presupuestoId',
  checkProjectAccess('proyectoId'),
  asyncHandler(async (req: Request<{ proyectoId: string; presupuestoId: string }>, res: Response) => {
    const user = req.user!;
    const proyectoId = parseId(req.params.proyectoId);
    const presupuestoId = parseId(req.params.presupuestoId);
    if (proyectoId == null || presupuestoId == null) {
      res.status(400).json({ success: false, message: 'Identificador invalido' });
      return;
    }
    // es_principal se apaga al archivar: el indice unico parcial cuenta solo
    // los vivos, pero dejar la estrella puesta en uno archivado confundiria si
    // algun dia se reactiva. Si al borrarlo queda uno solo, ese pasa a oficial.
    const r = await query(
      `UPDATE presupuestos SET activo = FALSE, es_principal = FALSE
        WHERE id = $1 AND proyecto_id = $2 AND activo = TRUE`,
      [presupuestoId, proyectoId],
    );
    if (!r.rowCount) {
      res.status(404).json({ success: false, message: 'Presupuesto no encontrado' });
      return;
    }
    await asegurarEstrella((t, p) => query(t, p as unknown[]), proyectoId);
    try {
      await registrarAudit(user.id, 'eliminar', 'presupuesto', presupuestoId, { proyecto_id: proyectoId });
    } catch (auditErr) {
      console.error('Error registrando audit de presupuesto:', auditErr);
    }
    res.json({ success: true, data: await listaPresupuestos(proyectoId) });
  }),
);

export default router;
