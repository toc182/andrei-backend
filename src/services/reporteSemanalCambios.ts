/**
 * Qué cambió en una corrección de reporte semanal.
 *
 * Mismo trato que en el diario: lo que sale de aquí es lo que la gente lee, en
 * la pantalla del reporte y en la sección Correcciones del PDF. Y vale igual lo
 * que NO se registra: si cada guardado dejara una línea, el rastro se llenaría
 * de ruido y dejaría de leerse.
 *
 * El semanal se corrige de una sola vez —no sube fotos, así que no hay
 * reintentos a medias como en el diario—, y por eso aquí basta comparar el
 * reporte de antes con el de después. El marcado palabra por palabra del
 * resumen es el mismo del diario (cambiosDeTexto): es el mismo trabajo.
 *
 * Módulo puro a propósito, sin base de datos, para poder verificarlo con
 * scripts/reporte-semanal-cambios.spec.ts.
 */

import { cambiosDeTexto, type CambioLegible, type Trozo } from './reporteCambios.js';

/** Cuántos cambios se muestran de una misma sección antes de decir «y N más». */
const MAX_CAMBIOS = 3;

const trozo = (tipo: Trozo['tipo'], texto: string): Trozo => ({ tipo, texto });

export interface MetaComparable {
  id: number;
  texto: string;
  estado: 'completada' | 'parcial' | 'no_completada' | null;
  cantidad: number | null;
  unidad: string | null;
  cantidad_hecha: number | null;
  porcentaje: number | null;
  motivo: string | null;
}

/** El reporte semanal reducido a lo que se compara entre dos guardados. */
export interface EstadoSemanal {
  resumen: string | null;
  lo_que_se_espera: string | null;
  metas: MetaComparable[];
  metas_plan: { texto: string; cantidad: number | null; unidad: string | null }[];
  problemas: {
    fecha: string | null; problema: string; accion: string | null; pendiente: boolean | null;
  }[];
  decisiones: string[];
  /** Los ids de las fotos elegidas, en su orden. */
  fotos: number[];
}

const ESTADOS: Record<string, string> = {
  completada: 'completada',
  parcial: 'parcial',
  no_completada: 'no completada',
};

const texto = (v: string | null | undefined): string => (v ?? '').trim();

/** Cómo se lee una meta marcada: «parcial, 38 de 45 m³ — la planta no despachó». */
function metaComoTexto(m: MetaComparable): string {
  if (m.estado === null) return 'sin marcar';
  const partes: string[] = [ESTADOS[m.estado]];
  if (m.estado === 'parcial') {
    if (m.cantidad !== null && m.cantidad_hecha !== null) {
      partes.push(`${m.cantidad_hecha} de ${m.cantidad} ${texto(m.unidad)}`.trim());
    } else if (m.porcentaje !== null) {
      partes.push(`${m.porcentaje}%`);
    }
  }
  const cabeza = partes.join(', ');
  return texto(m.motivo) ? `${cabeza} — ${texto(m.motivo)}` : cabeza;
}

/** Una meta del plan, como se lee: «Colar la rampa — 7 m³». */
function planComoTexto(m: { texto: string; cantidad: number | null; unidad: string | null }): string {
  const cuanto = m.cantidad === null ? '' : ` — ${m.cantidad} ${texto(m.unidad)}`.trimEnd();
  return `${texto(m.texto)}${cuanto}`;
}

/** Un problema, como se lee: «9 sept · la planta no despachó · pendiente». */
function problemaComoTexto(
  p: { fecha: string | null; problema: string; accion: string | null; pendiente: boolean | null },
): string {
  const dia = p.fecha ? `${p.fecha} · ` : '';
  const accion = texto(p.accion) ? ` · ${texto(p.accion)}` : '';
  // Marcar o desmarcar «sigue pendiente» es una corrección como cualquier otra:
  // cambia lo que hay que seguir mirando.
  const pendiente = p.pendiente ? ' · pendiente' : '';
  return `${dia}${texto(p.problema)}${accion}${pendiente}`;
}

/**
 * Las líneas que se movieron en una lista, sin marcar palabras: en una lista lo
 * que importa es qué línea entró y cuál salió, no qué letra cambió dentro.
 */
function cambiosDeLista(antes: string[], despues: string[]): Trozo[][] {
  const quedan = new Set(despues);
  const estaban = new Set(antes);
  const renglones: Trozo[][] = [];
  for (const linea of antes) if (!quedan.has(linea)) renglones.push([trozo('quitado', linea)]);
  for (const linea of despues) if (!estaban.has(linea)) renglones.push([trozo('agregado', linea)]);
  return renglones;
}

/** Corta a MAX_CAMBIOS y dice cuántos quedaron fuera. */
function recortar(renglones: Trozo[][], que: string): Trozo[][] {
  if (renglones.length <= MAX_CAMBIOS) return renglones;
  const ocultos = renglones.length - MAX_CAMBIOS;
  return [
    ...renglones.slice(0, MAX_CAMBIOS),
    [trozo('nota', `y ${ocultos} ${ocultos === 1 ? 'cambio más' : 'cambios más'} en ${que}`)],
  ];
}

/**
 * Lo que cambió entre dos versiones del reporte, listo para dibujar.
 *
 * Vacío quiere decir que el guardado no movió nada que se vea, y esa corrección
 * no se muestra ni se guarda.
 */
export function diffSemanal(antes: EstadoSemanal, despues: EstadoSemanal): CambioLegible[] {
  const salida: CambioLegible[] = [];

  // El resumen es texto largo: se marca palabra por palabra, como el trabajo
  // ejecutado del diario.
  if (texto(antes.resumen) !== texto(despues.resumen)) {
    const grupos = cambiosDeTexto(antes.resumen, despues.resumen);
    if (grupos.length > 0) {
      salida.push({
        etiqueta: 'Resumen de la semana',
        renglones: recortar(grupos.flat(), 'el resumen'),
      });
    }
  }

  if (texto(antes.lo_que_se_espera) !== texto(despues.lo_que_se_espera)) {
    const grupos = cambiosDeTexto(antes.lo_que_se_espera, despues.lo_que_se_espera);
    if (grupos.length > 0) {
      salida.push({
        etiqueta: 'Lo que se espera',
        renglones: recortar(grupos.flat(), 'lo que se espera'),
      });
    }
  }

  // Las metas se siguen por su id: cambia cómo quedaron, no su texto, que es
  // del reporte que las planeó.
  const porId = new Map(antes.metas.map((m) => [m.id, m]));
  const metas: Trozo[][] = [];
  for (const m of despues.metas) {
    const previa = porId.get(m.id);
    const a = previa ? metaComoTexto(previa) : null;
    const b = metaComoTexto(m);
    if (a === b) continue;
    metas.push(
      a === null
        ? [trozo('igual', `${texto(m.texto)}:`), trozo('agregado', b)]
        : [trozo('igual', `${texto(m.texto)}:`), trozo('quitado', a), trozo('agregado', b)],
    );
  }
  const idsDespues = new Set(despues.metas.map((m) => m.id));
  for (const m of antes.metas) {
    if (!idsDespues.has(m.id)) {
      metas.push([trozo('quitado', `${texto(m.texto)}: ${metaComoTexto(m)}`)]);
    }
  }
  if (metas.length > 0) {
    salida.push({ etiqueta: 'Metas de la semana', renglones: recortar(metas, 'las metas') });
  }

  const problemas = cambiosDeLista(
    antes.problemas.map(problemaComoTexto),
    despues.problemas.map(problemaComoTexto),
  );
  if (problemas.length > 0) {
    salida.push({ etiqueta: 'Problemas y atrasos', renglones: recortar(problemas, 'los problemas') });
  }

  const plan = cambiosDeLista(
    antes.metas_plan.map(planComoTexto),
    despues.metas_plan.map(planComoTexto),
  );
  if (plan.length > 0) {
    salida.push({ etiqueta: 'Plan de la próxima semana', renglones: recortar(plan, 'el plan') });
  }

  const decisiones = cambiosDeLista(
    antes.decisiones.map(texto),
    despues.decisiones.map(texto),
  );
  if (decisiones.length > 0) {
    salida.push({ etiqueta: 'Decisiones', renglones: recortar(decisiones, 'las decisiones') });
  }

  // Las fotos se cuentan y no se nombran: en el semanal son fotos de los
  // diarios, y su nombre de archivo no le dice nada a nadie.
  const habia = new Set(antes.fotos);
  const hay = new Set(despues.fotos);
  const agregadas = despues.fotos.filter((id) => !habia.has(id)).length;
  const quitadas = antes.fotos.filter((id) => !hay.has(id)).length;
  const fotos: Trozo[][] = [];
  if (agregadas > 0) {
    fotos.push([trozo('igual', agregadas === 1 ? 'se agregó 1' : `se agregaron ${agregadas}`)]);
  }
  if (quitadas > 0) {
    fotos.push([trozo('igual', quitadas === 1 ? 'se quitó 1' : `se quitaron ${quitadas}`)]);
  }
  if (fotos.length > 0) salida.push({ etiqueta: 'Fotos', renglones: fotos });

  return salida;
}
