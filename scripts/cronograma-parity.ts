// Parity gate for the ported scheduling engine.
//
//   npx tsx scripts/cronograma-parity.ts
//
// Loads the golden fixtures (copied from C:\ProyectosCC\Gantto\Tests\Fixtures) and asserts that
// src/services/cronogramaEngine.ts reproduces expected.{schedule,rollup,violations,critical,cycle}
// EXACTLY. This is the correctness contract that locks the port to the original web engine.
// The frontend copy (andrei-frontend/src/lib/cronogramaEngine.ts) must stay byte-identical to the
// backend copy, so passing here covers both.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  computeSchedule,
  computeRollup,
  checkViolations,
  computeCritical,
  hasCycle,
  type EngineTask,
  type EngineProject,
} from '../src/services/cronogramaEngine.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, 'cronograma-fixtures');

interface Fixture {
  project: EngineProject;
  tasks: EngineTask[];
  expected: {
    schedule: Record<string, { s: string; f: string }>;
    rollup: Record<string, number>;
    violations: string[];
    critical: string[];
    cycle: boolean;
  };
}

function mapToObj<V>(m: Map<string | number, V>): Record<string, V> {
  const o: Record<string, V> = {};
  for (const [k, v] of m) o[String(k)] = v;
  return o;
}

function diffObjects(label: string, got: Record<string, unknown>, want: Record<string, unknown>): string[] {
  const errs: string[] = [];
  const keys = new Set([...Object.keys(got), ...Object.keys(want)]);
  for (const k of keys) {
    const g = JSON.stringify(got[k]);
    const w = JSON.stringify(want[k]);
    if (g !== w) errs.push(`  ${label}[${k}]: got ${g ?? 'undefined'} — want ${w ?? 'undefined'}`);
  }
  return errs;
}

function diffSet(label: string, got: Set<string | number>, want: string[]): string[] {
  const gotArr = [...got].map(String).sort();
  const wantArr = [...want].map(String).sort();
  if (JSON.stringify(gotArr) !== JSON.stringify(wantArr))
    return [`  ${label}: got [${gotArr.join(',')}] — want [${wantArr.join(',')}]`];
  return [];
}

const files = readdirSync(fixturesDir).filter((f) => f.endsWith('.json')).sort();
let failed = 0;

let ran = 0;
for (const file of files) {
  const fx: Fixture = JSON.parse(readFileSync(join(fixturesDir, file), 'utf8'));
  if (!fx.expected) {
    console.log(`SKIP  ${file} (no expected block — raw sample)`);
    continue;
  }
  ran++;
  const errs: string[] = [];

  const cycle = hasCycle(fx.tasks);
  if (cycle !== fx.expected.cycle) errs.push(`  cycle: got ${cycle} — want ${fx.expected.cycle}`);

  const sched = computeSchedule(fx.tasks, fx.project);
  errs.push(...diffObjects('schedule', mapToObj(sched), fx.expected.schedule));
  errs.push(...diffObjects('rollup', mapToObj(computeRollup(fx.tasks)), fx.expected.rollup));
  errs.push(...diffSet('violations', checkViolations(fx.tasks, sched), fx.expected.violations));
  errs.push(...diffSet('critical', computeCritical(fx.tasks, fx.project, sched), fx.expected.critical));

  if (errs.length) {
    failed++;
    console.log(`FAIL  ${file}`);
    for (const e of errs) console.log(e);
  } else {
    console.log(`PASS  ${file}`);
  }
}

console.log(`\n${ran - failed}/${ran} golden fixtures passed`);
process.exit(failed ? 1 : 0);
