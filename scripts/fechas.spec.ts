// Red de seguridad de cómo el servidor escribe una fecha en un papel, un correo o
// un WhatsApp: «07/oct/2026», «07/oct/2026 3:05 p. m.» (Ivan, 2026-10-08).
// cd andrei-backend && npx tsx scripts/fechas.spec.ts
// Correrla también con TZ=UTC (como Railway) y TZ=America/Panama (como la copia local).
import { fecha, fechaDeMomento, fechaHora, hora } from '../src/utils/fechas.js';

let passed = 0; let failed = 0;
function eq(got: string, want: string, label: string) {
  if (got === want) passed++; else { failed++; console.log(`FAIL  ${label}: got «${got}», want «${want}»`); }
}
function ok(cond: boolean, label: string) {
  if (cond) passed++; else { failed++; console.log(`FAIL  ${label}`); }
}

// ---- un día del calendario (columna DATE) ----
eq(fecha('2026-10-07'), '07/oct/2026', 'texto YYYY-MM-DD');
eq(fecha('2026-10-07T00:00:00.000Z'), '07/oct/2026', 'DATE serializado por un servidor en UTC');
eq(fecha('2026-10-07T05:00:00.000Z'), '07/oct/2026', 'DATE serializado por un servidor en Panamá');
// pg arma un DATE como un Date a la medianoche LOCAL del servidor, sea cual sea su zona.
eq(fecha(new Date(2026, 9, 7)), '07/oct/2026', 'Date de pg (medianoche local)');
eq(fecha('2026-09-01'), '01/sep/2026', 'septiembre es «sep», no «sept»');
eq(fecha('2026-12-31'), '31/dic/2026', 'último día del año');
eq(fecha('2027-01-01'), '01/ene/2027', 'primer día del año');
const meses = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
meses.forEach((m, i) =>
  eq(fecha(`2026-${String(i + 1).padStart(2, '0')}-15`), `15/${m}/2026`, `mes ${i + 1}`),
);

// ---- nada que mostrar ----
eq(fecha(null), '—', 'null');
eq(fecha(undefined), '—', 'undefined');
eq(fecha(''), '—', 'texto vacío');
eq(fecha('no es fecha'), '—', 'basura');
eq(fecha(new Date('x')), '—', 'Date inválido');
eq(fecha(null, ''), '', 'cada papel escoge su vacío');
eq(fechaHora(null), '—', 'momento null');

// ---- un momento (created_at, aprobada_at…), siempre en la hora de Panamá ----
// 9:05 p. m. del 7 en Panamá ya es 02:05 del 8 en UTC.
eq(fechaDeMomento('2026-10-08T02:05:00.000Z'), '07/oct/2026', 'momento de noche: su día en Panamá');
eq(fechaDeMomento(new Date(Date.UTC(2026, 9, 8, 2, 5))), '07/oct/2026', 'momento de noche como Date (timestamptz de pg)');
eq(fechaHora('2026-10-08T02:05:00.000Z'), '07/oct/2026 9:05 p. m.', 'momento de noche con hora');
eq(fechaHora('2026-10-07T20:05:00.000Z'), '07/oct/2026 3:05 p. m.', 'tarde');
eq(fechaHora('2026-10-07T13:30:00.000Z'), '07/oct/2026 8:30 a. m.', 'mañana');
eq(fechaHora('2026-10-07T05:00:00.000Z'), '07/oct/2026 12:00 a. m.', 'medianoche es 12 a. m.');
eq(fechaHora('2026-10-07T17:00:00.000Z'), '07/oct/2026 12:00 p. m.', 'mediodía es 12 p. m.');
eq(hora('2026-10-07T20:05:00.000Z'), '3:05 p. m.', 'la hora sola');
ok(!/[  ]/.test(fechaHora('2026-10-07T20:05:00.000Z')), 'sin espacios escondidos (se copia limpio a Excel)');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
