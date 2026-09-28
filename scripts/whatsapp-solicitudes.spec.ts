// Red de seguridad: lo que el asistente de WhatsApp lee de las solicitudes de
// pago no puede llevar datos bancarios del beneficiario. Y, sin base: como
// encuentra a un aprobador dicho a su manera, y como parte un mensaje largo.
// cd andrei-backend && npx tsx scripts/whatsapp-solicitudes.spec.ts
//
// Mira el CODIGO, sin base: ninguna consulta de services/whatsapp/solicitudes.ts
// nombra una columna prohibida ni usa «SELECT *». Lo que devuelven de verdad
// lo revisa whatsapp-solicitudes-humo.ts.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { COLUMNAS_PROHIBIDAS, quienEs } from '../src/services/whatsapp/solicitudes.js';
import { enTrozos } from '../src/services/whatsapp/entrantes.js';

let fallos = 0;
const ok = (bien: boolean, que: string): void => {
  console.log(`${bien ? '  ok  ' : 'FALLA '} ${que}`);
  if (!bien) fallos += 1;
};

const aqui = dirname(fileURLToPath(import.meta.url));
const fuente = readFileSync(
  join(aqui, '..', 'src', 'services', 'whatsapp', 'solicitudes.ts'),
  'utf8',
);

// Las consultas van en plantillas con acento grave; los comentarios y la lista
// de columnas prohibidas, no. Asi la prueba mira solo el SQL.
const sql = (fuente.match(/`[^`]*`/g) ?? []).join('\n').toLowerCase();
ok(sql.includes('from solicitudes_pago'), 'se encontraron las consultas para revisar');

for (const col of COLUMNAS_PROHIBIDAS) {
  ok(!new RegExp(`\\b${col}\\b`).test(sql), `ninguna consulta pide ${col}`);
}
ok(!/select\s+\*/i.test(sql), 'no hay SELECT *');
ok(!/select\s+[a-z_]+\.\*/i.test(sql), 'no hay SELECT tabla.*');

// ── los nombres de los aprobadores, dichos a la manera de cada quien ──────
const aprobadores = [
  { id: 1, nombre: 'Lilia Gonzalez' },
  { id: 2, nombre: 'Ivan Plotnikoff' },
  { id: 3, nombre: 'Sergei Plotnikoff' },
];
const quien = (d: string) => quienEs(d, aprobadores).map((a) => a.id).join(',');
ok(quien('Lili') === '1', '«Lili» es Lilia');
ok(quien('Sergey') === '3', '«Sergey» es Sergei (una letra de diferencia)');
ok(quien('iván') === '2', '«iván», con tilde y en minúscula, es Ivan');
ok(quien('Plotnikoff') === '2,3', '«Plotnikoff» son dos: el modelo tiene que preguntar cuál');
ok(quien('Pedro') === '', 'alguien que no está no es nadie');

// ── un mensaje largo se parte ─────────────────────────────────────────────
const lista = Array.from({ length: 120 }, (_, i) => `STAISA-${i} — Proveedor número ${i} — B/. 1,000.00`).join('\n');
const trozos = enTrozos(lista);
ok(
  lista.length > 4096 && trozos.length > 1 && trozos.every((t) => t.length <= 3900),
  'una lista larga sale en varios mensajes que caben en WhatsApp',
);
ok(trozos.join('\n') === lista, 'y no se pierde ni se corta ninguna línea');
ok(enTrozos('corto').length === 1, 'un mensaje corto sale entero');

console.log(fallos === 0 ? '\nTodo bien' : `\n${fallos} fallo(s)`);
process.exit(fallos === 0 ? 0 : 1);
