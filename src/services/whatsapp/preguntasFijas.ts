// Las preguntas del reporte diario: cuales, con que palabras y en que orden.
//
// Las hace el SISTEMA, no el modelo (decision de Ivan del 2026-09-28, sobre el
// mock «Preguntas fijas del reporte»). Antes el modelo decidia que preguntar y
// ademas anotaba lo que le contestaban; cada regla nueva para ordenarlo movia
// el error a otro sitio —preguntaba la fecha cinco veces, decia «lo anoto» y
// no anotaba—. Ahora el modelo solo entiende y anota, y lo que se pregunta
// despues sale de aqui.
//
// Todo es puro: recibe el estado y devuelve la pregunta, sin tocar la base. La
// prueba es scripts/whatsapp-preguntas.spec.ts.

import { CLIMAS, preguntaDeLista, type DatosReporte, type ListasProyecto } from './datosReporte.js';

export interface PreguntaFija {
  /** Que se pregunta: 'clima', 'areas', 'trabajo:12'… Es la llave de las veces. */
  grupo: string;
  texto: string;
  botones?: { id: string; titulo: string }[];
}

/** Sin mayusculas, tildes ni signos: como se compara lo que escribe la gente. */
export const llano = (t: string | null | undefined): string =>
  (t ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// La primera vez y, si no la contesto, la segunda —con otras palabras—.
// Aprobadas por Ivan en el mock del 2026-09-28.
const TEXTOS = {
  obra: ['¿De qué obra es el reporte?', 'No me quedó claro de qué obra es. ¿Cuál de estas?'],
  clima: ['¿Cómo estuvo el clima?', 'Me falta el clima. ¿Cuál de estos fue?'],
  horas: [
    '¿Se perdieron horas de trabajo? Si fue así, ¿cuántas y por qué?',
    '¿Hubo horas perdidas hoy? Si no, dime «no».',
  ],
  areas: ['¿En qué áreas se trabajó?', 'Dime los números de las áreas donde se trabajó.'],
  trabajo: ['¿Qué se hizo hoy?', 'Cuéntame lo que se hizo hoy, aunque sea en pocas palabras.'],
  mal: [
    '¿Hubo atrasos o algo que frenara el trabajo? ¿Alguna novedad del día?',
    '¿Algún atraso o novedad? Si no hubo, dime «nada».',
  ],
  gente: [
    '¿Cuánta gente trabajó y en qué puestos?',
    'Me falta la gente: por ejemplo, «2 albañiles y 6 ayudantes».',
  ],
  maquinas: [
    '¿Qué máquinas trabajaron y cuántas horas cada una?',
    '¿Trabajó alguna máquina? Si no, dime «ninguna».',
  ],
  llego: [
    '¿Llegó algo a la obra? Material, equipo o herramienta.',
    '¿Llegó algún material o equipo? Si no, dime «nada».',
  ],
  fotos: [
    'Si tienes fotos del día, mándalas. Si quieres, escribe en cada una lo que muestra: ' +
      'sale debajo de la foto en el reporte.',
  ],
  final: ['Ya tengo todo. ¿Te mando el borrador?', '¿Algo más, o te mando el borrador?'],
} as const;

const trabajoEn = (area: string): readonly [string, string] => [
  `¿Qué se hizo en ${area}?`,
  `Cuéntame lo que se hizo en ${area}, aunque sea en pocas palabras.`,
];

export const BOTONES_FECHA = [
  { id: 'fecha_hoy', titulo: 'Sí' },
  { id: 'fecha_otra', titulo: 'Otra fecha' },
];
export const BOTONES_FINAL = [
  { id: 'mandar_borrador', titulo: 'Mandar borrador' },
  { id: 'agregar_algo', titulo: 'Agregar algo' },
];

/** Todo lo que hace falta para saber que se pregunta ahora. */
export interface EstadoReporte {
  datos: DatosReporte;
  /** null mientras no haya obra elegida. */
  listas: ListasProyecto | null;
  fotos: number;
  /** Las obras donde puede reportar, en el orden de la lista que se le manda. */
  obras: { id: number; nombre: string }[];
  /** «lunes 28 de septiembre». */
  hoyEnPalabras: string;
}

/**
 * Lo que toca preguntar ahora, o null si no hay nada que preguntar (no tiene
 * obras donde reportar).
 *
 * Cada pregunta sale como mucho dos veces seguidas —la segunda con otras
 * palabras—; la fecha y las fotos, una. Si el clima o el trabajo siguen
 * faltando, se piden otra vez al final, antes de ofrecer el borrador. Lo que
 * ya conto, aunque fuera fuera de orden, no se pregunta.
 */
export function siguientePregunta(e: EstadoReporte): PreguntaFija | null {
  const d = e.datos;
  const veces = d.veces ?? {};
  const vez = (g: string): number => veces[g] ?? 0;
  const dicha = new Set(d.preguntadas ?? []);
  const cual = (par: readonly string[], v: number): string => par[Math.min(v, par.length - 1)];

  if (!e.listas) {
    if (e.obras.length === 0) return null;
    return {
      grupo: 'obra',
      texto: preguntaDeLista(e.obras, cual(TEXTOS.obra, vez('obra')), TEXTOS.obra[0]),
    };
  }
  const listas = e.listas;

  if (!dicha.has('fecha') && vez('fecha') === 0) {
    return {
      grupo: 'fecha',
      texto: `¿El reporte es de hoy, ${e.hoyEnPalabras}?`,
      botones: BOTONES_FECHA,
    };
  }

  const sinClima = d.clima === undefined && !dicha.has('clima');
  const sinTrabajo = !(d.trabajos?.length) && d.queSeHizo === undefined;
  const pendientes: { grupo: string; max: number; hacer: (v: number) => PreguntaFija }[] = [];
  const agregar = (grupo: string, max: number, hacer: (v: number) => PreguntaFija): void => {
    pendientes.push({ grupo, max, hacer });
  };

  if (sinClima) {
    agregar('clima', 2, (v) => ({
      grupo: 'clima',
      texto: preguntaDeLista(
        CLIMAS.map((c, i) => ({ id: i + 1, nombre: c })),
        cual(TEXTOS.clima, v),
        TEXTOS.clima[0],
      ),
    }));
  }
  if (d.horasPerdidas === undefined && !dicha.has('horasPerdidas')) {
    agregar('horas', 2, (v) => ({ grupo: 'horas', texto: cual(TEXTOS.horas, v) }));
  }

  // El trabajo, por areas: primero en cuales, despues que se hizo en cada una.
  const hayAreas = listas.areas.length > 0;
  const areasDichas = (d.areas ?? []).filter((id) => listas.areas.some((a) => a.id === id));
  if (hayAreas && areasDichas.length === 0 && sinTrabajo && !dicha.has('areas')) {
    agregar('areas', 2, (v) => ({
      grupo: 'areas',
      texto: preguntaDeLista(listas.areas, cual(TEXTOS.areas, v), TEXTOS.areas[0]),
    }));
  }
  for (const area of listas.areas) {
    if (!areasDichas.includes(area.id)) continue;
    if ((d.trabajos ?? []).some((t) => t.areaId === area.id)) continue;
    const grupo = `trabajo:${area.id}`;
    agregar(grupo, 2, (v) => ({ grupo, texto: cual(trabajoEn(area.nombre), v) }));
  }
  // Sin areas en la obra, o si no contesto en cuales, se pregunta en general.
  const sinPreguntarAreas = !hayAreas || dicha.has('areas') || vez('areas') >= 2;
  if (sinTrabajo && areasDichas.length === 0 && sinPreguntarAreas) {
    agregar('trabajo', 2, (v) => ({ grupo: 'trabajo', texto: cual(TEXTOS.trabajo, v) }));
  }

  if (
    d.atrasos === undefined && d.novedades === undefined &&
    !dicha.has('atrasos') && !dicha.has('novedades')
  ) {
    agregar('mal', 2, (v) => ({ grupo: 'mal', texto: cual(TEXTOS.mal, v) }));
  }
  if (d.personal === undefined && !dicha.has('personal')) {
    agregar('gente', 2, (v) => ({ grupo: 'gente', texto: cual(TEXTOS.gente, v) }));
  }
  if (d.equipos === undefined && !dicha.has('equipos')) {
    agregar('maquinas', 2, (v) => ({ grupo: 'maquinas', texto: cual(TEXTOS.maquinas, v) }));
  }
  if (d.entregas === undefined && !dicha.has('entregas')) {
    agregar('llego', 2, (v) => ({ grupo: 'llego', texto: cual(TEXTOS.llego, v) }));
  }
  if (e.fotos === 0 && !dicha.has('fotos')) {
    agregar('fotos', 1, () => ({ grupo: 'fotos', texto: TEXTOS.fotos[0] }));
  }

  const toca = pendientes.find((p) => vez(p.grupo) < p.max);
  if (toca) return toca.hacer(vez(toca.grupo));

  // Lo que el reporte no puede llevar vacio se pide una vez mas, al final.
  if (sinClima && vez('clima') < 3) {
    return {
      grupo: 'clima',
      texto: preguntaDeLista(
        CLIMAS.map((c, i) => ({ id: i + 1, nombre: c })),
        `Antes del borrador me falta el clima. ${TEXTOS.clima[0]}`,
        TEXTOS.clima[0],
      ),
    };
  }
  if (sinTrabajo && vez('trabajo') < 3) {
    return {
      grupo: 'trabajo',
      texto: `Antes del borrador me falta lo que se hizo. ${TEXTOS.trabajo[0]}`,
    };
  }

  return { grupo: 'final', texto: cual(TEXTOS.final, vez('final')), botones: BOTONES_FINAL };
}

/** Lo que cuenta como «sí, es de hoy» a la pregunta de la fecha. */
const ES_DE_HOY = new Set([
  'si', 'sip', 'hoy', 'es de hoy', 'si es de hoy', 'si de hoy', 'si hoy', 'de hoy',
  'correcto', 'claro', 'ok', 'dale', 'asi es', 'exacto', 'afirmativo',
]);

/** Lo que habla de OTRO dia: eso lo resuelve el modelo preguntando cual. «no»
 *  solo como respuesta —«no», «no es de hoy»—: «no se perdieron horas» no habla
 *  de la fecha. Se mira sobre el texto ya llano(), asi que «25/09» llega como
 *  «25 09». */
const OTRO_DIA =
  /^no$|^no (es|fue|era)\b|^(el )?\d{1,2}( \d{1,2})?$|\b(otra fecha|otro dia|ayer|anteayer|antier|anoche|pasado|lunes|martes|miercoles|jueves|viernes|sabado|domingo|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)\b/;

/** «No hubo nada» dicho de las maneras de siempre. */
const NADA = new Set([
  'no', 'nop', 'nada', 'ninguna', 'ninguno', 'negativo', 'tampoco', 'no hubo', 'no hubo nada',
  'nada nuevo', 'sin novedad', 'sin novedades', 'sin atrasos', 'sin atrasos ni novedades',
  'no hay', 'no tengo', 'no tengo fotos', 'sin fotos', 'no llego nada', 'no se perdieron',
  'no se perdieron horas', 'no se perdio nada', 'ninguna maquina', 'todo bien', 'todo normal',
  'nada que reportar', 'cero', '0',
]);

/** Las secciones que quedan dichas cuando a esa pregunta contesta «nada». El
 *  trabajo no esta: un reporte sin trabajo no existe. */
const SECCIONES_DE: Record<string, string[]> = {
  horas: ['horasPerdidas'],
  mal: ['atrasos', 'novedades'],
  gente: ['personal'],
  maquinas: ['equipos'],
  llego: ['entregas'],
  fotos: ['fotos'],
};

export type Resolucion =
  /** No es una respuesta que el sistema sepa leer: la lee el modelo. */
  | { tipo: 'modelo' }
  /** Resuelta del todo: no hace falta el modelo, sale la pregunta que sigue. */
  | { tipo: 'resuelta'; datos: DatosReporte; proyectoId?: number }
  /** Se anoto algo, pero lo que dijo lo tiene que leer el modelo, y ademas
   *  decirle a la persona lo que el sistema decidio. */
  | { tipo: 'aviso'; datos: DatosReporte; aviso: string };

/**
 * La respuesta a una pregunta fija, cuando es de las que no necesitan criterio:
 * «Sí» a la fecha, un numero de la lista, «nada».
 *
 * Los numeros de las listas son la POSICION en la lista que salio. Los resuelve
 * el sistema, que es quien la mando: pedirle al modelo que los traduzca a un id
 * es lo que salio mal con las obras el 2026-09-26.
 */
export function resolverRespuesta(r: {
  datos: DatosReporte;
  /** Todo lo que escribio desde la ultima pregunta, junto. */
  dicho: string;
  /** Cuantos mensajes son. Una foto y un texto no son «un numero». */
  mensajes: number;
  listas: ListasProyecto | null;
  obras: { id: number; nombre: string }[];
  hoy: string;
  hoyEnPalabras: string;
}): Resolucion {
  const d = r.datos;
  const ultima = d.ultimaPregunta ?? null;
  const t = llano(r.dicho);
  const dicha = new Set(d.preguntadas ?? []);
  const marcar = (claves: string[]): string[] => [...new Set([...(d.preguntadas ?? []), ...claves])];

  if (ultima === 'fecha' && !dicha.has('fecha')) {
    const confirma = r.mensajes === 1 && ES_DE_HOY.has(t);
    if (!confirma && (!t || OTRO_DIA.test(t))) return { tipo: 'modelo' };
    const datos = { ...d, fecha: d.fecha ?? r.hoy, preguntadas: marcar(['fecha']) };
    if (confirma) return { tipo: 'resuelta', datos };
    return {
      tipo: 'aviso',
      datos,
      aviso:
        `No contestó la fecha: el reporte queda con la de hoy (${r.hoyEnPalabras}). ` +
        'Díselo en media línea y anota lo que te contó.',
    };
  }

  if (r.mensajes !== 1) return { tipo: 'modelo' };

  if (ultima === 'obra' && /^\d{1,2}$/.test(t)) {
    const obra = r.obras[Number(t) - 1];
    return obra ? { tipo: 'resuelta', datos: d, proyectoId: obra.id } : { tipo: 'modelo' };
  }

  if (ultima === 'clima' && /^[1-4]$/.test(t)) {
    return { tipo: 'resuelta', datos: { ...d, clima: CLIMAS[Number(t) - 1] } };
  }

  if (ultima === 'areas' && r.listas && /^\d{1,2}( (y )?\d{1,2})*$/.test(t)) {
    const posiciones = [...new Set(t.split(' ').filter((x) => x !== 'y').map(Number))];
    const areas = posiciones.map((p) => r.listas!.areas[p - 1]);
    if (areas.some((a) => !a)) return { tipo: 'modelo' };
    return { tipo: 'resuelta', datos: { ...d, areas: areas.map((a) => a!.id) } };
  }

  if (ultima && SECCIONES_DE[ultima] && NADA.has(t)) {
    const datos: DatosReporte = { ...d, preguntadas: marcar(SECCIONES_DE[ultima]) };
    if (ultima === 'horas') datos.horasPerdidas = 0;
    return { tipo: 'resuelta', datos };
  }

  return { tipo: 'modelo' };
}

/** «¿Hubo atrasos…?» → «¿hubo atrasos…?», para ponerle algo delante. */
export function enMinuscula(texto: string): string {
  const i = texto.startsWith('¿') ? 1 : 0;
  return texto.slice(0, i) + texto.charAt(i).toLowerCase() + texto.slice(i + 1);
}
