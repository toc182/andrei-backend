/**
 * El Meta de mentira, en su propio proceso.
 *
 * El corredor de pruebas lanza cada prueba con spawnSync y se queda bloqueado
 * hasta que acaba: cualquier servidor que viviera dentro de él dejaría de
 * contestar justo mientras la prueba lo necesita. Por eso este arranca aparte,
 * con el puerto que le pasa el corredor, y muere cuando el corredor lo mata.
 */

import { arrancarMetaFalso } from './metaFalso.js';

const puerto = Number(process.argv[2]);
if (!Number.isInteger(puerto) || puerto <= 0) {
  console.error('uso: metaFalsoProceso.ts <puerto>');
  process.exit(1);
}

await arrancarMetaFalso(puerto);
console.log(`meta-falso escuchando en ${puerto}`);
