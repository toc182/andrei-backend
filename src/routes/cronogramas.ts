// Cronograma (Gantt schedule) routes.
//
// A cronograma is a first-class entity that OPTIONALLY attaches to a project.
// Persisted = config + tasks + dependencies; the schedule (dates) is COMPUTED by
// the shared engine on read and validated (cycle rejection) on save, never stored.
//
// v1 is gated to a single user by EMAIL (betaFeatureSingleUser) — see cronogramaGate.ts.
//
// Wire shape mirrors the standalone Gantto `{project, tasks}` format (tasks carry
// embedded predecessors), so import/export round-trips and the frontend feeds tasks
// straight into the same engine.

import { Router, Request, Response } from 'express';
import { query, pool } from '../database/config.js';
import { authenticateToken } from '../middleware/auth.js';
import { betaFeatureSingleUser } from '../middleware/cronogramaGate.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import {
  computeSchedule,
  computeRollup,
  checkViolations,
  computeCritical,
  hasCycle,
  type EngineTask,
  type EngineProject,
  type TaskId,
  type DepType,
  type TaskType,
  type MilestoneType,
} from '../services/cronogramaEngine.js';
import type {
  CronogramaConfig,
  CronogramaComputed,
  CronogramaListItem,
  SaveCronogramaBody,
  ImportCronogramaBody,
} from '../types/cronograma.js';
import type { PoolClient } from 'pg';

const router = Router();
router.use(authenticateToken, betaFeatureSingleUser);

// ---------- DB row types ----------
interface CronogramaRow {
  id: number;
  nombre: string;
  proyecto_id: number | null;
  fecha_inicio: string;
  semana_laboral: number;
  feriados: string[] | null;
  baseline: unknown | null;
  updated_at: string;
}

/** Optimistic-concurrency / referential conflict during a save → maps to HTTP 409. */
class ConflictError extends Error {}

// Single canonical text form of updated_at so the value the client receives on load is
// byte-identical to the value the save precondition compares against (no TZ/format drift).
const UPDATED_AT_SQL = `to_char(updated_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS')`;
interface TareaRow {
  id: number;
  parent_id: number | null;
  tipo: TaskType;
  tipo_hito: MilestoneType | null;
  nombre: string;
  duracion: number;
  fecha_manual: string | null;
  porcentaje_completado: number;
  color: string | null;
  notas: string | null;
  orden: number;
}
interface DepRow {
  tarea_id: number;
  predecesora_id: number;
  tipo: DepType;
  lag: number;
}

// ---------- helpers ----------
function mapToObj<V>(m: Map<TaskId, V>): Record<string, V> {
  const o: Record<string, V> = {};
  for (const [k, v] of m) o[String(k)] = v;
  return o;
}

function rowToConfig(r: CronogramaRow): CronogramaConfig {
  return {
    id: r.id,
    name: r.nombre,
    proyectoId: r.proyecto_id,
    startDate: r.fecha_inicio,
    workWeek: r.semana_laboral,
    holidays: r.feriados || [],
    baseline: r.baseline ?? null,
    updatedAt: r.updated_at,
  };
}

function rowsToEngineTasks(taskRows: TareaRow[], depRows: DepRow[]): EngineTask[] {
  const preds = new Map<number, { taskId: TaskId; type: DepType; lag: number }[]>();
  for (const d of depRows) {
    if (!preds.has(d.tarea_id)) preds.set(d.tarea_id, []);
    preds.get(d.tarea_id)!.push({ taskId: d.predecesora_id, type: d.tipo, lag: d.lag });
  }
  return taskRows.map((t) => ({
    id: t.id,
    parentId: t.parent_id,
    type: t.tipo,
    milestoneType: t.tipo_hito,
    name: t.nombre,
    duration: t.duracion,
    manualDate: t.fecha_manual,
    percentComplete: t.porcentaje_completado,
    color: t.color,
    notes: t.notas,
    order: t.orden,
    predecessors: preds.get(t.id) || [],
  }));
}

function engineProject(c: CronogramaConfig): EngineProject {
  return {
    startDate: c.startDate,
    workWeek: String(c.workWeek),
    holidays: c.holidays,
    baseline: c.baseline,
  };
}

function computeAll(tasks: EngineTask[], proj: EngineProject): CronogramaComputed {
  const cycle = hasCycle(tasks);
  const sched = computeSchedule(tasks, proj);
  return {
    schedule: mapToObj(sched),
    rollup: mapToObj(computeRollup(tasks)),
    violations: [...checkViolations(tasks, sched)],
    critical: [...computeCritical(tasks, proj, sched)],
    cycle,
  };
}

async function loadDetail(
  cronogramaId: number,
): Promise<{ config: CronogramaConfig; tasks: EngineTask[] } | null> {
  const c = await query<CronogramaRow>(
    `SELECT id, nombre, proyecto_id, to_char(fecha_inicio,'YYYY-MM-DD') AS fecha_inicio,
            semana_laboral, feriados, baseline, ${UPDATED_AT_SQL} AS updated_at
       FROM cronogramas WHERE id = $1 AND activo = TRUE`,
    [cronogramaId],
  );
  if (!c.rows.length) return null;
  const config = rowToConfig(c.rows[0]);
  const tareas = await query<TareaRow>(
    `SELECT id, parent_id, tipo, tipo_hito, nombre, duracion,
            to_char(fecha_manual,'YYYY-MM-DD') AS fecha_manual,
            porcentaje_completado, color, notas, orden
       FROM cronograma_tareas WHERE cronograma_id = $1 ORDER BY orden`,
    [cronogramaId],
  );
  const deps = await query<DepRow>(
    `SELECT tarea_id, predecesora_id, tipo, lag
       FROM cronograma_dependencias WHERE cronograma_id = $1`,
    [cronogramaId],
  );
  return { config, tasks: rowsToEngineTasks(tareas.rows, deps.rows) };
}

/** Validate referential integrity of an incoming task tree (parent + predecessor refs). */
function validateRefs(tasks: EngineTask[]): string | null {
  const ids = new Set<TaskId>(tasks.map((t) => t.id));
  for (const t of tasks) {
    if (t.parentId != null && !ids.has(t.parentId))
      return `La tarea ${String(t.id)} referencia un padre inexistente (${String(t.parentId)})`;
    for (const p of t.predecessors || [])
      if (!ids.has(p.taskId))
        return `La tarea ${String(t.id)} referencia una predecesora inexistente (${String(p.taskId)})`;
  }
  return null;
}

/**
 * Replace the task tree + dependencies of a cronograma in one transaction, preserving
 * the ids of existing tasks. New tasks (id <= 0, string, or not present in the DB) are
 * inserted and their original id is mapped to the new SERIAL id. Returns that map so the
 * client can reconcile newly-created rows.
 */
async function persistTree(
  client: PoolClient,
  cronogramaId: number,
  tasks: EngineTask[],
): Promise<Map<TaskId, number>> {
  const ex = await client.query<{ id: number }>(
    `SELECT id FROM cronograma_tareas WHERE cronograma_id = $1`,
    [cronogramaId],
  );
  const existing = new Set<number>(ex.rows.map((r) => r.id));
  const isNew = (id: TaskId): boolean => !(typeof id === 'number' && id > 0 && existing.has(id));
  const map = new Map<TaskId, number>();
  const remap = (id: TaskId | null): number | null =>
    id == null ? null : isNew(id) ? map.get(id)! : (id as number);

  // Phase 1: insert new tasks with parent_id NULL (parent set in phase 3 once all ids exist).
  for (const t of tasks) {
    if (!isNew(t.id)) continue;
    const r = await client.query<{ id: number }>(
      `INSERT INTO cronograma_tareas
        (cronograma_id, parent_id, tipo, tipo_hito, nombre, duracion, fecha_manual,
         porcentaje_completado, color, notas, orden)
       VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [
        cronogramaId,
        t.type,
        t.milestoneType ?? null,
        t.name ?? '',
        t.duration ?? 0,
        t.manualDate ?? null,
        t.percentComplete ?? 0,
        t.color ?? null,
        t.notes ?? null,
        t.order ?? 0,
      ],
    );
    map.set(t.id, r.rows[0].id);
  }

  // Phase 2: update existing tasks (fields + remapped parent). Assert each expected row still
  // exists — a 0-row update means the task vanished (deleted by a concurrent save); treat that as
  // a conflict rather than silently dropping the edit.
  for (const t of tasks) {
    if (isNew(t.id)) continue;
    const upd = await client.query(
      `UPDATE cronograma_tareas SET
         parent_id = $2, tipo = $3, tipo_hito = $4, nombre = $5, duracion = $6,
         fecha_manual = $7, porcentaje_completado = $8, color = $9, notas = $10,
         orden = $11, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND cronograma_id = $12`,
      [
        t.id,
        remap(t.parentId),
        t.type,
        t.milestoneType ?? null,
        t.name ?? '',
        t.duration ?? 0,
        t.manualDate ?? null,
        t.percentComplete ?? 0,
        t.color ?? null,
        t.notes ?? null,
        t.order ?? 0,
        cronogramaId,
      ],
    );
    if (upd.rowCount !== 1)
      throw new ConflictError(`La tarea ${String(t.id)} ya no existe (otro guardado la modificó); recarga.`);
  }

  // Phase 3: set parent_id of newly-inserted tasks (now that every id is known).
  for (const t of tasks) {
    if (!isNew(t.id) || t.parentId == null) continue;
    await client.query(`UPDATE cronograma_tareas SET parent_id = $2 WHERE id = $1`, [
      map.get(t.id)!,
      remap(t.parentId),
    ]);
  }

  // Phase 4: delete existing tasks no longer present (CASCADE removes their deps).
  const keep = new Set<number>(tasks.filter((t) => !isNew(t.id)).map((t) => t.id as number));
  for (const id of existing) {
    if (!keep.has(id)) await client.query(`DELETE FROM cronograma_tareas WHERE id = $1`, [id]);
  }

  // Phase 5: replace all dependencies from the payload's embedded predecessors.
  await client.query(`DELETE FROM cronograma_dependencias WHERE cronograma_id = $1`, [cronogramaId]);
  for (const t of tasks) {
    for (const p of t.predecessors || []) {
      await client.query(
        `INSERT INTO cronograma_dependencias (cronograma_id, tarea_id, predecesora_id, tipo, lag)
         VALUES ($1, $2, $3, $4, $5)`,
        [cronogramaId, remap(t.id), remap(p.taskId), p.type || 'FS', p.lag || 0],
      );
    }
  }
  return map;
}

function normWorkWeek(v: number | string | undefined): number {
  const n = parseInt(String(v ?? 5), 10);
  return n === 6 || n === 7 ? n : 5;
}

// ---------- routes ----------

// GET /cronogramas  — index list (optional ?proyecto_id=)
router.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const proyectoId = req.query.proyecto_id ? parseInt(String(req.query.proyecto_id), 10) : null;
    const result = await query<{
      id: number;
      nombre: string;
      proyecto_id: number | null;
      proyecto_nombre: string | null;
      fecha_inicio: string;
      updated_at: Date;
      task_count: string;
    }>(
      `SELECT c.id, c.nombre, c.proyecto_id, p.nombre AS proyecto_nombre,
              to_char(c.fecha_inicio,'YYYY-MM-DD') AS fecha_inicio, c.updated_at,
              (SELECT COUNT(*) FROM cronograma_tareas t WHERE t.cronograma_id = c.id) AS task_count
         FROM cronogramas c
         LEFT JOIN proyectos p ON p.id = c.proyecto_id
        WHERE c.activo = TRUE AND ($1::int IS NULL OR c.proyecto_id = $1)
        ORDER BY c.updated_at DESC`,
      [proyectoId],
    );
    const data: CronogramaListItem[] = result.rows.map((r) => ({
      id: r.id,
      nombre: r.nombre,
      proyectoId: r.proyecto_id,
      proyectoNombre: r.proyecto_nombre,
      fechaInicio: r.fecha_inicio,
      taskCount: parseInt(r.task_count, 10),
      updatedAt: r.updated_at.toISOString(),
    }));
    res.json({ success: true, data });
  }),
);

// GET /cronogramas/:id  — full cronograma + server-computed schedule
router.get(
  '/:id',
  asyncHandler(async (req: Request<{ id: string }>, res: Response) => {
    const detail = await loadDetail(parseInt(req.params.id, 10));
    if (!detail) {
      res.status(404).json({ success: false, message: 'Cronograma no encontrado' });
      return;
    }
    const computed = computeAll(detail.tasks, engineProject(detail.config));
    res.json({ success: true, data: { project: detail.config, tasks: detail.tasks, computed } });
  }),
);

// POST /cronogramas  — create (config only)
router.post(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const { name, proyectoId, startDate, workWeek, holidays, baseline } =
      req.body as SaveCronogramaBody['project'];
    if (!name || !startDate) {
      res.status(400).json({ success: false, message: 'name y startDate son obligatorios' });
      return;
    }
    if (proyectoId != null) {
      const p = await query(`SELECT 1 FROM proyectos WHERE id = $1`, [proyectoId]);
      if (!p.rows.length) {
        res.status(400).json({ success: false, message: 'Proyecto no encontrado' });
        return;
      }
    }
    const r = await query<{ id: number }>(
      `INSERT INTO cronogramas (nombre, proyecto_id, fecha_inicio, semana_laboral, feriados, baseline, creado_por)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [
        name,
        proyectoId ?? null,
        startDate,
        normWorkWeek(workWeek),
        JSON.stringify(holidays ?? []),
        baseline != null ? JSON.stringify(baseline) : null,
        user.id,
      ],
    );
    res.status(201).json({ success: true, data: { id: r.rows[0].id } });
  }),
);

// PUT /cronogramas/:id/save  — bulk save config + tasks + deps (cycle rejected)
router.put(
  '/:id/save',
  asyncHandler(async (req: Request<{ id: string }>, res: Response) => {
    const id = parseInt(req.params.id, 10);
    const body = req.body as SaveCronogramaBody;
    const tasks = body.tasks || [];

    const refErr = validateRefs(tasks);
    if (refErr) {
      res.status(400).json({ success: false, message: refErr });
      return;
    }
    if (hasCycle(tasks)) {
      res.status(400).json({ success: false, message: 'Ciclo de dependencias: no se puede guardar' });
      return;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Lock the row and read its current version for the optimistic-concurrency precondition.
      const cur = await client.query<{ updated_at: string }>(
        `SELECT ${UPDATED_AT_SQL} AS updated_at FROM cronogramas WHERE id = $1 AND activo = TRUE FOR UPDATE`,
        [id],
      );
      if (!cur.rows.length) {
        await client.query('ROLLBACK');
        res.status(404).json({ success: false, message: 'Cronograma no encontrado' });
        return;
      }
      // Optimistic-concurrency precondition is mandatory (the client always sends the stamp it
      // started from) — refuse to fall back to last-writer-wins if it's ever omitted.
      if (body.baseUpdatedAt == null) {
        await client.query('ROLLBACK');
        res.status(400).json({ success: false, message: 'baseUpdatedAt es obligatorio' });
        return;
      }
      if (cur.rows[0].updated_at !== body.baseUpdatedAt) {
        throw new ConflictError('Otra pestaña guardó cambios; recarga para combinar');
      }

      if (body.project) {
        const c = body.project;
        await client.query(
          `UPDATE cronogramas SET
             nombre = COALESCE($2, nombre), proyecto_id = $3, fecha_inicio = COALESCE($4, fecha_inicio),
             semana_laboral = $5, feriados = $6, baseline = $7
           WHERE id = $1`,
          [
            id,
            c.name ?? null,
            c.proyectoId ?? null,
            c.startDate ?? null,
            normWorkWeek(c.workWeek),
            JSON.stringify(c.holidays ?? []),
            c.baseline != null ? JSON.stringify(c.baseline) : null,
          ],
        );
      }
      const map = await persistTree(client, id, tasks);
      // Bump the version on EVERY save (tasks-only too) so successive autosaves keep the
      // precondition reliable and don't self-409. RETURNING gives the authoritative stamp THIS
      // transaction wrote, so the value handed back to the client can't be a racing writer's.
      const bump = await client.query<{ updated_at: string }>(
        `UPDATE cronogramas SET updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING ${UPDATED_AT_SQL} AS updated_at`,
        [id],
      );
      await client.query('COMMIT');

      const detail = await loadDetail(id);
      if (!detail) {
        // Soft-deleted in the post-commit read window — don't return success with empty data
        // (the client would overwrite its live model with undefined and clear its draft).
        res.status(409).json({ success: false, code: 'conflict', message: 'El cronograma fue eliminado durante el guardado; recarga.' });
        return;
      }
      detail.config.updatedAt = bump.rows[0].updated_at; // authoritative: the stamp this tx committed
      const computed = computeAll(detail.tasks, engineProject(detail.config));
      res.json({
        success: true,
        data: {
          idMap: Object.fromEntries([...map].map(([k, v]) => [String(k), v])),
          project: detail.config,
          tasks: detail.tasks,
          computed,
        },
      });
    } catch (err) {
      await client.query('ROLLBACK');
      if (err instanceof ConflictError) {
        res.status(409).json({ success: false, code: 'conflict', message: err.message });
        return;
      }
      throw err;
    } finally {
      client.release();
    }
  }),
);

// DELETE /cronogramas/:id  — soft delete
router.delete(
  '/:id',
  asyncHandler(async (req: Request<{ id: string }>, res: Response) => {
    const id = parseInt(req.params.id, 10);
    const r = await query(
      `UPDATE cronogramas SET activo = FALSE, updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND activo = TRUE`,
      [id],
    );
    if (!r.rowCount) {
      res.status(404).json({ success: false, message: 'Cronograma no encontrado' });
      return;
    }
    res.json({ success: true });
  }),
);

// POST /cronogramas/import  — create from standard {project, tasks} JSON (web string ids)
router.post(
  '/import',
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const body = req.body as ImportCronogramaBody;
    const tasks = body.tasks || [];
    if (!body.project || !body.project.startDate) {
      res.status(400).json({ success: false, message: 'project.startDate es obligatorio' });
      return;
    }
    const refErr = validateRefs(tasks);
    if (refErr) {
      res.status(400).json({ success: false, message: refErr });
      return;
    }
    if (hasCycle(tasks)) {
      res.status(400).json({ success: false, message: 'Ciclo de dependencias en el archivo importado' });
      return;
    }
    if (body.proyectoId != null) {
      const p = await query(`SELECT 1 FROM proyectos WHERE id = $1`, [body.proyectoId]);
      if (!p.rows.length) {
        res.status(400).json({ success: false, message: 'Proyecto no encontrado' });
        return;
      }
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const created = await client.query<{ id: number }>(
        `INSERT INTO cronogramas (nombre, proyecto_id, fecha_inicio, semana_laboral, feriados, baseline, creado_por)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [
          body.nombre || body.project.name || 'Cronograma importado',
          body.proyectoId ?? null,
          body.project.startDate,
          normWorkWeek(body.project.workWeek),
          JSON.stringify(body.project.holidays ?? []),
          body.project.baseline != null ? JSON.stringify(body.project.baseline) : null,
          user.id,
        ],
      );
      const newId = created.rows[0].id;
      await persistTree(client, newId, tasks);
      await client.query('COMMIT');
      res.status(201).json({ success: true, data: { id: newId } });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }),
);

// GET /cronogramas/:id/export  — download standard {project, tasks} (stable string ids)
router.get(
  '/:id/export',
  asyncHandler(async (req: Request<{ id: string }>, res: Response) => {
    const detail = await loadDetail(parseInt(req.params.id, 10));
    if (!detail) {
      res.status(404).json({ success: false, message: 'Cronograma no encontrado' });
      return;
    }
    const sid = (id: TaskId | null): string | null => (id == null ? null : `t${id}`);
    const out = {
      project: {
        id: `cronograma-${detail.config.id}`,
        name: detail.config.name,
        startDate: detail.config.startDate,
        workWeek: String(detail.config.workWeek),
        baseline: detail.config.baseline ?? null,
        holidays: detail.config.holidays,
      },
      tasks: detail.tasks.map((t) => ({
        id: sid(t.id),
        parentId: sid(t.parentId ?? null),
        type: t.type,
        milestoneType: t.milestoneType ?? null,
        name: t.name,
        duration: t.duration,
        manualDate: t.manualDate ?? null,
        percentComplete: t.percentComplete,
        color: t.color ?? null,
        notes: t.notes ?? null,
        predecessors: (t.predecessors || []).map((p) => ({
          taskId: sid(p.taskId),
          type: p.type,
          lag: p.lag,
        })),
        order: t.order,
      })),
    };
    const fname = `cronograma-${detail.config.id}.gantto.json`;
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify(out, null, 2));
  }),
);

export default router;
