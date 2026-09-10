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

/** Una linea legible por cambio, para el PDF y la pantalla. */
export function describirCambios(cambios: Record<string, Cambio>): string {
  const partes = Object.values(cambios).map((c) => {
    if (c.antes === null) return `se agregó ${c.label}`;
    if (c.despues === null) return `se quitó ${c.label}`;
    return `${c.label} de ${c.antes} a ${c.despues}`;
  });
  return partes.join(' · ');
}
