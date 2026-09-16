/**
 * El consorcio de un proyecto: lo que hace que el reporte diario salga con su
 * nombre y su logo en vez de los de Pinellas.
 *
 * - Si el proyecto es en consorcio: proyectos.datos_adicionales.es_consorcio.
 * - El nombre: proyectos.contratista, obligatorio en un consorcio.
 * - El logo: proyectos.logo_consorcio (migracion 165), un data URL.
 */

import sharp from 'sharp';
import { query } from '../database/config.js';

/** El consorcio que ejecuta el proyecto. logo: data URL, o null si no se ha subido. */
export interface Consorcio {
  nombre: string;
  logo: string | null;
}

/**
 * La columna es_consorcio, leida de la fila `p` de proyectos. El formulario la
 * guarda como booleano JSON; cualquier otra cosa, o nada, es «no».
 */
export const ES_CONSORCIO_SQL =
  `COALESCE(p.datos_adicionales->'es_consorcio' = 'true'::jsonb, false)`;

/**
 * Lo que la fila del proyecto dice del consorcio; null si el proyecto no es en
 * consorcio.
 *
 * Un proyecto de antes de que Contratista fuera obligatorio podria tenerlo
 * vacio: entonces dice «Consorcio», que al menos no es falso, en vez de volver
 * a decir Pinellas.
 */
export function consorcioDelProyecto(p: {
  es_consorcio: boolean | null;
  contratista: string | null;
  logo_consorcio?: string | null;
}): Consorcio | null {
  if (!p.es_consorcio) return null;
  return {
    nombre: p.contratista?.trim() || 'Consorcio',
    logo: p.logo_consorcio ?? null,
  };
}

/** Como se llama la cuadrilla propia, en el papel y en la pantalla. */
export const nombrePropio = (c: Consorcio | null | undefined): string =>
  c?.nombre ?? 'Pinellas';

/** Quien emite el papel, al pie de cada pagina del reporte. */
export const nombreEmisor = (c: Consorcio | null | undefined): string =>
  c?.nombre ?? 'Pinellas, S.A.';

/** El nombre de la cuadrilla propia de un proyecto, para las pantallas del reporte. */
export async function leerNombrePropio(proyectoId: number | string): Promise<string> {
  const r = await query<{ es_consorcio: boolean; contratista: string | null }>(
    `SELECT ${ES_CONSORCIO_SQL} AS es_consorcio, p.contratista
       FROM proyectos p WHERE p.id = $1`,
    [proyectoId],
  );
  return nombrePropio(r.rows[0] ? consorcioDelProyecto(r.rows[0]) : null);
}

// ---------------------------------------------------------------------------
// El logo
// ---------------------------------------------------------------------------

/**
 * Tope de lo que se acepta del navegador. El formulario ya corta en ~400 KB
 * (el mismo tope que EditorLogos en las hojas de impresion); esto es la red
 * por si alguien llama a la API sin pasar por el.
 */
const ENTRADA_MAX = 600 * 1024;

/**
 * La caja donde se reduce. El reporte lo imprime a 36px de alto: 200px son mas
 * de 500 puntos por pulgada en el papel, y subir de ahi no se ve, solo pesa.
 * El ancho deja pasar los logos apaisados, que son casi todos.
 */
const CAJA_ANCHO = 800;
const CAJA_ALTO = 200;

const DATA_URL = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i;

export type LogoNormalizado =
  | { ok: true; dataUrl: string }
  | { ok: false; mensaje: string };

/**
 * Valida el logo que llega del formulario y lo devuelve reducido, como PNG.
 *
 * Se guarda reducido porque la fila del proyecto viaja entera cada vez que
 * alguien abre el proyecto. PNG y no JPEG porque un logo casi siempre tiene
 * fondo transparente, y JPEG lo pintaria de negro. Con paleta: un logo son
 * pocos colores planos, y asi pesa decenas de KB.
 */
export async function normalizarLogoConsorcio(
  entrada: string,
): Promise<LogoNormalizado> {
  if (entrada.length > ENTRADA_MAX) {
    return {
      ok: false,
      mensaje: 'El logo es demasiado grande (máx. ~400 KB). Usa una imagen más liviana.',
    };
  }

  const partes = DATA_URL.exec(entrada);
  if (!partes) {
    return { ok: false, mensaje: 'El logo debe ser una imagen.' };
  }

  const esSvg = partes[1].toLowerCase() === 'image/svg+xml';
  const bytes = Buffer.from(partes[2], 'base64');

  try {
    // Un SVG no tiene pixeles: se dibuja a 300 ppp para que la reduccion
    // parta de una imagen nitida y no de una de 96 ppp.
    const png = await sharp(bytes, esSvg ? { density: 300 } : {})
      .rotate()
      .resize(CAJA_ANCHO, CAJA_ALTO, { fit: 'inside', withoutEnlargement: true })
      .png({ palette: true, compressionLevel: 9 })
      .toBuffer();
    return { ok: true, dataUrl: `data:image/png;base64,${png.toString('base64')}` };
  } catch {
    return { ok: false, mensaje: 'No se pudo leer la imagen del logo. Prueba con un PNG o JPG.' };
  }
}
