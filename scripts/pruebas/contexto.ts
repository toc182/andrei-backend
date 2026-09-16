/**
 * Lo que toda prueba de humo importa antes de nada.
 *
 * Dos cosas, y las dos son de seguridad:
 *
 * 1. La guardia. Si la base a la que se apunta no es una base de pruebas, el
 *    proceso se muere aquí mismo, antes de la primera consulta. Correr una
 *    prueba a mano contra la copia local le metía a Ivan reportes y empresas de
 *    mentira entre sus datos; ahora no se puede, la prueba se niega.
 * 2. La dirección del servidor de pruebas, que la pone el corredor
 *    (scripts/pruebas.ts). No hay «http://localhost:5000» escrito en ninguna
 *    prueba: ese es el servidor de verdad.
 *
 * Importar este módulo tiene efecto: comprueba y, si no cuadra, sale. Va el
 * PRIMERO de los imports de cada prueba, antes que la base de datos.
 */

import { PREFIJO_BASE } from './entorno.js';

const base = process.env.DB_NAME ?? '';
const api = process.env.PRUEBAS_API ?? '';

if (!base.startsWith(PREFIJO_BASE) || !api) {
  console.error(
    'Esta prueba solo corre contra la base desechable de pruebas.\n' +
      `  base: ${base || '(ninguna)'} — tiene que empezar por «${PREFIJO_BASE}»\n` +
      `  servidor: ${api || '(ninguno)'}\n` +
      'Córrelas con: npm run pruebas   (o npm run pruebas -- filas listas)',
  );
  process.exit(1);
}

/** Raíz de la API del servidor de pruebas de esta corrida. */
export const API = api;

/** La base desechable de esta corrida. */
export const BASE_PRUEBAS = base;
