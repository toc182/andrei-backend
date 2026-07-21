// src/routes/desgloses.ts
// Desglose de precios (see andrei-frontend docs/superpowers/specs/2026-07-14-desglose-design.md).
// v1: exactly one active tipo='oficial' desglose per project; PUT replaces the
// whole item set in one transaction (document save, cronograma precedent) with
// an optimistic-concurrency stamp on desgloses.updated_at.

import { Router, type Request, type Response } from 'express';
import { query, pool } from '../database/config.js';
import { authenticateToken, checkPermission, checkProjectAccess } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { registrarAudit } from '../services/auditLog.js';
import type {
  CrearDesgloseCuentaBody, DesgloseComentarioWire, DesgloseCuentaWire,
  DesgloseItemInput, DesgloseItemWire, SaveDesgloseBody,
} from '../types/desglose.js';

const router = Router();
router.use(authenticateToken, checkPermission('desglose_ver'));

// Same canonical text form as cronogramas so load and precondition compare
// byte-identically (no TZ/format drift).
const updatedAtSql = (col = 'updated_at') => `to_char(${col}, 'YYYY-MM-DD"T"HH24:MI:SS.MS')`;

class ConflictError extends Error {}

const MAX_ITEMS = 5000;

interface ItemRow {
  id: number;
  parent_id: number | null;
  tipo: 'grupo' | 'item';
  item: string;
  descripcion: string;
  unidad: string | null;
  cantidad: string | null;         // pg NUMERIC arrives as string
  precio_unitario: string | null;
  orden: number;
}

const rowToWire = (r: ItemRow): DesgloseItemWire => ({
  id: r.id,
  parentId: r.parent_id,
  tipo: r.tipo,
  item: r.item,
  descripcion: r.descripcion,
  unidad: r.unidad,
  cantidad: r.cantidad != null ? parseFloat(r.cantidad) : null,
  precioUnitario: r.precio_unitario != null ? parseFloat(r.precio_unitario) : null,
  orden: r.orden,
});

interface DesgloseRow {
  id: number;
  proyecto_id: number;
  nombre: string;
  tipo: string;
  itbms_tasa: string | null;
  updated_at: string;
}

const DESGLOSE_COLS = `id, proyecto_id, nombre, tipo, itbms_tasa, ${updatedAtSql()} AS updated_at`;

/** Documento completo (meta + items) a partir de la fila ya leída. */
async function loadDoc(m: DesgloseRow) {
  const items = await query<ItemRow>(
    `SELECT id, parent_id, tipo, item, descripcion, unidad, cantidad, precio_unitario, orden
       FROM desglose_items WHERE desglose_id = $1 ORDER BY orden`,
    [m.id],
  );
  return {
    desglose: {
      id: m.id, proyectoId: m.proyecto_id, nombre: m.nombre, tipo: m.tipo,
      itbmsTasa: m.itbms_tasa != null ? parseFloat(m.itbms_tasa) : null, // pg NUMERIC arrives as string
      updatedAt: m.updated_at,
    },
    items: items.rows.map(rowToWire),
  };
}

async function loadOficial(proyectoId: number) {
  const d = await query<DesgloseRow>(
    `SELECT ${DESGLOSE_COLS}
       FROM desgloses WHERE proyecto_id = $1 AND tipo = 'oficial' AND activo = TRUE
      ORDER BY id LIMIT 1`,
    [proyectoId],
  );
  return d.rows.length ? loadDoc(d.rows[0]) : null;
}

/** Un desglose concreto, verificando que pertenece al proyecto de la URL —
 *  checkProjectAccess valida el proyecto, no el desglose. */
async function loadPorId(proyectoId: number, desgloseId: number) {
  const d = await query<DesgloseRow>(
    `SELECT ${DESGLOSE_COLS}
       FROM desgloses WHERE id = $1 AND proyecto_id = $2 AND activo = TRUE`,
    [desgloseId, proyectoId],
  );
  return d.rows.length ? loadDoc(d.rows[0]) : null;
}

/** ITBMS rate: null (sin ITBMS) or a finite number in [0, 100]. Returns the
 *  normalized value, or throws the message string via the caller's 400. */
function validateItbms(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > 100) return 'itbmsTasa inválida';
  return null;
}

/** Payload sanity: tempIds unique, parents reference EARLIER rows (outline order). */
function validateItems(items: DesgloseItemInput[]): string | null {
  if (!Array.isArray(items)) return 'items debe ser un arreglo';
  if (items.length > MAX_ITEMS) return `Máximo ${MAX_ITEMS} filas`;
  const seen = new Set<number>();
  for (const it of items) {
    if (typeof it.tempId !== 'number' || seen.has(it.tempId)) return 'tempId duplicado o inválido';
    if (it.parentTempId != null && !seen.has(it.parentTempId)) return 'parentTempId debe referir a una fila anterior';
    if (it.tipo !== 'grupo' && it.tipo !== 'item') return 'tipo inválido';
    if (it.cantidad != null && (typeof it.cantidad !== 'number' || !Number.isFinite(it.cantidad))) return 'cantidad inválida';
    if (it.precioUnitario != null && (typeof it.precioUnitario !== 'number' || !Number.isFinite(it.precioUnitario))) return 'precio_unitario inválido';
    seen.add(it.tempId);
  }
  return null;
}

/** Reemplaza TODAS las filas del desglose y sella updated_at + itbms.
 *  Compartido por el desglose oficial y los de Cuentas: una sola definición de
 *  qué significa guardar un desglose.
 *
 *  Los padres vienen antes que sus hijos en orden de outline (validado), así que
 *  un solo recorrido resuelve parentTempId -> id nuevo. `orden` sale de la
 *  posición en el arreglo (la invariante validada es posicional) — el campo
 *  `orden` que manda el cliente se ignora. */
async function replaceItems(
  client: { query: typeof pool.query },
  desgloseId: number,
  items: DesgloseItemInput[],
  itbmsTasa: number | null,
): Promise<void> {
  await client.query(`DELETE FROM desglose_items WHERE desglose_id = $1`, [desgloseId]);
  // Un grupo que es padre de alguien es CONTENEDOR — su unidad/montos se derivan
  // de sus hijos, así que se anulan. Un grupo que no tiene hijos es una "sección
  // de una línea" y conserva su propia unidad/cantidad/precio.
  const parentIds = new Set<number>();
  for (const it of items) if (it.parentTempId != null) parentIds.add(it.parentTempId);
  const idMap = new Map<number, number>();
  for (const [i, it] of items.entries()) {
    const isContainer = it.tipo === 'grupo' && parentIds.has(it.tempId);
    const r = await client.query<{ id: number }>(
      `INSERT INTO desglose_items (desglose_id, parent_id, tipo, item, descripcion, unidad, cantidad, precio_unitario, orden)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [
        desgloseId,
        it.parentTempId != null ? idMap.get(it.parentTempId)! : null,
        it.tipo,
        String(it.item ?? '').slice(0, 60),
        String(it.descripcion ?? ''),
        isContainer || it.unidad == null ? null : String(it.unidad).slice(0, 30),
        isContainer ? null : it.cantidad,
        isContainer ? null : it.precioUnitario,
        i,
      ],
    );
    idMap.set(it.tempId, r.rows[0].id);
  }
  await client.query(
    `UPDATE desgloses SET updated_at = CURRENT_TIMESTAMP, itbms_tasa = $2 WHERE id = $1`,
    [desgloseId, itbmsTasa],
  );
}

// GET /desgloses/proyecto/:proyectoId — the official desglose + items (data: null if none)
router.get(
  '/proyecto/:proyectoId',
  checkProjectAccess('proyectoId'),
  asyncHandler(async (req: Request<{ proyectoId: string }>, res: Response) => {
    const proyectoId = parseInt(req.params.proyectoId, 10);
    if (!Number.isInteger(proyectoId)) {
      res.status(400).json({ success: false, message: 'proyectoId inválido' });
      return;
    }
    res.json({ success: true, data: await loadOficial(proyectoId) });
  }),
);

// PUT /desgloses/proyecto/:proyectoId — create-or-replace the official desglose document
router.put(
  '/proyecto/:proyectoId',
  checkProjectAccess('proyectoId'),
  asyncHandler(async (req: Request<{ proyectoId: string }>, res: Response) => {
    const user = req.user!;
    const proyectoId = parseInt(req.params.proyectoId, 10);
    if (!Number.isInteger(proyectoId)) {
      res.status(400).json({ success: false, message: 'proyectoId inválido' });
      return;
    }
    const body = req.body as SaveDesgloseBody;
    const items = body.items ?? [];
    const vErr = validateItems(items);
    if (vErr) {
      res.status(400).json({ success: false, message: vErr });
      return;
    }
    const itbmsErr = validateItbms(body.itbmsTasa);
    if (itbmsErr) {
      res.status(400).json({ success: false, message: itbmsErr });
      return;
    }
    const itbmsTasa = body.itbmsTasa ?? null;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const cur = await client.query<{ id: number; updated_at: string }>(
        `SELECT id, ${updatedAtSql()} AS updated_at
           FROM desgloses WHERE proyecto_id = $1 AND tipo = 'oficial' AND activo = TRUE
          ORDER BY id LIMIT 1 FOR UPDATE`,
        [proyectoId],
      );

      const created = !cur.rows.length;
      let desgloseId: number;
      if (created) {
        // First save creates the document; a stale stamp is impossible here.
        // uq_desgloses_oficial (migration 140) guards the racing-first-save case:
        // two concurrent creates both pass the zero-row check, so the loser's
        // INSERT hits the partial unique index → map 23505 to a 409.
        try {
          const ins = await client.query<{ id: number }>(
            `INSERT INTO desgloses (proyecto_id, nombre, tipo, creado_por) VALUES ($1, COALESCE($2, 'Desglose oficial'), 'oficial', $3) RETURNING id`,
            [proyectoId, body.nombre != null ? String(body.nombre).slice(0, 200) : null, user.id],
          );
          desgloseId = ins.rows[0].id;
        } catch (err) {
          if ((err as { code?: string }).code === '23505') {
            throw new ConflictError('Otro usuario creó el desglose; recarga e intenta de nuevo');
          }
          throw err;
        }
      } else {
        // A null stamp with an EXISTING doc means the client thought it was
        // creating (no desglose loaded) but someone else created first — the
        // same race migration 140 guards, caught earlier. 409, never 400: the
        // conflict alert with "Recargar" is the only path that can succeed.
        if (body.baseUpdatedAt == null) {
          throw new ConflictError('Otro usuario creó el desglose; recarga e intenta de nuevo');
        }
        if (cur.rows[0].updated_at !== body.baseUpdatedAt) {
          throw new ConflictError('Otro usuario guardó cambios; recarga para combinar');
        }
        desgloseId = cur.rows[0].id;
        if (body.nombre) {
          await client.query(`UPDATE desgloses SET nombre = $2 WHERE id = $1`, [
            desgloseId,
            String(body.nombre).slice(0, 200),
          ]);
        }
      }

      await replaceItems(client, desgloseId, items, itbmsTasa);
      await client.query('COMMIT');

      // Audit after commit; a hiccup never fails a committed save.
      try {
        await registrarAudit(user.id, created ? 'crear' : 'editar', 'desglose', desgloseId, {
          proyecto_id: proyectoId,
          filas: items.length,
        });
      } catch (auditErr) {
        console.error('Error registrando audit de desglose:', auditErr);
      }

      res.json({ success: true, data: await loadOficial(proyectoId) });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
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
// Desgloses de la sección Cuentas (tipo='cuentas', migración 142)
//
// A diferencia del oficial (uno solo por proyecto, vive en Información), aquí
// un proyecto tiene VARIOS: el detallado con el que se arman las cuentas, el
// que sale del diseño, el de sustento para la institución. Se pueden crear en
// blanco o copiando uno existente — la copia es una foto de una sola vez y
// después cada documento va por su lado.
// ---------------------------------------------------------------------------

const MAX_DESCRIPCION = 200;
const MAX_COMENTARIO = 4000;
const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Los desgloses de Cuentas de un proyecto, con su hilo de comentarios. */
async function loadDesglosesCuentas(proyectoId: number): Promise<DesgloseCuentaWire[]> {
  const d = await query<{ id: number; nombre: string; fecha: string | null; copiado_de_id: number | null }>(
    `SELECT id, nombre, to_char(fecha, 'YYYY-MM-DD') AS fecha, copiado_de_id
       FROM desgloses
      WHERE proyecto_id = $1 AND tipo = 'cuentas' AND activo = TRUE
      ORDER BY fecha NULLS LAST, id`,
    [proyectoId],
  );
  if (!d.rows.length) return [];
  const ids = d.rows.map((r) => r.id);
  const c = await query<{ id: number; desglose_id: number; texto: string; created_at: string; autor: string | null }>(
    `SELECT c.id, c.desglose_id, c.texto, c.created_at, u.nombre AS autor
       FROM desglose_comentarios c
       LEFT JOIN users u ON u.id = c.creado_por
      WHERE c.desglose_id = ANY($1::int[])
      ORDER BY c.created_at, c.id`,
    [ids],
  );
  const porDesglose = new Map<number, DesgloseComentarioWire[]>();
  for (const row of c.rows) {
    const lista = porDesglose.get(row.desglose_id) ?? [];
    lista.push({
      id: row.id,
      autor: row.autor ?? 'Usuario eliminado',
      creadoAt: new Date(row.created_at).toISOString(),
      texto: row.texto,
    });
    porDesglose.set(row.desglose_id, lista);
  }
  return d.rows.map((r) => ({
    id: r.id,
    descripcion: r.nombre,
    fecha: r.fecha,
    copiadoDeId: r.copiado_de_id,
    comentarios: porDesglose.get(r.id) ?? [],
  }));
}

// GET /desgloses/proyecto/:proyectoId/cuentas — lista de desgloses de Cuentas
router.get(
  '/proyecto/:proyectoId/cuentas',
  checkProjectAccess('proyectoId'),
  asyncHandler(async (req: Request<{ proyectoId: string }>, res: Response) => {
    const proyectoId = parseInt(req.params.proyectoId, 10);
    if (!Number.isInteger(proyectoId)) {
      res.status(400).json({ success: false, message: 'proyectoId inválido' });
      return;
    }
    res.json({ success: true, data: await loadDesglosesCuentas(proyectoId) });
  }),
);

// GET /desgloses/proyecto/:proyectoId/fuentes — de cuáles se puede copiar.
// Incluye el OFICIAL (el de Información): es justo el que más se copia — el
// detallado para cuentas nace de él. Copiar no lo modifica.
router.get(
  '/proyecto/:proyectoId/fuentes',
  checkProjectAccess('proyectoId'),
  asyncHandler(async (req: Request<{ proyectoId: string }>, res: Response) => {
    const proyectoId = parseInt(req.params.proyectoId, 10);
    if (!Number.isInteger(proyectoId)) {
      res.status(400).json({ success: false, message: 'proyectoId inválido' });
      return;
    }
    const r = await query<{ id: number; nombre: string; tipo: string; filas: string }>(
      `SELECT d.id, d.nombre, d.tipo, count(i.id)::text AS filas
         FROM desgloses d
         LEFT JOIN desglose_items i ON i.desglose_id = d.id
        WHERE d.proyecto_id = $1 AND d.activo = TRUE
        GROUP BY d.id, d.nombre, d.tipo, d.fecha
        ORDER BY (d.tipo = 'oficial') DESC, d.fecha NULLS LAST, d.id`,
      [proyectoId],
    );
    res.json({
      success: true,
      data: r.rows.map((x) => ({
        id: x.id,
        descripcion: x.nombre,
        tipo: x.tipo,
        filas: parseInt(x.filas, 10),
      })),
    });
  }),
);

// POST /desgloses/proyecto/:proyectoId/cuentas — crear (en blanco o copiando)
router.post(
  '/proyecto/:proyectoId/cuentas',
  checkProjectAccess('proyectoId'),
  asyncHandler(async (req: Request<{ proyectoId: string }>, res: Response) => {
    const user = req.user!;
    const proyectoId = parseInt(req.params.proyectoId, 10);
    if (!Number.isInteger(proyectoId)) {
      res.status(400).json({ success: false, message: 'proyectoId inválido' });
      return;
    }
    const body = req.body as CrearDesgloseCuentaBody;
    const descripcion = String(body.descripcion ?? '').trim().slice(0, MAX_DESCRIPCION);
    if (!descripcion) {
      res.status(400).json({ success: false, message: 'La descripción es obligatoria' });
      return;
    }
    const fecha = body.fecha == null || body.fecha === '' ? null : String(body.fecha);
    if (fecha != null && !FECHA_RE.test(fecha)) {
      res.status(400).json({ success: false, message: 'fecha inválida (YYYY-MM-DD)' });
      return;
    }
    const copiarDeId = body.copiarDeId == null ? null : Number(body.copiarDeId);
    if (copiarDeId != null && !Number.isInteger(copiarDeId)) {
      res.status(400).json({ success: false, message: 'copiarDeId inválido' });
      return;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // El origen debe existir, estar activo y ser DEL MISMO PROYECTO — si no,
      // copiar sería una fuga de precios entre proyectos.
      let origen: { id: number; itbms_tasa: string | null } | null = null;
      if (copiarDeId != null) {
        const o = await client.query<{ id: number; itbms_tasa: string | null }>(
          `SELECT id, itbms_tasa FROM desgloses
            WHERE id = $1 AND proyecto_id = $2 AND activo = TRUE`,
          [copiarDeId, proyectoId],
        );
        if (!o.rows.length) {
          res.status(400).json({ success: false, message: 'El desglose a copiar no existe en este proyecto' });
          await client.query('ROLLBACK');
          return;
        }
        origen = o.rows[0];
      }

      const ins = await client.query<{ id: number }>(
        `INSERT INTO desgloses (proyecto_id, nombre, tipo, fecha, copiado_de_id, itbms_tasa, creado_por)
         VALUES ($1, $2, 'cuentas', $3, $4, $5, $6) RETURNING id`,
        [proyectoId, descripcion, fecha, origen?.id ?? null, origen?.itbms_tasa ?? null, user.id],
      );
      const nuevoId = ins.rows[0].id;

      let filasCopiadas = 0;
      if (origen) {
        // Copia de filas conservando el árbol: en orden de outline el padre
        // SIEMPRE va antes que sus hijos, así que un solo recorrido basta para
        // remapear parent_id viejo -> nuevo.
        const src = await client.query<ItemRow>(
          `SELECT id, parent_id, tipo, item, descripcion, unidad, cantidad, precio_unitario, orden
             FROM desglose_items WHERE desglose_id = $1 ORDER BY orden`,
          [origen.id],
        );
        const idMap = new Map<number, number>();
        for (const [i, it] of src.rows.entries()) {
          const r = await client.query<{ id: number }>(
            `INSERT INTO desglose_items (desglose_id, parent_id, tipo, item, descripcion, unidad, cantidad, precio_unitario, orden)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
            [
              nuevoId,
              it.parent_id != null ? idMap.get(it.parent_id) ?? null : null,
              it.tipo, it.item, it.descripcion, it.unidad, it.cantidad, it.precio_unitario, i,
            ],
          );
          idMap.set(it.id, r.rows[0].id);
        }
        filasCopiadas = src.rows.length;
      }

      await client.query('COMMIT');

      try {
        await registrarAudit(user.id, 'crear', 'desglose', nuevoId, {
          proyecto_id: proyectoId,
          tipo: 'cuentas',
          copiado_de_id: origen?.id ?? null,
          filas: filasCopiadas,
        });
      } catch (auditErr) {
        console.error('Error registrando audit de desglose de cuentas:', auditErr);
      }

      res.status(201).json({ success: true, data: await loadDesglosesCuentas(proyectoId) });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }),
);

// GET /desgloses/proyecto/:proyectoId/cuentas/:desgloseId — un desglose concreto
router.get(
  '/proyecto/:proyectoId/cuentas/:desgloseId',
  checkProjectAccess('proyectoId'),
  asyncHandler(async (req: Request<{ proyectoId: string; desgloseId: string }>, res: Response) => {
    const proyectoId = parseInt(req.params.proyectoId, 10);
    const desgloseId = parseInt(req.params.desgloseId, 10);
    if (!Number.isInteger(proyectoId) || !Number.isInteger(desgloseId)) {
      res.status(400).json({ success: false, message: 'Parámetros inválidos' });
      return;
    }
    const doc = await loadPorId(proyectoId, desgloseId);
    if (!doc) {
      res.status(404).json({ success: false, message: 'Desglose no encontrado' });
      return;
    }
    res.json({ success: true, data: doc });
  }),
);

// PUT /desgloses/proyecto/:proyectoId/cuentas/:desgloseId — guardar sus filas.
// A diferencia del oficial, el documento SIEMPRE existe (se creó con POST), así
// que no hay create-or-replace ni carrera de creación: sólo concurrencia
// optimista sobre updated_at.
router.put(
  '/proyecto/:proyectoId/cuentas/:desgloseId',
  checkProjectAccess('proyectoId'),
  asyncHandler(async (req: Request<{ proyectoId: string; desgloseId: string }>, res: Response) => {
    const user = req.user!;
    const proyectoId = parseInt(req.params.proyectoId, 10);
    const desgloseId = parseInt(req.params.desgloseId, 10);
    if (!Number.isInteger(proyectoId) || !Number.isInteger(desgloseId)) {
      res.status(400).json({ success: false, message: 'Parámetros inválidos' });
      return;
    }
    const body = req.body as SaveDesgloseBody;
    const items = body.items ?? [];
    const vErr = validateItems(items);
    if (vErr) {
      res.status(400).json({ success: false, message: vErr });
      return;
    }
    const itbmsErr = validateItbms(body.itbmsTasa);
    if (itbmsErr) {
      res.status(400).json({ success: false, message: itbmsErr });
      return;
    }
    const itbmsTasa = body.itbmsTasa ?? null;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const cur = await client.query<{ id: number; updated_at: string }>(
        `SELECT id, ${updatedAtSql()} AS updated_at
           FROM desgloses WHERE id = $1 AND proyecto_id = $2 AND activo = TRUE FOR UPDATE`,
        [desgloseId, proyectoId],
      );
      if (!cur.rows.length) {
        await client.query('ROLLBACK');
        res.status(404).json({ success: false, message: 'Desglose no encontrado' });
        return;
      }
      if (body.baseUpdatedAt != null && cur.rows[0].updated_at !== body.baseUpdatedAt) {
        throw new ConflictError('Otro usuario guardó cambios; recarga para combinar');
      }
      if (body.nombre) {
        await client.query(`UPDATE desgloses SET nombre = $2 WHERE id = $1`, [
          desgloseId, String(body.nombre).slice(0, 200),
        ]);
      }
      await replaceItems(client, desgloseId, items, itbmsTasa);
      await client.query('COMMIT');

      try {
        await registrarAudit(user.id, 'editar', 'desglose', desgloseId, {
          proyecto_id: proyectoId,
          tipo: 'cuentas',
          filas: items.length,
        });
      } catch (auditErr) {
        console.error('Error registrando audit de desglose:', auditErr);
      }

      res.json({ success: true, data: await loadPorId(proyectoId, desgloseId) });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
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

// POST /desgloses/proyecto/:proyectoId/cuentas/:desgloseId/comentarios
router.post(
  '/proyecto/:proyectoId/cuentas/:desgloseId/comentarios',
  checkProjectAccess('proyectoId'),
  asyncHandler(async (req: Request<{ proyectoId: string; desgloseId: string }>, res: Response) => {
    const user = req.user!;
    const proyectoId = parseInt(req.params.proyectoId, 10);
    const desgloseId = parseInt(req.params.desgloseId, 10);
    if (!Number.isInteger(proyectoId) || !Number.isInteger(desgloseId)) {
      res.status(400).json({ success: false, message: 'Parámetros inválidos' });
      return;
    }
    const texto = String((req.body as { texto?: unknown }).texto ?? '').trim().slice(0, MAX_COMENTARIO);
    if (!texto) {
      res.status(400).json({ success: false, message: 'El comentario no puede estar vacío' });
      return;
    }
    // El desglose debe pertenecer al proyecto de la URL: checkProjectAccess
    // valida el proyecto, no el desglose.
    const d = await query<{ id: number }>(
      `SELECT id FROM desgloses WHERE id = $1 AND proyecto_id = $2 AND activo = TRUE`,
      [desgloseId, proyectoId],
    );
    if (!d.rows.length) {
      res.status(404).json({ success: false, message: 'Desglose no encontrado' });
      return;
    }
    await query(
      `INSERT INTO desglose_comentarios (desglose_id, texto, creado_por) VALUES ($1, $2, $3)`,
      [desgloseId, texto, user.id],
    );
    try {
      await registrarAudit(user.id, 'editar', 'desglose', desgloseId, {
        proyecto_id: proyectoId,
        accion: 'comentario',
      });
    } catch (auditErr) {
      console.error('Error registrando audit de comentario de desglose:', auditErr);
    }
    res.status(201).json({ success: true, data: await loadDesglosesCuentas(proyectoId) });
  }),
);

export default router;
