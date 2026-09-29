/**
 * Las columnas de las tablas de Personal y Equipo del reporte diario ya
 * terminado: una por cada cuadrilla que ese día tiene filas, con sus siglas.
 *
 * Decisión de Ivan del 2026-09-28: en el reporte terminado, Personal y Equipo
 * van como tabla con una columna por empresa, y arriba de cada columna unas
 * siglas con la clave debajo. Las siglas «por ahora» son las primeras letras
 * de las tres primeras palabras del nombre; se definirán mejor después.
 *
 * Se calculan aquí, una sola vez, para que la pantalla y el PDF digan las
 * mismas: la pantalla las recibe hechas con el reporte.
 */

/** Una cuadrilla del reporte: el bloque propio (empresa_id null) o una empresa. */
export interface ColumnaEmpresa {
  empresa_id: number | null;
  nombre: string;
  sigla: string;
}

/**
 * Las siglas de un nombre: la primera letra de cada una de sus tres primeras
 * palabras («Hermanos Rodríguez, S.A.» → HRS). Un nombre de una sola palabra
 * daría una letra suelta que no se reconoce, así que lleva sus tres primeras
 * letras («Pinellas» → PIN).
 */
export function siglaDe(nombre: string): string {
  const palabras = nombre.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (palabras.length === 0) return '?';
  const sigla = palabras.length === 1
    ? palabras[0].slice(0, 3)
    : palabras.slice(0, 3).map((p) => p[0]).join('');
  return sigla.toLocaleUpperCase('es');
}

/**
 * Las cuadrillas que tienen filas en el reporte, en orden: la propia primero y
 * luego las empresas en el orden en que llegan las filas (el de la lista del
 * proyecto). Las mismas columnas sirven para las dos tablas, así que las
 * siglas no cambian de una a otra.
 *
 * Dos empresas con las mismas siglas se distinguen con un número: HRS, HRS2.
 */
export function columnasEmpresas(
  nombrePropio: string,
  filas: { empresa_id: number | null; empresa_nombre: string | null }[],
): ColumnaEmpresa[] {
  const vistas = new Map<number | null, string>();
  if (filas.some((f) => f.empresa_id === null)) vistas.set(null, nombrePropio);
  for (const f of filas) {
    if (f.empresa_id !== null && !vistas.has(f.empresa_id)) {
      vistas.set(f.empresa_id, f.empresa_nombre ?? '');
    }
  }

  const usadas = new Map<string, number>();
  return [...vistas.entries()].map(([empresa_id, nombre]) => {
    const base = siglaDe(nombre);
    const veces = (usadas.get(base) ?? 0) + 1;
    usadas.set(base, veces);
    return { empresa_id, nombre, sigla: veces === 1 ? base : `${base}${veces}` };
  });
}
