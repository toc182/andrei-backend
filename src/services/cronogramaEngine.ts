// Cronograma scheduling engine — VERBATIM PORT of Gantto/ganttoweb/engine.js.
//
// Duplicated BYTE-FOR-BYTE IDENTICAL in two repos — keep them in sync:
//   andrei-backend/src/services/cronogramaEngine.ts   (scheduling authority)
//   andrei-frontend/src/lib/cronogramaEngine.ts       (live recompute while editing)
// Any change MUST keep the golden fixtures green:  (backend) npx tsx scripts/cronograma-parity.ts
//
// Dates are "YYYY-MM-DD" strings compared lexicographically (zero-padding is load-bearing).
// Replicates the 3 documented quirks: Q1 SF≈SS, Q2 FF short-circuit (last FF wins), Q3 FS lag+1.
// `holidays` (optional array of "YYYY-MM-DD") — a holiday is never a work day.
//
// Id-type-agnostic: ids may be string (web/test fixtures) or number (DB SERIAL in the ERP).

export type TaskType = 'task' | 'group' | 'milestone';
export type MilestoneType = 'calculated' | 'fixed';
export type DepType = 'FS' | 'SS' | 'FF' | 'SF';
export type TaskId = string | number;

export interface Predecessor {
  taskId: TaskId;
  type: DepType;
  lag: number;
}

export interface EngineTask {
  id: TaskId;
  parentId: TaskId | null;
  type: TaskType;
  milestoneType?: MilestoneType | null;
  name?: string;
  duration?: number;
  manualDate?: string | null;
  percentComplete?: number;
  color?: string | null;
  notes?: string | null;
  predecessors?: Predecessor[];
  order?: number;
}

export interface EngineProject {
  startDate: string; // "YYYY-MM-DD"
  workWeek: string | number; // "5" | "6" | "7"
  holidays?: string[]; // ["YYYY-MM-DD", ...]
  baseline?: unknown;
}

export interface ScheduleEntry {
  s: string;
  f: string;
}
export type Schedule = Map<TaskId, ScheduleEntry>;
export type Rollup = Map<TaskId, number>;

export function parseDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
export function fmtDate(dt: Date): string {
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}
const EMPTY: Set<string> = new Set();
export function isWorkDay(dt: Date, ww: number, hol: Set<string> = EMPTY): boolean {
  if (hol.size && hol.has(fmtDate(dt))) return false;
  const dow = dt.getDay();
  if (ww >= 7) return true;
  if (ww >= 6) return dow !== 0;
  return dow !== 0 && dow !== 6;
}
// n===0 returns s untouched (even on a non-work day) — web quirk, do NOT "fix".
export function addWorkDays(s: string, n: number, ww: number, hol: Set<string> = EMPTY): string {
  if (n === 0) return s;
  const d = parseDate(s);
  const step = n > 0 ? 1 : -1;
  let rem = Math.abs(n);
  while (rem > 0) {
    d.setDate(d.getDate() + step);
    if (isWorkDay(d, ww, hol)) rem--;
  }
  return fmtDate(d);
}
export function nextWorkDay(s: string, ww: number, hol: Set<string> = EMPTY): string {
  const d = parseDate(s);
  while (!isWorkDay(d, ww, hol)) d.setDate(d.getDate() + 1);
  return fmtDate(d);
}
export function calDays(a: string, b: string): number {
  return Math.round((parseDate(b).getTime() - parseDate(a).getTime()) / 86400000);
}

export function topoSort(tasks: EngineTask[]): EngineTask[] {
  const idMap = new Map<TaskId, EngineTask>(tasks.map((t) => [t.id, t]));
  const inDeg = new Map<TaskId, number>(tasks.map((t) => [t.id, 0]));
  const adj = new Map<TaskId, TaskId[]>(tasks.map((t) => [t.id, []]));
  for (const t of tasks) {
    for (const p of t.predecessors || []) {
      if (!idMap.has(p.taskId)) continue;
      adj.get(p.taskId)!.push(t.id);
      inDeg.set(t.id, inDeg.get(t.id)! + 1);
    }
  }
  const q: TaskId[] = tasks.filter((t) => inDeg.get(t.id) === 0).map((t) => t.id);
  const out: EngineTask[] = [];
  let head = 0;
  while (head < q.length) {
    const id = q[head++];
    out.push(idMap.get(id)!);
    for (const nx of adj.get(id)!) {
      inDeg.set(nx, inDeg.get(nx)! - 1);
      if (inDeg.get(nx) === 0) q.push(nx);
    }
  }
  if (out.length !== tasks.length) throw new Error('CYCLE');
  return out;
}
export function hasCycle(tasks: EngineTask[]): boolean {
  try {
    topoSort(tasks);
    return false;
  } catch {
    return true;
  }
}

export function computeSchedule(tasks: EngineTask[], proj: EngineProject): Schedule {
  const ww = parseInt(String(proj.workWeek)) || 5;
  const hol = new Set<string>(proj.holidays || []);
  const sched: Schedule = new Map();
  const kids = new Map<TaskId, TaskId[]>();
  for (const t of tasks) {
    if (t.parentId) {
      if (!kids.has(t.parentId)) kids.set(t.parentId, []);
      kids.get(t.parentId)!.push(t.id);
    }
  }
  let sorted: EngineTask[];
  try {
    sorted = topoSort(tasks);
  } catch {
    return sched;
  }
  for (const t of sorted) {
    if (t.type === 'group') continue;
    if (t.type === 'milestone' && t.milestoneType === 'fixed' && t.manualDate) {
      const d = nextWorkDay(t.manualDate, ww, hol);
      sched.set(t.id, { s: d, f: d });
      continue;
    }
    let start = proj.startDate;
    for (const p of t.predecessors || []) {
      const pm = sched.get(p.taskId);
      if (!pm) continue;
      const lag = p.lag || 0;
      let cand: string | null = null;
      switch (p.type) {
        case 'SS':
          cand = lag !== 0 ? addWorkDays(pm.s, lag, ww, hol) : pm.s;
          break;
        case 'FF': {
          // QUIRK-Q2: sets sched INSIDE the loop; the last FF in the list wins.
          const ff = lag !== 0 ? addWorkDays(pm.f, lag, ww, hol) : pm.f;
          const dur = Math.max(1, t.duration || 1);
          cand = addWorkDays(ff, -(dur - 1), ww, hol);
          if (cand > start) start = cand;
          start = nextWorkDay(start, ww, hol);
          if (start < proj.startDate) start = nextWorkDay(proj.startDate, ww, hol);
          sched.set(t.id, { s: start, f: ff });
          cand = null;
          break;
        }
        // QUIRK-Q1: SF coded identically to SS (pushes the start, not the finish).
        case 'SF':
          cand = lag !== 0 ? addWorkDays(pm.s, lag, ww, hol) : pm.s;
          break;
        // QUIRK-Q3: FS with offset lag+1 (inclusive finish).
        default:
          cand = addWorkDays(pm.f, lag + 1, ww, hol);
          break;
      }
      if (cand && cand > start) start = cand;
    }
    if (t.manualDate && t.type !== 'milestone') {
      const c = nextWorkDay(t.manualDate, ww, hol);
      if (c > start) start = c;
    }
    if (start < proj.startDate) start = proj.startDate;
    start = nextWorkDay(start, ww, hol);
    if (sched.has(t.id)) continue; // already set by the FF branch (Q2)
    if (t.type === 'milestone') {
      sched.set(t.id, { s: start, f: start });
    } else {
      const dur = Math.max(1, t.duration || 1);
      const fin = addWorkDays(start, dur - 1, ww, hol);
      sched.set(t.id, { s: start, f: fin });
    }
  }
  // Group rollup in reverse-topo: min(child start) → max(child finish).
  for (const t of [...sorted].reverse()) {
    if (t.type !== 'group') continue;
    const cs = (kids.get(t.id) || []).map((id) => sched.get(id)).filter(Boolean) as ScheduleEntry[];
    if (!cs.length) {
      const d = nextWorkDay(proj.startDate, ww, hol);
      sched.set(t.id, { s: d, f: d });
    } else {
      const ss = cs.map((c) => c.s).sort();
      const fs = cs.map((c) => c.f).sort();
      sched.set(t.id, { s: ss[0], f: fs[fs.length - 1] });
    }
  }
  return sched;
}

export function computeRollup(tasks: EngineTask[]): Rollup {
  const rollup: Rollup = new Map();
  const idMap = new Map<TaskId, EngineTask>(tasks.map((t) => [t.id, t]));
  const kids = new Map<TaskId, TaskId[]>();
  for (const t of tasks) {
    if (t.parentId) {
      if (!kids.has(t.parentId)) kids.set(t.parentId, []);
      kids.get(t.parentId)!.push(t.id);
    }
  }
  function pct(id: TaskId): number {
    const t = idMap.get(id);
    if (!t) return 0;
    if (t.type !== 'group') return t.percentComplete || 0;
    if (rollup.has(id)) return rollup.get(id)!;
    let tw = 0;
    let ws = 0;
    for (const kid of kids.get(id) || []) {
      const kt = idMap.get(kid);
      if (!kt || kt.type === 'milestone' || !kt.duration) continue;
      tw += kt.duration;
      ws += kt.duration * pct(kid);
    }
    const v = tw > 0 ? Math.round(ws / tw) : 0;
    rollup.set(id, v);
    return v;
  }
  for (const t of tasks) if (t.type === 'group') pct(t.id);
  return rollup;
}

export function checkViolations(tasks: EngineTask[], sched: Schedule): Set<TaskId> {
  const v = new Set<TaskId>();
  for (const t of tasks) {
    if (t.type !== 'milestone' || t.milestoneType !== 'fixed' || !t.manualDate) continue;
    for (const p of t.predecessors || []) {
      const pm = sched.get(p.taskId);
      if (pm && pm.f > t.manualDate) {
        v.add(t.id);
        break;
      }
    }
  }
  return v;
}

export function computeCritical(tasks: EngineTask[], proj: EngineProject, sched: Schedule): Set<TaskId> {
  const crit = new Set<TaskId>();
  if (!sched.size) return crit;
  const ww = parseInt(String(proj.workWeek)) || 5;
  const hol = new Set<string>(proj.holidays || []);
  let projEnd: string | null = null;
  for (const t of tasks) {
    if (t.type === 'milestone' && t.milestoneType === 'fixed' && t.manualDate) {
      const m = sched.get(t.id);
      if (m && (!projEnd || m.f > projEnd)) projEnd = m.f;
    }
  }
  if (!projEnd)
    for (const [, sc] of sched) {
      if (!projEnd || sc.f > projEnd) projEnd = sc.f;
    }
  if (!projEnd) return crit;
  let sorted: EngineTask[];
  try {
    sorted = topoSort(tasks);
  } catch {
    return crit;
  }
  const succ = new Map<TaskId, { id: TaskId; lag: number }[]>(tasks.map((t) => [t.id, []]));
  for (const t of tasks)
    for (const p of t.predecessors || [])
      if (succ.has(p.taskId)) succ.get(p.taskId)!.push({ id: t.id, lag: p.lag || 0 });
  const lateStart = new Map<TaskId, string>();
  for (const t of [...sorted].reverse()) {
    if (t.type === 'group') continue;
    const sc = sched.get(t.id);
    if (!sc) continue;
    const dur = t.type === 'milestone' ? 0 : Math.max(1, t.duration || 1);
    let lf: string | null = null;
    for (const s of succ.get(t.id) || []) {
      const ls = lateStart.get(s.id);
      if (ls == null) continue;
      const cand = addWorkDays(ls, -s.lag - 1, ww, hol);
      if (lf == null || cand < lf) lf = cand;
    }
    if (lf == null) lf = projEnd;
    const ls = t.type === 'milestone' ? lf : addWorkDays(lf, -(dur - 1), ww, hol);
    lateStart.set(t.id, ls);
    if (ls <= sc.s) crit.add(t.id);
  }
  return crit;
}
