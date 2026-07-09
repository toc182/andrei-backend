// Wire + DB types for the Cronograma feature.
//
// The wire shape mirrors the standalone Gantto `{project, tasks}` format so that
// import/export round-trips losslessly and the frontend can feed `tasks` straight
// into the shared engine. DB row <-> wire mapping lives in routes/cronogramas.ts.

import type { EngineTask } from '../services/cronogramaEngine.js';

/** Cronograma config = the engine "project" plus ERP metadata. */
export interface CronogramaConfig {
  id: number;
  name: string;
  proyectoId: number | null;
  startDate: string; // "YYYY-MM-DD"
  workWeek: number; // 5 | 6 | 7
  holidays: string[]; // ["YYYY-MM-DD", ...]
  baseline: unknown | null;
  /** Print/PDF setup (paper, columns, logos…) — opaque JSON owned by the frontend dialog. */
  ajustesImpresion?: unknown | null;
  updatedAt?: string; // server version stamp (optimistic-concurrency precondition for save)
}

/** Server-computed, never persisted. Maps serialized as id-keyed objects. */
export interface CronogramaComputed {
  schedule: Record<string, { s: string; f: string }>;
  rollup: Record<string, number>;
  violations: (string | number)[];
  critical: (string | number)[];
  cycle: boolean;
}

/** GET /cronogramas/:id */
export interface CronogramaDetail {
  project: CronogramaConfig;
  tasks: EngineTask[];
  computed: CronogramaComputed;
}

/** Row in the index list (GET /cronogramas). */
export interface CronogramaListItem {
  id: number;
  nombre: string;
  proyectoId: number | null;
  proyectoNombre: string | null;
  fechaInicio: string;
  taskCount: number;
  updatedAt: string;
}

/** Config fields a client may set on create/save (no id). */
export interface CronogramaConfigInput {
  name: string;
  proyectoId?: number | null;
  startDate: string;
  workWeek: number;
  holidays?: string[];
  baseline?: unknown | null;
}

/** PUT /cronogramas/:id/save body. tasks may use temp ids (negative/string) for new rows. */
export interface SaveCronogramaBody {
  project: CronogramaConfigInput;
  tasks: EngineTask[];
  /** Optimistic-concurrency precondition: the updatedAt the client started editing from.
   *  When present and it no longer matches the row, the save is rejected with 409. */
  baseUpdatedAt?: string | null;
}

/** POST /cronogramas/import body — standard {project, tasks} (web string ids) + optional attach. */
export interface ImportCronogramaBody {
  project: { name?: string; startDate: string; workWeek?: number | string; holidays?: string[]; baseline?: unknown | null };
  tasks: EngineTask[];
  proyectoId?: number | null;
  nombre?: string;
}
