/**
 * «Trabajo ejecutado» por areas: los puntos de un reporte diario.
 *
 * Decision de Ivan del 2026-09-25: se escoge el area y se escribe que se hizo
 * en ella. Varios puntos de la misma area salen juntos debajo de su nombre, y
 * lo que no es de ningun area va en «General» (area_id null).
 *
 * Los reportes de antes traen un solo texto (que_se_hizo) y se quedan asi. Un
 * reporte tiene puntos o tiene ese texto, nunca las dos cosas.
 *
 * Modulo puro, sin base de datos: lo usan la ruta, el PDF, el reporte semanal
 * y las pruebas, y todos tienen que agrupar igual.
 */

import type { FilaComparable } from './reporteCambios.js';

/** Como se llama lo que no es de ningun area. */
export const GENERAL = 'General';

/** Un punto como llega de la pantalla o del asistente. */
export interface TrabajoPedido {
  area_id: number | null;
  texto: string;
}

/** Un punto ya guardado, con el nombre de su area. */
export interface TrabajoGuardado {
  area_id: number | null;
  area_nombre: string | null;
  texto: string;
}

/** Los puntos de una misma area, en el orden en que se escribieron. */
export interface GrupoDeTrabajo {
  area_id: number | null;
  nombre: string;
  puntos: string[];
}

/**
 * Lee la lista que mando quien llama. Devuelve el motivo si no sirve.
 *
 * Los puntos en blanco se descartan: un renglon vacio no dice nada y la
 * pantalla ya no deja guardarlo. Hace falta al menos uno.
 */
export function leerTrabajosPedidos(
  v: unknown,
): { ok: true; trabajos: TrabajoPedido[] } | { ok: false; motivo: string } {
  if (!Array.isArray(v)) return { ok: false, motivo: 'El trabajo ejecutado no es una lista' };
  const trabajos: TrabajoPedido[] = [];
  for (const t of v) {
    if (t === null || typeof t !== 'object') {
      return { ok: false, motivo: 'Un punto del trabajo ejecutado no es válido' };
    }
    const { area_id: area, texto } = t as { area_id?: unknown; texto?: unknown };
    if (texto !== undefined && texto !== null && typeof texto !== 'string') {
      return { ok: false, motivo: 'Un punto del trabajo ejecutado no es un texto' };
    }
    const limpio = (texto ?? '').trim();
    if (!limpio) continue;
    const id = area === null || area === undefined ? null : Number(area);
    if (id !== null && !Number.isInteger(id)) {
      return { ok: false, motivo: 'Un punto del trabajo ejecutado tiene un área inválida' };
    }
    trabajos.push({ area_id: id, texto: limpio });
  }
  if (trabajos.length === 0) return { ok: false, motivo: 'Debes anotar al menos un trabajo ejecutado' };
  return { ok: true, trabajos };
}

/**
 * Los puntos juntados por area, cada area donde aparecio por primera vez.
 *
 * El orden es el de quien escribio: si empezo por la torre, la torre va
 * primero. «General» sigue la misma regla que las demas.
 */
export function agruparTrabajos(trabajos: TrabajoGuardado[]): GrupoDeTrabajo[] {
  const grupos: GrupoDeTrabajo[] = [];
  const porArea = new Map<string, GrupoDeTrabajo>();
  for (const t of trabajos) {
    const clave = t.area_id === null ? 'general' : String(t.area_id);
    let g = porArea.get(clave);
    if (!g) {
      g = { area_id: t.area_id, nombre: t.area_id === null ? GENERAL : t.area_nombre ?? '', puntos: [] };
      porArea.set(clave, g);
      grupos.push(g);
    }
    g.puntos.push(t.texto);
  }
  return grupos;
}

/**
 * El trabajo del dia como un solo texto, para quien lee texto corrido: el
 * reporte semanal se lo pasa asi a la IA, y la lista de reportes lo muestra
 * recortado.
 *
 * «Losa nivel 2: Vaciado de losa. · Encofrado del tramo F-H.», un renglon por area.
 */
export function trabajosComoTexto(trabajos: TrabajoGuardado[]): string {
  return agruparTrabajos(trabajos)
    .map((g) => `${g.nombre}: ${g.puntos.join(' · ')}`)
    .join('\n');
}

/**
 * Los puntos en la forma que compara diffFilas para Correcciones: una fila por
 * area, con sus puntos uno por renglon.
 *
 * Por area y no por punto: los puntos no tienen nombre propio, y comparar el
 * texto del area renglon por renglon deja en el rastro exactamente lo que se
 * agrego, se quito o se reescribio, bajo «Trabajo ejecutado · Losa nivel 2».
 */
export function trabajosParaComparar(trabajos: TrabajoGuardado[]): FilaComparable[] {
  return agruparTrabajos(trabajos).map((g) => ({
    clave: `trabajo:${g.area_id === null ? 'general' : g.area_id}`,
    label: `Trabajo ejecutado · ${g.nombre}`,
    valor: g.puntos.join('\n'),
  }));
}
