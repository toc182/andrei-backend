/**
 * La semana de un reporte semanal: qué semana es, cómo se numera y cómo se
 * escribe en el papel.
 *
 * La semana va de LUNES a DOMINGO y se identifica por su número ISO 8601, el
 * mismo que usa el resto del mundo: la semana 1 de un año es la que contiene
 * su primer jueves. De ahí salen dos cosas que hay que respetar y que no son
 * evidentes:
 *
 * - el año de la semana no siempre es el del lunes: la semana del 29 de
 *   diciembre de 2025 es la 1 de 2026, porque su jueves cae en enero;
 * - un año puede tener 53 semanas, no 52. 2026 es uno de ellos (su semana 53
 *   va del 28 de diciembre al 3 de enero).
 *
 * El número del reporte sigue la forma del diario —`RD-PB-260908`— con RS de
 * reporte semanal y la fecha del LUNES: `RS-PB-260907`. El prefijo es
 * `proyectos.sp_prefijo`, igual que en todo lo demás.
 *
 * Este módulo es a propósito puro: no consulta la base, para que
 * scripts/reporte-semana.spec.ts pueda verificarlo sin levantar nada.
 */

/** Un `YYYY-MM-DD` real, no solo con la forma correcta. */
const FORMATO_FECHA = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * La fecha como día UTC a mediodía.
 *
 * A mediodía y en UTC para que ningún cambio de horario ni la zona del
 * servidor pueda correr el día: Railway corre en UTC y la obra está en Panamá.
 */
function comoDia(fecha: string): Date {
  const m = FORMATO_FECHA.exec(String(fecha ?? ''));
  if (!m) {
    throw new Error(`Fecha inválida: "${fecha}"`);
  }
  const [, yyyy, mm, dd] = m;
  const d = new Date(`${yyyy}-${mm}-${dd}T12:00:00Z`);
  if (
    Number.isNaN(d.getTime()) ||
    d.getUTCFullYear() !== Number(yyyy) ||
    d.getUTCMonth() + 1 !== Number(mm) ||
    d.getUTCDate() !== Number(dd)
  ) {
    throw new Error(`Fecha inexistente: "${fecha}"`);
  }
  return d;
}

function comoTexto(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Lunes 0, domingo 6: el día de la semana como se cuenta aquí. */
function diaDeLaSemana(d: Date): number {
  return (d.getUTCDay() + 6) % 7;
}

/** El lunes de la semana en la que cae esa fecha. */
export function lunesDe(fecha: string): string {
  const d = comoDia(fecha);
  d.setUTCDate(d.getUTCDate() - diaDeLaSemana(d));
  return comoTexto(d);
}

/** El domingo de la semana en la que cae esa fecha. */
export function domingoDe(fecha: string): string {
  const d = comoDia(lunesDe(fecha));
  d.setUTCDate(d.getUTCDate() + 6);
  return comoTexto(d);
}

/** Los siete días de esa semana, de lunes a domingo. */
export function diasDeLaSemana(fecha: string): string[] {
  const lunes = comoDia(lunesDe(fecha));
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(lunes);
    d.setUTCDate(d.getUTCDate() + i);
    return comoTexto(d);
  });
}

/**
 * El año y el número de semana ISO de esa fecha.
 *
 * Se calcula por el jueves de la semana: el año de ese jueves es el año de la
 * semana, y el número es cuántas semanas van desde el primer jueves del año.
 */
export function semanaIso(fecha: string): { anio: number; semana: number } {
  const jueves = comoDia(lunesDe(fecha));
  jueves.setUTCDate(jueves.getUTCDate() + 3);
  const anio = jueves.getUTCFullYear();

  const primerJueves = new Date(Date.UTC(anio, 0, 4, 12, 0, 0));
  primerJueves.setUTCDate(primerJueves.getUTCDate() - diaDeLaSemana(primerJueves) + 3);

  const dias = Math.round(
    (jueves.getTime() - primerJueves.getTime()) / (24 * 60 * 60 * 1000),
  );
  return { anio, semana: Math.round(dias / 7) + 1 };
}

/**
 * El número del reporte semanal: `RS-<prefijo>-YYMMDD` con la fecha del lunes.
 *
 * A diferencia del diario no lleva sufijo: hay un solo reporte semanal por
 * proyecto y semana.
 */
export function construirNumeroSemanal(prefijo: string, fecha: string): string {
  const p = String(prefijo ?? '').trim().toUpperCase();
  if (!p) {
    throw new Error('PREFIJO_NO_CONFIGURADO');
  }
  const lunes = lunesDe(fecha);
  return `RS-${p}-${lunes.slice(2, 4)}${lunes.slice(5, 7)}${lunes.slice(8, 10)}`;
}
