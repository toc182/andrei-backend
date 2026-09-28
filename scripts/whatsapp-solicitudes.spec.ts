// Red de seguridad: lo que el asistente de WhatsApp lee de las solicitudes de
// pago no puede llevar datos bancarios del beneficiario.
// cd andrei-backend && npx tsx scripts/whatsapp-solicitudes.spec.ts
//
// Mira el CODIGO, sin base: ninguna consulta de services/whatsapp/solicitudes.ts
// nombra una columna prohibida ni usa «SELECT *». Lo que devuelven de verdad
// lo revisa whatsapp-solicitudes-humo.ts.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { COLUMNAS_PROHIBIDAS } from '../src/services/whatsapp/solicitudes.js';

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

console.log(fallos === 0 ? '\nTodo bien' : `\n${fallos} fallo(s)`);
process.exit(fallos === 0 ? 0 : 1);
