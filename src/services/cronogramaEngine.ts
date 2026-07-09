// Cronograma scheduling engine — port of Gantto/ganttoweb/engine.js.
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
// DEVIATION-D1 (2026-07-07, deliberate — the ONE divergence from gantto): computeCritical's
// backward pass inverts each dependency BY ITS TYPE. Gantto dropped the type and inverted every
// link as FS, which dragged whole SS/FF/SF chains into the critical set (branches with weeks of
// float rendered critical). computeSchedule (all dates) remains a verbatim port; fixture
// `critical` expectations were re-derived and hand-verified under D1.
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
  // DEVIATION-D1: projEnd is simply the schedule's real end (max finish over everything).
  // gantto instead used the LATEST FIXED MILESTONE when one existed — with an interim fixed
  // milestone (e.g. "Inicio de obra") as the only one, that made a mid-project date the
  // "deadline" and painted the entire tail critical. Fixed milestones still exert deadline
  // pressure, but per-milestone via the pinned-date cap below (scoped to their feeding chain).
  let projEnd: string | null = null;
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
  // DEVIATION-D1: invert each successor link by its TYPE, mirroring the forward pass.
  //   FS (Q3: forward adds lag+1)      -> bounds this task's late FINISH from succ late start
  //   SS / SF (Q1: SF forwards as SS)  -> bounds this task's late START  from succ late start
  //   FF                               -> bounds this task's late FINISH from succ late finish
  // (Multi-FF "last wins" (Q2) is honored forward only; backward all FF links bound
  // conservatively — the critical flag is a highlight, never a scheduling input.)
  const succ = new Map<TaskId, { id: TaskId; type: DepType; lag: number }[]>(tasks.map((t) => [t.id, []]));
  for (const t of tasks)
    for (const p of t.predecessors || [])
      if (succ.has(p.taskId)) succ.get(p.taskId)!.push({ id: t.id, type: p.type, lag: p.lag || 0 });
  const lateStart = new Map<TaskId, string>();
  const lateFinish = new Map<TaskId, string>();
  for (const t of [...sorted].reverse()) {
    if (t.type === 'group') continue;
    const sc = sched.get(t.id);
    if (!sc) continue;
    const dur = t.type === 'milestone' ? 0 : Math.max(1, t.duration || 1);
    // EVERY task's late finish is seeded by the project end (P6-style), then tightened by
    // successor bounds. Without the seed, a task whose only successors are SS/SF has an
    // unbounded finish and the end-defining task of the schedule would never show critical.
    let lf: string = projEnd;
    let lsb: string | null = null; // tightest bound on this task's late start (SS/SF links)
    for (const s of succ.get(t.id) || []) {
      if (s.type === 'SS' || s.type === 'SF') {
        const sls = lateStart.get(s.id);
        if (sls == null) continue;
        const cand = s.lag !== 0 ? addWorkDays(sls, -s.lag, ww, hol) : sls;
        if (lsb == null || cand < lsb) lsb = cand;
      } else if (s.type === 'FF') {
        const slf = lateFinish.get(s.id);
        if (slf == null) continue;
        const cand = s.lag !== 0 ? addWorkDays(slf, -s.lag, ww, hol) : slf;
        if (cand < lf) lf = cand;
      } else {
        const sls = lateStart.get(s.id);
        if (sls == null) continue;
        const cand = addWorkDays(sls, -s.lag - 1, ww, hol);
        if (cand < lf) lf = cand;
      }
    }
    const lsFromLf = t.type === 'milestone' ? lf : addWorkDays(lf, -(dur - 1), ww, hol);
    let ls = lsb == null || lsFromLf < lsb ? lsFromLf : lsb;
    // A FIXED milestone is pinned (Must-Finish-On): its late date is capped by its own pinned
    // date, so a chain running late against it inherits negative float and shows critical.
    // (A chain finishing exactly ON the pin is critical without a violation triangle — Q3's
    // lag+1 means the milestone would already need to land the next work day.)
    const isPinned = t.type === 'milestone' && t.milestoneType === 'fixed' && !!t.manualDate;
    if (isPinned && sc.s < ls) ls = sc.s;
    // The folded lateFinish (= min(lf, lsb + dur - 1)) is exact even for Q2-compressed tasks:
    // it carries both FF channels back to the FF predecessor (finish pin f = pred.f + lag, and
    // the start push ff - (dur - 1)).
    const lfOut = t.type === 'milestone' ? ls : addWorkDays(ls, dur - 1, ww, hol);
    lateFinish.set(t.id, lfOut);
    if (!isPinned && (t.predecessors || []).some((p) => p.type === 'FF')) {
      // Q2-compressed (FF-fed) task: the forward pass pins its FINISH to the FF predecessor and
      // decouples it from the start (the bar can even compress, f < s). The rigid-bar ls is NOT
      // a valid start bound here — deriving one falsely marks FS/SS/SF predecessors critical.
      // Only a real successor start-need (lsb) constrains the start; criticality is judged by
      // the finish (or that genuine start-need).
      if (lsb != null) lateStart.set(t.id, lsb);
      if (lfOut <= sc.f || (lsb != null && lsb <= sc.s)) crit.add(t.id);
    } else {
      lateStart.set(t.id, ls);
      if (ls <= sc.s) crit.add(t.id);
    }
  }
  return crit;
}
