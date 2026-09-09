// Red de seguridad del TAPADO: lo que el asistente ve de un proyecto no puede
// llevar datos bancarios del beneficiario.
// cd andrei-backend && npx tsx --env-file=.env scripts/asistente-contexto.spec.ts
//
// Dos redes distintas:
//   A. sobre el codigo — ninguna consulta de contexto.ts nombra una columna
//      prohibida, y ninguna usa "SELECT *".
//   B. sobre el resultado — el contexto ya armado de un proyecto de verdad no
//      contiene esas palabras ni nada que parezca un numero de cuenta.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { query } from '../src/database/config.js';
import {
  cargarContexto, contextoComoTexto, COLUMNAS_PROHIBIDAS,
} from '../src/services/asistentePagos/contexto.js';

let passed = 0; let failed = 0;
function ok(cond: boolean, label: string, extra?: unknown) {
  if (cond) passed++;
  else { failed++; console.log(`FAIL  ${label}`, extra !== undefined ? extra : ''); }
}

const aqui = dirname(fileURLToPath(import.meta.url));
const fuente = readFileSync(join(aqui, '..', 'src', 'services', 'asistentePagos', 'contexto.ts'), 'utf8');

// ---- A. sobre el codigo ----
{
  // Las consultas van en plantillas con acento grave; los comentarios y la
  // lista de columnas prohibidas, no. Asi la prueba mira solo el SQL.
  const sql = (fuente.match(/`[^`]*`/g) ?? []).join('\n').toLowerCase();
  ok(sql.length > 200, 'codigo: se encontraron las consultas para revisar', sql.length);

  for (const col of COLUMNAS_PROHIBIDAS) {
    ok(!sql.includes(col), `codigo: ninguna consulta pide ${col}`);
  }

  ok(!/select\s+\*/i.test(sql), 'codigo: no hay SELECT *');
  ok(!/select\s+[a-z_]+\.\*/i.test(sql), 'codigo: no hay SELECT tabla.*');
  ok(!sql.includes('solicitud_pago_items'), 'codigo: no se piden los renglones del pago');
  ok(!/\bfrom\s+users\b/i.test(sql), 'codigo: no se consulta la tabla de usuarios');
}

// ---- B. sobre el resultado ----
{
  const p = await query<{ id: number; n: string }>(
    `SELECT s.proyecto_id AS id, COUNT(*)::text AS n
       FROM solicitudes_pago s
      WHERE s.activo = TRUE AND s.estado IN ('pagada','facturada')
        AND s.proyecto_id IS NOT NULL
      GROUP BY s.proyecto_id ORDER BY COUNT(*) DESC LIMIT 1`,
  );
  if (!p.rows.length) {
    console.log('FAIL  no hay ningun proyecto con pagos para revisar el resultado');
    failed++;
  } else {
    const proyectoId = p.rows[0].id;
    const ctx = await cargarContexto(proyectoId);
    ok(ctx != null, 'resultado: el contexto se arma');
    if (ctx) {
      console.log(`      revisado con el proyecto ${proyectoId}: ${ctx.pagos.length} pagos, ${ctx.partidas.length} partidas`);
      ok(ctx.pagos.length > 0, 'resultado: trae pagos');

      const texto = contextoComoTexto(ctx).toLowerCase();
      for (const col of COLUMNAS_PROHIBIDAS) {
        ok(!texto.includes(col), `resultado: no aparece la palabra ${col}`);
      }

      // Un numero de cuenta que se colara seria una tira larga de digitos. Los
      // montos llevan punto decimal y las fechas guiones, asi que no chocan.
      // Los identificadores de fila (UUID) si: un tramo suyo puede salir todo
      // en digitos, y son nuestros, no del banco. Fuera antes de mirar.
      const sinUuids = texto.replace(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
        'UUID',
      );
      const tiras = sinUuids.match(/\d{8,}/g) ?? [];
      ok(tiras.length === 0, 'resultado: no hay tiras largas de digitos', tiras.slice(0, 3));

      // Y lo que SI tiene que estar, para que la prueba no pase por vacia.
      ok(texto.includes('rowuid'), 'resultado: van las partidas con su identificador');
      ok(texto.includes('<datos_del_proyecto>'), 'resultado: va envuelto como datos, no como ordenes');
      const unPago = ctx.pagos[0];
      ok(typeof unPago.monto === 'number' && unPago.monto > 0, 'resultado: los pagos llevan su monto');
      ok('categoria' in unPago, 'resultado: los pagos llevan su categoria');
      ok('concepto' in unPago, 'resultado: los pagos llevan su concepto');
      ok(ctx.pagos.every((x) => x.concepto == null || x.concepto.length <= 300),
        'resultado: el concepto va recortado');
    }
  }
}

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
