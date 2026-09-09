/**
 * Numeración de los reportes diarios de obra.
 *
 * Formato: RD-<prefijo>-YYMMDD, y -2, -3… cuando el proyecto ya tiene
 * reportes en esa misma fecha.
 *
 *   RD-PB-260908      el primero del 8 de septiembre de 2026
 *   RD-PB-260908-2    el segundo del mismo dia
 *
 * El prefijo es `proyectos.sp_prefijo`, la misma columna que produce los
 * ET-001 de las solicitudes de pago. RD lo marca como reporte diario. La
 * fecha del numero es la del reporte, no la del dia en que se envio: un
 * reporte del martes mandado el jueves lleva la del martes.
 *
 * Que se repita una fecha es legitimo y esperado. Se decidio no limitar a un
 * reporte por dia porque el caso de vacaciones o enfermedad obligaria a
 * decidir de quien es el dia; si dos ingenieros reportan el mismo dia, los
 * dos quedan.
 *
 * Este modulo es a proposito puro: no consulta la base, para que
 * scripts/reporte-numero.spec.ts pueda verificarlo sin levantar nada. Quien
 * lee el prefijo y cuenta los existentes es routes/proyectoReportes.ts.
 */

/** Un `YYYY-MM-DD` real, no solo con la forma correcta. */
const FORMATO_FECHA = /^(\d{4})-(\d{2})-(\d{2})$/;

export function construirNumeroReporte(
  prefijo: string,
  fecha: string,
  existentes: number,
): string {
  const p = String(prefijo ?? '').trim().toUpperCase();
  if (!p) {
    throw new Error('PREFIJO_NO_CONFIGURADO');
  }

  const m = FORMATO_FECHA.exec(String(fecha ?? ''));
  if (!m) {
    throw new Error(`Fecha inválida para numerar un reporte: "${fecha}"`);
  }
  const [, yyyy, mm, dd] = m;

  // La forma correcta no basta: "2026-13-45" la cumple. Se comprueba que la
  // fecha exista de verdad, porque un mes 13 daria un numero imposible que
  // nadie notaria hasta mucho despues.
  const d = new Date(`${yyyy}-${mm}-${dd}T12:00:00Z`);
  if (
    Number.isNaN(d.getTime()) ||
    d.getUTCFullYear() !== Number(yyyy) ||
    d.getUTCMonth() + 1 !== Number(mm) ||
    d.getUTCDate() !== Number(dd)
  ) {
    throw new Error(`Fecha inexistente para numerar un reporte: "${fecha}"`);
  }

  if (!Number.isInteger(existentes) || existentes < 0) {
    throw new Error(
      `Cantidad de reportes existentes inválida: ${String(existentes)}`,
    );
  }

  const base = `RD-${p}-${yyyy.slice(2)}${mm}${dd}`;
  return existentes === 0 ? base : `${base}-${existentes + 1}`;
}
