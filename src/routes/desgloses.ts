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
import type { DesgloseItemInput, DesgloseItemWire, SaveDesgloseBody } from '../types/desglose.js';

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

async function loadOficial(proyectoId: number) {
  const d = await query<{ id: number; proyecto_id: number; nombre: string; tipo: string; updated_at: string }>(
    `SELECT id, proyecto_id, nombre, tipo, ${updatedAtSql()} AS updated_at
       FROM desgloses WHERE proyecto_id = $1 AND tipo = 'oficial' AND activo = TRUE
      ORDER BY id LIMIT 1`,
    [proyectoId],
  );
  if (!d.rows.length) return null;
  const items = await query<ItemRow>(
    `SELECT id, parent_id, tipo, item, descripcion, unidad, cantidad, precio_unitario, orden
       FROM desglose_items WHERE desglose_id = $1 ORDER BY orden`,
    [d.rows[0].id],
  );
  const m = d.rows[0];
  return {
    desglose: { id: m.id, proyectoId: m.proyecto_id, nombre: m.nombre, tipo: m.tipo, updatedAt: m.updated_at },
    items: items.rows.map(rowToWire),
  };
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
        if (body.baseUpdatedAt == null) {
          await client.query('ROLLBACK');
          res.status(400).json({ success: false, message: 'baseUpdatedAt es obligatorio' });
          return;
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

      // Replace all items; parents come earlier in outline order (validated), so
      // a single pass resolves parentTempId -> new DB id. orden is derived from
      // array position (the validated invariant is positional) — the client's
      // orden field is ignored.
      await client.query(`DELETE FROM desglose_items WHERE desglose_id = $1`, [desgloseId]);
      const idMap = new Map<number, number>();
      for (const [i, it] of items.entries()) {
        const r = await client.query<{ id: number }>(
          `INSERT INTO desglose_items (desglose_id, parent_id, tipo, item, descripcion, unidad, cantidad, precio_unitario, orden)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
          [
            desgloseId,
            it.parentTempId != null ? idMap.get(it.parentTempId)! : null,
            it.tipo,
            String(it.item ?? '').slice(0, 60),
            String(it.descripcion ?? ''),
            it.unidad != null ? String(it.unidad).slice(0, 30) : null,
            it.tipo === 'grupo' ? null : it.cantidad,
            it.tipo === 'grupo' ? null : it.precioUnitario,
            i,
          ],
        );
        idMap.set(it.tempId, r.rows[0].id);
      }
      await client.query(
        `UPDATE desgloses SET updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [desgloseId],
      );
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

export default router;
