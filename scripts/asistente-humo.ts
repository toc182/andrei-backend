// Prueba de humo del asistente CON el modelo de verdad. Gasta unos centavos.
// cd andrei-backend && npx tsx --env-file=.env scripts/asistente-humo.ts [proyectoId]
//
// No aplica NADA: imprime lo que propondria. Se corre cuando cambian las
// instrucciones o las herramientas, no en cada cambio de codigo — para eso
// estan las otras pruebas, que no gastan.

import { cargarContexto } from '../src/services/asistentePagos/contexto.js';
import { conversar } from '../src/services/asistentePagos/asistente.js';
import { estaConfigurado } from '../src/services/asistentePagos/cliente.js';

const FRASES = [
  'los pagos de Cemento Panamá repártelos entre el cajón pluvial y las cunetas, mitad y mitad',
  'todo lo de combustible ponlo en conformación de calzada',
  '¿qué pagos me quedan sin partida?',
  'quítale la partida a los pagos de planilla',
  'arregla los pagos',
  'el pago de transportes repártelo entre todas las partidas del proyecto',
];

const main = async () => {
  if (!estaConfigurado()) {
    console.log('No hay ANTHROPIC_API_KEY en el entorno.');
    process.exit(1);
  }
  const proyectoId = parseInt(process.argv[2] ?? '21', 10);
  const ctx = await cargarContexto(proyectoId);
  if (!ctx) { console.log(`No existe el proyecto ${proyectoId}`); process.exit(1); }
  console.log(`Proyecto ${proyectoId} — ${ctx.pagos.length} pagos, ${ctx.partidas.length} partidas`);
  console.log(`Modelo: ${process.env.ANTHROPIC_MODELO ?? 'claude-opus-5'}\n`);

  const total = { entrada: 0, salida: 0, cache: 0 };

  for (const frase of FRASES) {
    const t0 = Date.now();
    const r = await conversar({ ctx, mensajes: [{ rol: 'usuario', texto: frase }] });
    const segundos = ((Date.now() - t0) / 1000).toFixed(1);

    total.entrada += r.uso.entrada;
    total.salida += r.uso.salida;
    total.cache += r.uso.cache;

    console.log('='.repeat(78));
    console.log(`TU: ${frase}`);
    console.log(`\nEL: ${r.mensaje}`);
    if (r.aviso) console.log(`\n(aviso: ${r.aviso})`);

    if (r.propuesta) {
      console.log(`\nPROPONE ${r.propuesta.cambios.length} cambio(s):`);
      for (const c of r.propuesta.cambios.slice(0, 6)) {
        const antes = c.antes.length === 0 ? 'sin partida' : c.antes.map((l) => `${l.item ?? '?'}`).join(' + ');
        const despues = c.despues.length === 0
          ? 'sin partida'
          : c.despues.map((l) => `${l.item ?? '?'} ${l.monto}`).join(' + ');
        console.log(`  ${c.numero ?? c.solicitudId} (${c.monto}) [${c.regla}]  ${antes}  ->  ${despues}`);
        const suma = Math.round(c.despues.reduce((s, l) => s + l.monto, 0) * 100);
        const esperado = Math.round(c.monto * 100);
        if (c.despues.length > 0 && suma !== esperado) {
          console.log(`  *** NO CUADRA: ${suma} vs ${esperado} ***`);
        }
      }
      if (r.propuesta.cambios.length > 6) console.log(`  (y ${r.propuesta.cambios.length - 6} mas)`);
    } else {
      console.log('\nNo propone cambios.');
    }
    console.log(`\n[${segundos}s · entrada ${r.uso.entrada} · salida ${r.uso.salida} · cache ${r.uso.cache}]\n`);
  }

  // Precio de lista de Claude Opus 5: 5 dolares por millon de tokens de
  // entrada, 25 por millon de salida. Los de cache entran mucho mas baratos,
  // asi que esto es un techo, no el cobro exacto.
  const techo = (total.entrada / 1e6) * 5 + (total.salida / 1e6) * 25;
  console.log('='.repeat(78));
  console.log(`Total: entrada ${total.entrada}, salida ${total.salida}, cache ${total.cache}`);
  console.log(`Costo aproximado de esta corrida: $${techo.toFixed(3)} (${FRASES.length} preguntas)`);
  console.log(`Por pregunta: $${(techo / FRASES.length).toFixed(3)}`);
};

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
