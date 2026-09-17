/**
 * Que cambio en una correccion de reporte diario.
 *
 * Lo que sale de aqui es lo que la gente lee: aparece en la pantalla del
 * reporte y, impreso, en la seccion Correcciones del PDF que va por correo.
 * Por eso importa tanto lo que NO se registra como lo que si: si cada guardado
 * dejara una linea, el rastro se llenaria de ruido y dejaria de leerse.
 *
 * Modulo puro a proposito, sin base de datos, para poder verificarlo con
 * scripts/reporte-cambios.spec.ts.
 */

/** Los nombres con los que la gente conoce cada campo. */
export const CAMPO_LABELS: Record<string, string> = {
  fecha: 'Fecha',
  clima: 'Clima',
  horas_perdidas: 'Horas perdidas',
  motivo: 'Motivo',
  personal_calificado: 'Personal calificado',
  ayudantes: 'Ayudantes',
  equipo: 'Equipo utilizado',
  areas: 'Áreas',
  que_se_hizo: 'Trabajo ejecutado',
  atrasos: 'Atrasos o impedimentos',
  novedades: 'Novedades del día',
};

export interface Cambio {
  label: string;
  antes: string | number | null;
  despues: string | number | null;
}

/**
 * Las horas perdidas en blanco significan cero: se decidio no obligar a
 * escribir 0 todos los dias soleados. Null, cadena vacia y 0 son lo mismo.
 */
export function parseHoras(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Un texto vacio y la ausencia de texto son lo mismo. */
function normTexto(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

/** Una fecha puede llegar como Date desde la base o como texto desde el form. */
function normFecha(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

/**
 * Equipo y areas son "cuales", no "en que orden". Reordenar la lista sin
 * agregar ni quitar nada no es una correccion y no debe ensuciar el rastro.
 */
function normLista(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => String(x).trim())
    .filter((x) => x !== '')
    .sort();
}

function normNumero(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Como se ve un valor ya normalizado cuando se imprime en el rastro. */
function paraMostrar(campo: string, v: unknown): string | number | null {
  if (campo === 'equipo' || campo === 'areas') {
    const l = v as string[];
    return l.length === 0 ? null : l.join(', ');
  }
  return v as string | number | null;
}

function normalizar(campo: string, v: unknown): unknown {
  switch (campo) {
    case 'fecha':
      return normFecha(v);
    // En blanco significa cero, asi que para comparar son el mismo valor.
    // Guardar sigue guardando null; es solo aqui donde se igualan, para que
    // pasar de vacio a 0 no deje una linea de correccion que no dice nada.
    case 'horas_perdidas':
      return parseHoras(v) ?? 0;
    case 'personal_calificado':
    case 'ayudantes':
      return normNumero(v);
    case 'equipo':
    case 'areas':
      return normLista(v);
    default:
      return normTexto(v);
  }
}

/**
 * Compara campo por campo y devuelve solo los que de verdad se movieron.
 *
 * Solo mira los campos presentes en `despues`: un guardado parcial que no
 * menciona un campo no lo esta cambiando, y decir que paso a null seria
 * mentira.
 */
export function diffCampos(
  antes: Record<string, unknown>,
  despues: Record<string, unknown>,
): Record<string, Cambio> {
  const salida: Record<string, Cambio> = {};

  for (const campo of Object.keys(CAMPO_LABELS)) {
    if (!(campo in despues) || despues[campo] === undefined) continue;

    const a = normalizar(campo, antes[campo]);
    const b = normalizar(campo, despues[campo]);

    if (JSON.stringify(a) === JSON.stringify(b)) continue;

    salida[campo] = {
      label: CAMPO_LABELS[campo],
      antes: paraMostrar(campo, a),
      despues: paraMostrar(campo, b),
    };
  }

  return salida;
}

/**
 * Una fila de Personal, Equipo o Entregas, reducida a lo que hace falta para
 * compararla: una clave estable, el nombre que lee la gente, y su valor.
 */
export interface FilaComparable {
  clave: string;
  label: string;
  valor: string | number;
}

/**
 * Compara dos conjuntos de filas y devuelve las que se movieron.
 *
 * Existe porque diffCampos solo sabe de campos sueltos: cuando Personal paso a
 * ser filas, corregir de 14 a 9 ayudantes dejaba de aparecer en el rastro.
 *
 * `faltante` es lo que vale una fila que no esta. En Personal y Equipo una fila
 * ausente significa cero —es la regla acordada, "vacio es cero"—, asi que se
 * pasa 0 y el rastro dice "Ayudantes de 0 a 9". En Entregas no hay cero posible:
 * una entrega existe o no, asi que se pasa null y el rastro dice "se agrego
 * Varilla #5".
 *
 * Puro a proposito, como el resto del modulo: sin consultas a la base.
 */
export function diffFilas(
  antes: FilaComparable[],
  despues: FilaComparable[],
  faltante: 0 | null = 0,
): Record<string, Cambio> {
  const porClave = (filas: FilaComparable[]) => {
    const m = new Map<string, FilaComparable>();
    for (const f of filas) m.set(f.clave, f);
    return m;
  };
  const a = porClave(antes);
  const b = porClave(despues);

  const salida: Record<string, Cambio> = {};
  for (const clave of new Set([...a.keys(), ...b.keys()])) {
    const va = a.get(clave);
    const vb = b.get(clave);
    const valorA = va ? va.valor : faltante;
    const valorB = vb ? vb.valor : faltante;
    if (String(valorA) === String(valorB)) continue;
    salida[clave] = {
      // El label sale de la fila que exista; si se quito, de la vieja.
      label: (vb ?? va)!.label,
      antes: valorA,
      despues: valorB,
    };
  }
  return salida;
}

/** El tope de una leyenda de foto. Igual que la columna (167) y que la pantalla. */
export const LEYENDA_MAX = 150;

/**
 * Una leyenda como se guarda y se compara: en un solo renglon, sin espacios de
 * mas, y en blanco es null. Un Enter del teclado del telefono no es un cambio, y
 * debajo de la foto no se veria de todos modos.
 */
export function normLeyenda(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.replace(/\s+/g, ' ').trim();
  return s === '' ? null : s;
}

/** Una foto del reporte con su leyenda, en el orden en que se ve. */
export interface LeyendaDeFoto {
  id: number;
  leyenda: string | null;
}

/** Una leyenda que un guardado cambio. `numero` es el de la foto, desde 1. */
export interface LeyendaCambiada {
  id: number;
  numero: number;
  antes: string | null;
  despues: string | null;
}

/**
 * Las leyendas que cambian en un guardado, ya normalizadas.
 *
 * `antes` son TODAS las fotos del reporte en su orden, porque de ahi sale el
 * numero con que la gente las conoce («la foto 3»), el mismo de la pantalla y
 * del PDF. `despues` es lo que mando la pantalla: una foto que no es de este
 * reporte no cuenta, y una que no trae leyenda no se esta tocando —ausente es
 * no tocar; null o en blanco es quitarla—.
 */
export function leyendasCambiadas(
  antes: LeyendaDeFoto[],
  despues: { id: number; leyenda?: string | null }[],
): LeyendaCambiada[] {
  const pedidas = new Map(
    despues
      .filter((f) => f.leyenda !== undefined)
      .map((f) => [Number(f.id), normLeyenda(f.leyenda)]),
  );
  const salida: LeyendaCambiada[] = [];
  antes.forEach((f, i) => {
    if (!pedidas.has(f.id)) return;
    const a = normLeyenda(f.leyenda);
    const b = pedidas.get(f.id)!;
    if (a !== b) salida.push({ id: f.id, numero: i + 1, antes: a, despues: b });
  });
  return salida;
}

/** Las leyendas cambiadas, como cambios de Correcciones. */
export function cambiosDeLeyendas(lista: LeyendaCambiada[]): Record<string, Cambio> {
  return Object.fromEntries(
    lista.map((l) => [
      `leyenda:${l.id}`,
      { label: `Leyenda de la foto ${l.numero}`, antes: l.antes, despues: l.despues },
    ]),
  );
}

/** Una foto que una correccion agrego o quito. */
export interface FotoCorregida {
  id: number;
  nombre: string;
}

/** Lo que guarda una fila de proyecto_reporte_correcciones. */
export interface ContenidoCorreccion {
  cambios: Record<string, Cambio>;
  fotos_agregadas: FotoCorregida[];
  fotos_quitadas: FotoCorregida[];
}

/** Lo que una sola peticion le suma a una correccion. */
export interface ParteCorreccion {
  cambios?: Record<string, Cambio>;
  fotosAgregadas?: FotoCorregida[];
  fotosQuitadas?: FotoCorregida[];
}

const mismoValor = (a: Cambio['antes'], b: Cambio['antes']) =>
  (a === null ? null : String(a)) === (b === null ? null : String(b));

/**
 * Junta los cambios de dos guardados de la MISMA correccion.
 *
 * Pasa cuando se corta la senal: el ingeniero vuelve a darle a «Guardar
 * cambios», quiza despues de corregir algo mas, y todo sigue siendo una sola
 * correccion. De cada campo se queda el «antes» del primer guardado y el
 * «despues» del ultimo; si al final quedo como estaba, el campo no cambio.
 */
export function fusionarCambios(
  previos: Record<string, Cambio>,
  nuevos: Record<string, Cambio>,
): Record<string, Cambio> {
  const salida: Record<string, Cambio> = { ...previos };
  for (const [campo, c] of Object.entries(nuevos)) {
    const antes = campo in previos ? previos[campo].antes : c.antes;
    if (mismoValor(antes, c.despues)) {
      delete salida[campo];
    } else {
      salida[campo] = { label: c.label, antes, despues: c.despues };
    }
  }
  return salida;
}

/**
 * Suma a una correccion lo que trae una peticion mas del mismo guardado.
 *
 * Una foto que se agrego y se quito dentro de la misma correccion no cambio
 * nada: pasa en el reintento, cuando una foto alcanzo a subir antes del corte y
 * el ingeniero la quito antes de volver a darle a Guardar.
 *
 * Tampoco cuenta la leyenda de una foto que esta misma correccion agrego o
 * quito: la foto nueva ya sale como «se agregó 1», y su leyenda es parte de
 * ella. Pasa en el reintento: la foto subio con su leyenda antes del corte, el
 * ingeniero le retoco el texto y el guardado siguiente lo manda como cambio.
 */
export function sumarACorreccion(
  actual: ContenidoCorreccion,
  parte: ParteCorreccion,
): ContenidoCorreccion {
  let agregadas = [...actual.fotos_agregadas, ...(parte.fotosAgregadas ?? [])];
  const quitadas = [...actual.fotos_quitadas];
  for (const f of parte.fotosQuitadas ?? []) {
    if (agregadas.some((a) => a.id === f.id)) {
      agregadas = agregadas.filter((a) => a.id !== f.id);
    } else {
      quitadas.push(f);
    }
  }
  const cambios = fusionarCambios(actual.cambios, parte.cambios ?? {});
  // Tambien las que se agregaron y se quitaron dentro de la correccion, que ya
  // no estan en ninguna de las dos listas.
  const tocadas = [
    ...actual.fotos_agregadas, ...(parte.fotosAgregadas ?? []), ...quitadas,
    ...(parte.fotosQuitadas ?? []),
  ];
  for (const f of tocadas) delete cambios[`leyenda:${f.id}`];
  return {
    cambios,
    fotos_agregadas: agregadas,
    fotos_quitadas: quitadas,
  };
}

// ---------------------------------------------------------------------------
// Como se lee una correccion
// ---------------------------------------------------------------------------
//
// Solo se muestra lo que cambio: lo quitado va tachado y lo agregado subrayado.
// Antes se imprimia «Trabajo ejecutado de <todo el texto> a <todo el texto>», y
// en el reporte RD-PBR-260915 eso fueron once renglones para decir que Cesar
// agrego uno al final. El diseno lo aprobo Ivan sobre una maqueta el 2026-09-16.
//
// Aqui se arma la UNICA version de cada linea. La pantalla y el PDF la reciben
// hecha y solo le ponen estilo, para que no puedan decir cosas distintas.

/**
 * Un pedazo de un renglon. Quien lo dibuja los junta con un espacio.
 *
 * - igual: texto que no cambio, o una frase como «se agregaron 2».
 * - quitado / agregado: tachado / subrayado.
 * - corte: el «…» donde se omite texto que no cambio.
 * - nota: la aclaracion en gris, «y 4 cambios más en este texto».
 */
export interface Trozo {
  tipo: 'igual' | 'quitado' | 'agregado' | 'corte' | 'nota';
  texto: string;
}

/** Lo que cambio en un campo, listo para dibujar: su nombre y sus renglones. */
export interface CambioLegible {
  etiqueta: string;
  renglones: Trozo[][];
}

/** Los campos de texto largo: se comparan renglon por renglon y palabra por palabra. */
const CAMPOS_DE_TEXTO = new Set(['que_se_hizo', 'atrasos', 'novedades', 'motivo']);

/** Cuantos cambios se muestran de un mismo texto antes de decir «y N más». */
const MAX_CAMBIOS = 3;

/** Palabras que no cambiaron que se dejan a cada lado de un cambio. */
const CONTEXTO = 6;

/**
 * Por encima de esto no se compara palabra por palabra: la cuenta crece con el
 * producto de las dos longitudes, y un parrafo enorme reescrito se muestra
 * entero de todos modos.
 */
const MAX_CELDAS = 250_000;

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

const trozo = (tipo: Trozo['tipo'], texto: string): Trozo => ({ tipo, texto });

type Paso<T> = { tipo: 'igual' | 'quitado' | 'agregado'; valor: T };

/**
 * Alinea dos listas por su subsecuencia comun mas larga. Donde hay que quitar
 * y agregar a la vez, lo quitado va primero, que es como se lee.
 */
function alinear<T>(a: T[], b: T[]): Paso<T>[] {
  const n = a.length;
  const m = b.length;
  const largo = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      largo[i][j] = a[i] === b[j]
        ? largo[i + 1][j + 1] + 1
        : Math.max(largo[i + 1][j], largo[i][j + 1]);
    }
  }
  const pasos: Paso<T>[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pasos.push({ tipo: 'igual', valor: a[i] });
      i += 1;
      j += 1;
    } else if (largo[i + 1][j] >= largo[i][j + 1]) {
      pasos.push({ tipo: 'quitado', valor: a[i++] });
    } else {
      pasos.push({ tipo: 'agregado', valor: b[j++] });
    }
  }
  while (i < n) pasos.push({ tipo: 'quitado', valor: a[i++] });
  while (j < m) pasos.push({ tipo: 'agregado', valor: b[j++] });
  return pasos;
}

const palabras = (s: string) => s.split(/\s+/).filter((p) => p !== '');

/**
 * Los renglones con algo escrito, con los espacios normalizados. Ni un renglon
 * en blanco de mas ni un espacio doble son un cambio que valga la pena mostrar.
 */
const renglones = (s: string) =>
  s.split(/\r?\n/).map((r) => palabras(r).join(' ')).filter((r) => r !== '');

/**
 * Un renglon que se edito, con cada cambio marcado dentro.
 *
 * Devuelve null si los dos renglones se parecen tan poco que marcar palabra por
 * palabra confundiria mas que ayudar: entonces se muestran enteros, el viejo
 * tachado y el nuevo subrayado.
 */
function renglonEditado(antes: string, despues: string): Trozo[] | null {
  const a = palabras(antes);
  const b = palabras(despues);
  if (a.length * b.length > MAX_CELDAS) return null;

  const pasos = alinear(a, b);
  const comunes = pasos.filter((p) => p.tipo === 'igual').length;
  if (comunes / Math.max(a.length, b.length) < 0.5) return null;

  // Tramos: lo que no cambio, y cada cambio con lo que se quito y lo que entro.
  type Igual = { igual: true; palabras: string[] };
  type Distinto = { igual: false; quitadas: string[]; agregadas: string[] };
  const tramos: (Igual | Distinto)[] = [];
  for (const p of pasos) {
    const ultimo = tramos[tramos.length - 1];
    if (p.tipo === 'igual') {
      if (ultimo?.igual) {
        ultimo.palabras.push(p.valor);
      } else {
        tramos.push({ igual: true, palabras: [p.valor] });
      }
      continue;
    }
    let cambio = ultimo && !ultimo.igual ? ultimo : null;
    if (!cambio) {
      cambio = { igual: false, quitadas: [], agregadas: [] };
      tramos.push(cambio);
    }
    (p.tipo === 'quitado' ? cambio.quitadas : cambio.agregadas).push(p.valor);
  }

  // Lo que no cambio se recorta a unas palabras de cada lado del cambio, pero
  // solo si lo omitido vale la pena: esconder una o dos palabras no ahorra nada.
  const salida: Trozo[] = [];
  tramos.forEach((t, k) => {
    if (!t.igual) {
      if (t.quitadas.length) salida.push(trozo('quitado', t.quitadas.join(' ')));
      if (t.agregadas.length) salida.push(trozo('agregado', t.agregadas.join(' ')));
      return;
    }
    const p = t.palabras;
    const primero = k === 0;
    const ultimo = k === tramos.length - 1;
    const guardar = primero || ultimo ? CONTEXTO : 2 * CONTEXTO;
    if (p.length <= guardar + 3) {
      salida.push(trozo('igual', p.join(' ')));
    } else if (primero) {
      salida.push(trozo('corte', '…'), trozo('igual', p.slice(-CONTEXTO).join(' ')));
    } else if (ultimo) {
      salida.push(trozo('igual', p.slice(0, CONTEXTO).join(' ')), trozo('corte', '…'));
    } else {
      salida.push(
        trozo('igual', p.slice(0, CONTEXTO).join(' ')),
        trozo('corte', '…'),
        trozo('igual', p.slice(-CONTEXTO).join(' ')),
      );
    }
  });
  return salida;
}

/**
 * Lo que cambio en un texto largo, como grupos de renglones. Cada grupo es un
 * «cambio» para el tope de MAX_CAMBIOS.
 *
 * Primero se alinean los renglones: los ingenieros escriben el trabajo del dia
 * como una lista, un renglon por actividad, y lo que no se toco no se muestra.
 * Un renglon quitado sale tachado; uno agregado, subrayado; uno editado, con el
 * cambio marcado dentro.
 *
 * Se exporta porque el reporte SEMANAL marca su resumen igual que el diario
 * marca su trabajo ejecutado: es el mismo trabajo y no tiene por que haber dos.
 */
export function cambiosDeTexto(antes: string | null, despues: string | null): Trozo[][][] {
  const pasos = alinear(renglones(antes ?? ''), renglones(despues ?? ''));

  // Cada tanda de renglones distintos entre dos iguales.
  const tandas: { quitados: string[]; agregados: string[] }[] = [];
  let abierta: { quitados: string[]; agregados: string[] } | null = null;
  for (const p of pasos) {
    if (p.tipo === 'igual') {
      abierta = null;
      continue;
    }
    if (!abierta) {
      abierta = { quitados: [], agregados: [] };
      tandas.push(abierta);
    }
    (p.tipo === 'quitado' ? abierta.quitados : abierta.agregados).push(p.valor);
  }

  const grupos: Trozo[][][] = [];
  for (const { quitados, agregados } of tandas) {
    // Cada renglon quitado se empareja, en orden, con el primer renglon nuevo
    // que se le parezca: es quien corrigio unas palabras. En la misma tanda
    // puede haber ademas renglones nuevos de verdad —corregir un numero del
    // parrafo y agregar una actividad debajo, en el mismo guardado—, y sin
    // emparejar asi el parrafo entero salia tachado y reescrito.
    const editados = new Map<number, Trozo[]>();
    const sueltos: string[] = [];
    let desde = 0;
    for (const q of quitados) {
      let hallado = -1;
      for (let i = desde; i < agregados.length && hallado < 0; i += 1) {
        const editado = renglonEditado(q, agregados[i]);
        if (editado) {
          editados.set(i, editado);
          hallado = i;
        }
      }
      if (hallado < 0) sueltos.push(q);
      else desde = hallado + 1;
    }

    // Un renglon cambiado por otro muy distinto: el viejo y el nuevo, enteros,
    // cuentan como un solo cambio.
    if (quitados.length === 1 && agregados.length === 1 && editados.size === 0) {
      grupos.push([[trozo('quitado', quitados[0])], [trozo('agregado', agregados[0])]]);
      continue;
    }
    for (const q of sueltos) grupos.push([[trozo('quitado', q)]]);
    agregados.forEach((a, i) => grupos.push([editados.get(i) ?? [trozo('agregado', a)]]));
  }
  return grupos;
}

/** Un valor corto —el clima, un numero, una fila de equipo— como se lee. */
function valorCorto(campo: string, v: string | number): string {
  const s = String(v);
  if (campo === 'fecha' && /^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, d] = s.split('-').map(Number);
    return `${d} ${MESES[m - 1]} ${y}`;
  }
  return s;
}

/**
 * El orden en que se leen los campos: el del formulario, despues las filas, y
 * las leyendas al final, junto a las fotos.
 */
function orden(campo: string): number {
  const i = Object.keys(CAMPO_LABELS).indexOf(campo);
  if (i >= 0) return i;
  if (campo.startsWith('puesto:')) return 100;
  if (campo.startsWith('equipo:')) return 200;
  if (campo.startsWith('leyenda:')) return 400;
  return 300;
}

/** Un campo cambiado, listo para dibujar; null si al final no se ve ningun cambio. */
function cambioLegible(campo: string, c: Cambio): CambioLegible | null {
  // Una leyenda es un texto corto: se marca palabra por palabra, como un
  // renglon de Trabajo ejecutado. «Acero de columna C-4» a «… C-5» sale con
  // solo el numero tachado y el nuevo subrayado.
  if (CAMPOS_DE_TEXTO.has(campo) || campo.startsWith('leyenda:')) {
    const grupos = cambiosDeTexto(
      c.antes === null ? null : String(c.antes),
      c.despues === null ? null : String(c.despues),
    );
    if (grupos.length === 0) return null;
    const ocultos = grupos.length - MAX_CAMBIOS;
    const renglonesVisibles = grupos.slice(0, MAX_CAMBIOS).flat();
    if (ocultos > 0) {
      renglonesVisibles.push([
        trozo('nota', `y ${ocultos} ${ocultos === 1 ? 'cambio más' : 'cambios más'} en este texto`),
      ]);
    }
    return { etiqueta: c.label, renglones: renglonesVisibles };
  }

  // Una entrega se nombra dentro del renglon: sin cantidad no habria que marcar.
  if (campo.startsWith('entrega:')) {
    const con = (v: string | number) => (v === '—' ? c.label : `${c.label} · ${v}`);
    const renglon = c.antes === null
      ? [trozo('agregado', con(c.despues!))]
      : c.despues === null
        ? [trozo('quitado', con(c.antes))]
        : [trozo('igual', c.label), trozo('quitado', String(c.antes)), trozo('agregado', String(c.despues))];
    return { etiqueta: 'Entregas', renglones: [renglon] };
  }

  const renglon: Trozo[] = [];
  if (c.antes !== null) renglon.push(trozo('quitado', valorCorto(campo, c.antes)));
  if (c.despues !== null) renglon.push(trozo('agregado', valorCorto(campo, c.despues)));
  return { etiqueta: c.label, renglones: [renglon] };
}

/**
 * Una correccion entera, lista para dibujar: los campos en el orden del
 * formulario y las fotos al final. Vacia quiere decir que el guardado no movio
 * nada que se vea, y esa correccion no se muestra.
 *
 * Las fotos se cuentan y no se nombran: desde un iPhone casi todas se llaman
 * «image.jpg», y el nombre no le dice nada a nadie.
 */
export function legibleCorreccion(c: ContenidoCorreccion): CambioLegible[] {
  const salida = Object.entries(c.cambios)
    .sort(([a], [b]) => orden(a) - orden(b))
    .map(([campo, cambio]) => cambioLegible(campo, cambio))
    .filter((x): x is CambioLegible => x !== null);

  const fotos: Trozo[][] = [];
  const agregadas = c.fotos_agregadas.length;
  const quitadas = c.fotos_quitadas.length;
  if (agregadas > 0) {
    fotos.push([trozo('igual', agregadas === 1 ? 'se agregó 1' : `se agregaron ${agregadas}`)]);
  }
  if (quitadas > 0) {
    fotos.push([trozo('igual', quitadas === 1 ? 'se quitó 1' : `se quitaron ${quitadas}`)]);
  }
  if (fotos.length > 0) salida.push({ etiqueta: 'Fotos', renglones: fotos });

  return salida;
}
