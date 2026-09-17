/**
 * La semana cerrada: qué se puede seguir tocando de los reportes diarios y qué
 * no.
 *
 * Decisión de Ivan (2026-09-17): cuando el reporte SEMANAL de una semana se
 * envía, esa semana queda cerrada. Ninguno de sus reportes diarios se corrige
 * ni se elimina, y no se puede crear uno nuevo con fecha de esos siete días.
 * Lo que aparezca después se anota en un reporte diario posterior.
 *
 * El motivo: el semanal se guarda como se envió —los números que salieron por
 * correo son los que quedan—, así que dejar los diarios abiertos solo
 * conseguiría que el papel y la pantalla dijeran cosas distintas del mismo día.
 *
 * Cierra el reporte semanal COMPLETO, no el borrador: un borrador a medias no
 * puede bloquearle el día a nadie.
 */

import { query } from '../database/config.js';
import { lunesDe } from './reporteSemana.js';

export interface SemanaCerrada {
  numero: string;
  semana_iso: number;
  anio_iso: number;
}

/** Una fecha como `YYYY-MM-DD`, venga como texto o como el Date que da `pg`. */
export function comoYMD(fecha: string | Date): string {
  if (fecha instanceof Date) {
    // La fecha de un reporte es un DATE: `pg` lo entrega como medianoche local,
    // así que se leen los componentes locales y no los UTC, que en Panamá
    // devolverían el día anterior.
    const y = fecha.getFullYear();
    const m = String(fecha.getMonth() + 1).padStart(2, '0');
    const d = String(fecha.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(fecha).slice(0, 10);
}

/**
 * El reporte semanal que cierra la semana de esa fecha, o null si esa semana
 * sigue abierta.
 */
export async function semanaCerrada(
  proyectoId: number,
  fecha: string | Date,
): Promise<SemanaCerrada | null> {
  const lunes = lunesDe(comoYMD(fecha));
  const r = await query<SemanaCerrada>(
    `SELECT numero, semana_iso, anio_iso
       FROM proyecto_reportes_semanales
      WHERE proyecto_id = $1 AND semana_inicio = $2
        AND activo = true AND completo = true`,
    [proyectoId, lunes],
  );
  return r.rows[0] ?? null;
}

/**
 * El mensaje que ve el ingeniero. Nombra la semana y el reporte que la cerró, y
 * dice qué hacer en su lugar; «no se puede» a secas deja a alguien en la obra
 * sin saber dónde anotar lo que tiene delante.
 */
export function mensajeSemanaCerrada(c: SemanaCerrada, accion: string): string {
  return (
    `La semana ${c.semana_iso} de ${c.anio_iso} ya tiene su reporte semanal ` +
    `(${c.numero}), así que ${accion}. Anota lo que haga falta en el reporte diario de hoy.`
  );
}
