// Red de seguridad de la promesa que hace la migracion 161: mover la estrella
// deja el control de costos en cero, pero NO borra la clasificacion.
// cd andrei-backend && npx tsx --env-file=.env scripts/partidas-estrella.spec.ts
//
// Es una prueba contra la base de desarrollo, como asistente-contexto.spec.ts:
// lo que se comprueba es el comportamiento de unas consultas, y eso no se puede
// fingir con datos en memoria.
//
// La mutacion es minima y se deshace en el finally: se le quita la estrella al
// presupuesto oficial y se le vuelve a poner. No crea ni borra nada.
import { query } from '../src/database/config.js';
import { partidasDelProyecto, leerPartidasDePago } from '../src/services/partidasProyecto.js';

let passed = 0; let failed = 0;
function ok(cond: boolean, label: string, extra?: unknown) {
  if (cond) passed++;
  else { failed++; console.log(`FAIL  ${label}`, extra !== undefined ? extra : ''); }
}

/** Un proyecto de la base que sirva para esto: con presupuesto oficial y con
 *  gasto ya clasificado contra el. Sin uno asi no hay nada que comprobar. */
const candidato = await query<{ proyecto_id: number; presupuesto_id: number; solicitud_pago_id: number }>(
  `SELECT p.proyecto_id, p.id AS presupuesto_id, MIN(sp.solicitud_pago_id) AS solicitud_pago_id
     FROM presupuestos p
     JOIN solicitud_pago_partidas sp ON sp.presupuesto_id = p.id
    WHERE p.activo AND p.es_principal
    GROUP BY p.proyecto_id, p.id
    ORDER BY COUNT(*) DESC
    LIMIT 1`,
);

if (!candidato.rows.length) {
  console.log('SALTADA: no hay ningun proyecto con presupuesto oficial y gasto clasificado.');
  process.exit(0);
}

const { proyecto_id: proyectoId, presupuesto_id: presupuestoId, solicitud_pago_id: pagoId } = candidato.rows[0];
const filas = async () => (await query<{ n: string }>(
  'SELECT COUNT(*)::text AS n FROM solicitud_pago_partidas WHERE presupuesto_id = $1',
  [presupuestoId],
)).rows[0].n;

const antes = await filas();

try {
  // ---- con la estrella puesta, todo resuelve ----
  const conEstrella = await partidasDelProyecto(proyectoId);
  ok(conEstrella?.presupuestoId === presupuestoId,
    'las partidas salen del presupuesto oficial', conEstrella?.presupuestoId);
  ok((conEstrella?.partidas.length ?? 0) > 0, 'el presupuesto oficial ofrece partidas');

  const repartoAntes = await leerPartidasDePago(pagoId);
  ok(repartoAntes.length > 0, 'el pago de prueba tiene reparto');
  ok(repartoAntes.some((r) => r.item != null),
    'con la estrella puesta, el reparto trae el nombre de su partida');

  // ---- se le quita la estrella: es lo mismo que movérsela a otro ----
  await query('UPDATE presupuestos SET es_principal = FALSE WHERE id = $1', [presupuestoId]);

  ok(await partidasDelProyecto(proyectoId) === null,
    'sin presupuesto oficial no hay partidas que ofrecer');

  const repartoSuelto = await leerPartidasDePago(pagoId);
  ok(repartoSuelto.length === repartoAntes.length,
    'las lineas del reparto SIGUEN AHI: mover la estrella no borra', repartoSuelto.length);
  ok(repartoSuelto.every((r) => r.item == null && r.descripcion == null),
    'pero ninguna resuelve su nombre, asi que la pantalla las trata como pendientes');
  ok(await filas() === antes, 'no se borro ni una fila de la tabla', await filas());
} finally {
  await query('UPDATE presupuestos SET es_principal = TRUE WHERE id = $1', [presupuestoId]);
}

// ---- y al devolverla, vuelve tal cual ----
const repartoDespues = await leerPartidasDePago(pagoId);
ok(repartoDespues.some((r) => r.item != null),
  'devuelta la estrella, el reparto vuelve a resolver');
ok(await filas() === antes, 'la tabla quedo como estaba', await filas());

console.log(`\nproyecto ${proyectoId}, presupuesto ${presupuestoId}, ${antes} lineas de reparto`);
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
