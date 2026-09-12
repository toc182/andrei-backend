/**
 * La cola de envío del reporte diario.
 *
 * El correo dejó de depender del navegador del ingeniero. Al terminar el
 * reporte se encola, y el cron lo manda por su cuenta reintentando con esperas
 * cada vez más largas. Si se acaban los intentos, se avisa al admin.
 *
 * Aquí vive lo que se puede comprobar sin servidor ni base: el cálculo de
 * cuándo toca el siguiente intento. El resto son las cuatro consultas que
 * mueven una fila por la cola. Quien arma y manda el PDF es
 * `procesarEnviosPendientes` en routes/proyectoReportes.ts, donde ya viven el
 * generador y el archivado; ponerlo aquí obligaría a que un servicio importara
 * de una ruta y la ruta del servicio, que es un círculo.
 */

import { query } from '../database/config.js';

/**
 * Las esperas, en minutos, antes de cada reintento.
 *
 * Empiezan cortas porque el fallo más común es pasajero —un corte de red, R2
 * que tarda— y siguen alargándose porque si a las tres horas sigue cayendo, no
 * es pasajero y lo que hace falta es que alguien lo mire, no insistir.
 */
export const ESPERAS_MINUTOS = [1, 5, 15, 60, 180];

/** Cuántos intentos antes de rendirse y avisar. */
export const MAX_INTENTOS = ESPERAS_MINUTOS.length;

/**
 * Cuándo toca el siguiente intento, contando desde `desde`.
 *
 * `intentos` es cuántos se llevan FALLADOS. Devuelve null cuando ya no quedan:
 * esa fila sale de la cola y pasa a ser un aviso al admin.
 *
 * Función pura a propósito, para que scripts/reporte-envio.spec.ts pueda
 * comprobarla sin levantar nada.
 */
export function calcularProximoIntento(
  intentos: number,
  desde: Date = new Date(),
): Date | null {
  if (!Number.isInteger(intentos) || intentos < 0) {
    throw new Error(`Número de intentos inválido: ${String(intentos)}`);
  }
  if (intentos >= MAX_INTENTOS) return null;
  return new Date(desde.getTime() + ESPERAS_MINUTOS[intentos] * 60_000);
}

/**
 * Pone el reporte en la cola, desde cero.
 *
 * Se llama al emitir y también cuando alguien le da a «Enviar» a mano: en los
 * dos casos la cuenta de intentos vuelve a empezar, porque quien le da al botón
 * espera que se intente de verdad, no que herede los fallos de ayer.
 */
export async function encolarEnvio(reporteId: number): Promise<void> {
  await query(
    `UPDATE proyecto_reportes
        SET envio_proximo_intento = CURRENT_TIMESTAMP,
            envio_intentos = 0,
            envio_ultimo_error = NULL,
            envio_avisado = FALSE
      WHERE id = $1`,
    [reporteId],
  );
}

export interface ReporteEnCola {
  id: number;
  proyecto_id: number;
  envio_intentos: number;
}

/**
 * Saca de la cola lo que ya le tocaba, y lo reserva en el mismo movimiento.
 *
 * Reservar es lo que impide mandar dos veces el mismo correo: la fila se
 * empuja diez minutos hacia adelante al cogerla, así que otra pasada del cron
 * —o un segundo servidor— no la vuelve a ver. Si el proceso se muere a medio
 * envío, esos diez minutos son lo que tarda en volver a intentarse.
 *
 * `SKIP LOCKED` para que dos pasadas a la vez se repartan el trabajo en vez de
 * esperarse.
 */
export async function reservarPendientes(
  limite = 10,
): Promise<ReporteEnCola[]> {
  const r = await query<ReporteEnCola>(
    `UPDATE proyecto_reportes
        SET envio_proximo_intento = CURRENT_TIMESTAMP + INTERVAL '10 minutes'
      WHERE id IN (
        SELECT id FROM proyecto_reportes
         WHERE activo = TRUE
           AND completo = TRUE
           AND enviado_at IS NULL
           AND envio_proximo_intento IS NOT NULL
           AND envio_proximo_intento <= CURRENT_TIMESTAMP
         ORDER BY envio_proximo_intento
         LIMIT $1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING id, proyecto_id, envio_intentos`,
    [limite],
  );
  return r.rows;
}

/** Salió. Sale de la cola para siempre. */
export async function marcarEnviado(reporteId: number): Promise<Date | null> {
  const r = await query<{ enviado_at: Date }>(
    `UPDATE proyecto_reportes
        SET enviado_at = CURRENT_TIMESTAMP,
            envio_proximo_intento = NULL,
            envio_ultimo_error = NULL
      WHERE id = $1
      RETURNING enviado_at`,
    [reporteId],
  );
  return r.rows[0]?.enviado_at ?? null;
}

/**
 * No salió. Se anota el motivo real y se calcula cuándo reintentar.
 *
 * Devuelve `true` si se acabaron los intentos, que es cuando hay que avisar.
 */
export async function anotarFallo(
  reporteId: number,
  intentosPrevios: number,
  motivo: string,
): Promise<boolean> {
  const intentos = intentosPrevios + 1;
  const proximo = calcularProximoIntento(intentos);
  await query(
    `UPDATE proyecto_reportes
        SET envio_intentos = $2,
            envio_ultimo_error = $3,
            envio_proximo_intento = $4
      WHERE id = $1`,
    [reporteId, intentos, motivo.slice(0, 2000), proximo],
  );
  return proximo === null;
}

/** Ya se avisó de este: que el cron no lo repita en cada pasada. */
export async function marcarAvisado(reporteId: number): Promise<void> {
  await query(
    'UPDATE proyecto_reportes SET envio_avisado = TRUE WHERE id = $1',
    [reporteId],
  );
}
