/**
 * Corre las pruebas de humo, cada una contra su propia base desechable.
 *
 *   npm run pruebas                -> todas
 *   npm run pruebas -- filas       -> solo esa
 *   npm run pruebas -- filas listas
 *
 * Cada prueba recibe una copia recién hecha de la base modelo y un servidor
 * propio en un puerto libre; al terminar, las dos cosas desaparecen. La copia
 * local de Ivan (andrei_db) y el servidor del 5000 no se tocan: las pruebas ni
 * siquiera saben llegar a ellos —la guardia de scripts/pruebas/contexto.ts las
 * para si alguien lo intenta.
 */

// El corredor no pasa por src/database/config.ts (que es quien suele cargar el
// .env): necesita leerlo él para saber a qué PostgreSQL pedirle la base nueva.
import 'dotenv/config';
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  barrer, crearEntorno, crearPlantilla, limpiarAlmacen, tirarBase, type Entorno,
} from './pruebas/entorno.js';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Las pruebas que ya viven en la base desechable. Las que faltan siguen
 * corriendo a mano contra la copia local hasta que se muden aquí.
 */
const PRUEBAS: Record<string, string> = {
  filas: 'filas-humo.ts',
  listas: 'listas-humo.ts',
  aprobadores: 'aprobadores-transaccion-humo.ts',
  'reporte-baja': 'reporte-baja-humo.ts',
  'reporte-borrador': 'reporte-borrador-humo.ts',
  'reporte-cola': 'reporte-cola-humo.ts',
  'reporte-consorcio': 'reporte-consorcio-humo.ts',
  'reporte-continuar': 'reporte-continuar-humo.ts',
  'reporte-correcciones': 'reporte-correcciones-humo.ts',
  'reporte-fotos': 'reporte-fotos-humo.ts',
  'reporte-guardado-doble': 'reporte-guardado-doble-humo.ts',
  'reporte-leyendas': 'reporte-leyendas-humo.ts',
  'reporte-semanal': 'reporte-semanal-humo.ts',
  'reporte-semanal-pdf': 'reporte-semanal-pdf-humo.ts',
  'reporte-semanal-correcciones': 'reporte-semanal-correcciones-humo.ts',
  'semana-cerrada': 'semana-cerrada-humo.ts',
  'whatsapp-entrada': 'whatsapp-entrada-humo.ts',
  'whatsapp-asistente': 'whatsapp-asistente-humo.ts',
  'whatsapp-borrador': 'whatsapp-borrador-humo.ts',
};

async function main(): Promise<void> {
  const pedidas = process.argv.slice(2);
  const desconocidas = pedidas.filter((p) => !PRUEBAS[p]);
  if (desconocidas.length) {
    console.error(`no conozco: ${desconocidas.join(', ')}\nhay: ${Object.keys(PRUEBAS).join(', ')}`);
    process.exit(1);
  }
  const lista = pedidas.length ? pedidas : Object.keys(PRUEBAS);

  const suelto = await barrer();
  if (suelto.bases.length || suelto.servidores.length) {
    console.log(
      `(de corridas anteriores se tiraron ${suelto.bases.length} base(s) y ` +
        `${suelto.servidores.length} servidor(es) huérfano(s))\n`,
    );
  }

  const plantilla = await crearPlantilla();
  const resultados: { nombre: string; codigo: number }[] = [];
  // Ctrl-C a media prueba tiene que llevarse la base y el servidor igual que
  // un final normal.
  let enCurso: Entorno | null = null;
  const alCortar = () => {
    void (async () => {
      await enCurso?.cerrar().catch(() => undefined);
      await tirarBase(plantilla).catch(() => undefined);
      process.exit(130);
    })();
  };
  process.on('SIGINT', alCortar);
  process.on('SIGTERM', alCortar);
  try {
    for (const nombre of lista) {
      const entorno = await crearEntorno(plantilla);
      enCurso = entorno;
      console.log(`\n───── ${nombre} ─────`);
      try {
        const r = spawnSync(
          process.execPath,
          ['--import', 'tsx', path.join('scripts', PRUEBAS[nombre])],
          { cwd: RAIZ, env: entorno.env, stdio: 'inherit' },
        );
        const codigo = r.status ?? 1;
        resultados.push({ nombre, codigo });
        if (codigo !== 0) {
          const registro = entorno.registro();
          if (registro.trim()) console.log(`\n--- lo que dijo el servidor de pruebas ---\n${registro}`);
        }
      } finally {
        // Pase lo que pase con la prueba —falle, reviente o la maten—, su base
        // y su servidor se van. Eso es lo que sustituye a la limpieza que cada
        // prueba llevaba escrita a mano.
        await entorno.cerrar();
      }
    }
  } finally {
    await tirarBase(plantilla);
    // Las fotos y los PDF viven en R2, fuera de la base: se van aparte.
    const archivos = await limpiarAlmacen();
    if (archivos) console.log(`\n(se borraron ${archivos} archivo(s) de prueba de R2)`);
  }

  const fallaron = resultados.filter((r) => r.codigo !== 0);
  console.log(`\n═════ ${resultados.length - fallaron.length} de ${resultados.length} pruebas pasaron`);
  for (const f of fallaron) console.log(`   FALLÓ  ${f.nombre}`);
  process.exit(fallaron.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
