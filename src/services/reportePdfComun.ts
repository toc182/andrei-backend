/**
 * Lo que comparten los PDF de los reportes de obra: el diario y el semanal.
 *
 * Los dos papeles se arman igual —Puppeteer sobre un HTML— y tropiezan con las
 * mismas cosas: las fotos pesan, el navegador sin ventana necesita sus banderas
 * en Railway, y la hora tiene que salir en la de Panamá pase lo que pase con la
 * del servidor. Todo eso vive aquí una sola vez.
 *
 * Los colores y las medidas son los de pdfGenerator.ts, para que estos papeles
 * se vean como los que la empresa ya emite.
 */

import fs from 'fs';
import path from 'path';
import puppeteer, { Browser } from 'puppeteer';
import type { LaunchOptions } from 'puppeteer';
import sharp from 'sharp';
import { downloadFile, uploadFile } from './storage.js';

export const NAVY = '#1a365d';
export const GRAY = '#718096';
export const LIGHT_BG = '#f7fafc';
export const RULE = '#e2e8f0';
export const WARN = '#d97706';

/**
 * Las horas del papel van en la de Panamá, pase lo que pase con la del servidor.
 *
 * Railway corre en UTC: sin esto, el reporte que Cesar mando el 15 de
 * septiembre a las 9:04 de la noche salio «emitido 16 sept 2026, 2:04 a. m.».
 */
export const HORA_PANAMA = { timeZone: 'America/Panama' } as const;

export function esc(s: string): string {
  return String(s).replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!,
  );
}

/**
 * Lado largo al que se reduce cada foto, y techo de peso del bloque ya
 * codificado.
 *
 * La rejilla imprime dos fotos por fila en papel carta: cada una ocupa unas
 * 3.6 pulgadas, asi que 1400px son casi 400 puntos por pulgada. Subir de ahi
 * no se ve en el papel, solo pesa.
 */
const FOTO_LADO_MAX = 1400;
const FOTOS_PESO_MAX = 12 * 1024 * 1024;

/**
 * Donde vive la copia reducida de una foto, derivada de la clave del original.
 *
 * Se calcula en vez de guardarse en una columna: la copia es un derivado puro
 * del original, no un dato del negocio. Si algun dia se decide otro tamano,
 * basta cambiar el sufijo y las viejas se regeneran solas la primera vez que
 * alguien pida el PDF.
 */
export function claveReducida(r2Key: string): string {
  return `${r2Key}.r${FOTO_LADO_MAX}.jpg`;
}

/** Reduce una foto al tamano con el que entra al PDF. */
export async function reducirFoto(bytes: Buffer): Promise<Buffer> {
  return sharp(bytes)
    .rotate() // respeta como venia girado el celular
    .resize(FOTO_LADO_MAX, FOTO_LADO_MAX, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: 82 })
    .toBuffer();
}

/**
 * Si la foto es mas ancha que alta, como se ve.
 *
 * La copia reducida ya viene derecha; un original sin reducir (el camino de
 * rescate) puede traer el giro solo en su EXIF, y el navegador lo respeta al
 * dibujarla, asi que aqui tambien. Si no se puede leer, se trata como vertical,
 * que es el tope que nunca parte una fila.
 */
async function esHorizontal(bytes: Buffer): Promise<boolean> {
  try {
    const m = await sharp(bytes).metadata();
    const girada = (m.orientation ?? 1) >= 5;
    const ancho = (girada ? m.height : m.width) ?? 0;
    const alto = (girada ? m.width : m.height) ?? 0;
    return ancho > alto;
  } catch {
    return false;
  }
}

/** Una foto del reporte, tal como llega de la base. */
export interface FotoDelReporte {
  r2_key: string;
  nombre_archivo: string;
  tipo_mime: string | null;
  leyenda?: string | null;
}

/**
 * Una foto lista para el papel. `numero` es el suyo en el reporte, no su
 * puesto en esta lista: si una no se pudo incluir, las demas conservan el
 * numero con que se las nombra en la pantalla.
 */
export interface FotoIncrustada {
  src: string;
  numero: number;
  leyenda: string | null;
  horizontal: boolean;
}

/** El pie de una foto en el papel: «3. Acero de columna C-4», o «3.» sin leyenda. */
export function pieDeFoto(numero: number, leyenda: string | null): string {
  return leyenda ? `${numero}. ${leyenda}` : `${numero}.`;
}

/**
 * Las fotos van incrustadas como datos, no como direcciones.
 *
 * El PDF se arma desde una cadena de texto con setContent: una direccion
 * firmada de R2 obligaria al navegador sin ventana a salir a buscarla, y esas
 * direcciones ademas vencen. Se traen los bytes y se meten en el documento.
 *
 * Y se reducen antes de meterlos, que es lo que rompio en produccion el
 * 2026-09-10. Una foto de celular pesa unos 2 MB, y setContent no aguanta una
 * cadena enorme: pasado cierto punto no tarda mas, se cuelga y no vuelve, hasta
 * que Puppeteer se rinde a los 30 segundos. Medido: 8 fotos a tamano original
 * (20 MB) salen en 2 s, 12 fotos (31 MB) no salen ni en 180 s.
 */
export async function incrustarFotos(
  fotos: FotoDelReporte[],
): Promise<{ lista: FotoIncrustada[]; omitidas: number }> {
  const lista: FotoIncrustada[] = [];
  let peso = 0;
  let omitidas = 0;
  let msBajar = 0;
  let msReducir = 0;
  let regeneradas = 0;

  // Las copias reducidas, todas de golpe y en tandas.
  //
  // Aqui el orden importa: mientras se bajaban los ORIGINALES esto no servia de
  // nada, porque lo que mandaba eran los 29 MB y el ancho de banda no se
  // reparte. Con las copias son 4 MB, y entonces lo que pesa son las idas y
  // vueltas — doce de ellas.
  //
  // Tandas de seis, no todas a la vez, para que la memoria no dependa de
  // cuantas fotos traiga el reporte.
  const TANDA = 6;
  const reducidas: (Buffer | null)[] = [];
  const t0 = Date.now();
  for (let i = 0; i < fotos.length; i += TANDA) {
    const tanda = await Promise.all(
      fotos.slice(i, i + TANDA).map((f) =>
        // Que no exista es lo normal en una foto de antes de este cambio; se
        // rescata abajo.
        downloadFile(claveReducida(f.r2_key)).catch(() => null),
      ),
    );
    reducidas.push(...tanda);
  }
  msBajar = Date.now() - t0;

  for (const [indice, f] of fotos.entries()) {
    let bytes: Buffer | null = reducidas[indice];
    let mime = 'image/jpeg';

    if (!bytes) {
      // Camino de rescate para las fotos viejas: se baja el original, se
      // reduce, y se guarda la copia para que la proxima vez ya este. Asi el
      // sistema se pone al dia solo, sin una pasada de migracion por encima de
      // miles de fotos.
      const t1 = Date.now();
      let original: Buffer;
      try {
        original = await downloadFile(f.r2_key);
      } catch {
        // Una foto que ya no esta no puede hundir el reporte entero.
        continue;
      }
      msBajar += Date.now() - t1;

      const t2 = Date.now();
      try {
        bytes = await reducirFoto(original);
        regeneradas += 1;
        // Guardar la copia es un extra: si falla, el PDF sale igual y la
        // proxima vez se vuelve a intentar.
        void uploadFile(claveReducida(f.r2_key), bytes, 'image/jpeg').catch(
          (err: unknown) => {
            console.error(`[reportePdf] no se pudo archivar la copia de ${f.r2_key}:`, err);
          },
        );
      } catch (err) {
        console.error(`[reportePdf] no se pudo reducir ${f.r2_key}:`, err);
        bytes = original;
        mime = f.tipo_mime || 'image/jpeg';
      }
      msReducir += Date.now() - t2;
    }

    // Techo de peso. Con la reduccion funcionando nunca se alcanza: 20 fotos
    // pesan unos 9 MB. Es la red por si sharp falla, para no volver al cuelgue:
    // vale mas un reporte que avisa que le faltan fotos que uno que no sale.
    const src = `data:${mime};base64,${bytes.toString('base64')}`;
    if (peso + src.length > FOTOS_PESO_MAX) {
      omitidas++;
      continue;
    }
    peso += src.length;
    // El pie es la leyenda, no el nombre del archivo: desde un iPhone casi
    // todas se llaman «image.jpg», y eso no le dice nada a quien lee.
    lista.push({
      src,
      numero: indice + 1,
      leyenda: f.leyenda ?? null,
      horizontal: await esHorizontal(bytes),
    });
  }

  if (omitidas > 0) {
    console.error(`[reportePdf] ${omitidas} foto(s) quedaron fuera del PDF por peso`);
  }
  if (fotos.length) {
    console.log(
      `[reportePdf] ${lista.length} foto(s): bajar ${msBajar} ms, reducir ${msReducir} ms, ${(peso / 1024 / 1024).toFixed(1)} MB al documento${regeneradas ? `, ${regeneradas} copia(s) regenerada(s)` : ''}`,
    );
  }
  return { lista, omitidas };
}

/** Copiado de routes/documents.ts:42 — Railway necesita los flags sin sandbox. */
function configPuppeteer(): LaunchOptions {
  const enProduccion =
    process.env.NODE_ENV === 'production' || !!process.env.RAILWAY_ENVIRONMENT;
  if (!enProduccion) return { headless: true };

  const config: LaunchOptions = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
    ],
  };
  const chrome =
    process.env.PUPPETEER_EXECUTABLE_PATH ||
    process.env.CHROME_BIN ||
    '/usr/bin/google-chrome';
  if (fs.existsSync(chrome)) config.executablePath = chrome;
  return config;
}

/** El logo de Pinellas, incrustado; cadena vacía si no se puede leer. */
export function logoPinellas(dirname: string): string {
  try {
    const ruta = path.resolve(dirname, '../../templates/LogoPinellas.png');
    return 'data:image/png;base64,' + fs.readFileSync(ruta).toString('base64');
  } catch {
    // Sin logo el documento se sigue emitiendo.
    return '';
  }
}

/**
 * De HTML a PDF en papel carta, con el pie de página de la empresa.
 *
 * `pieIzquierda` es lo que va abajo a la izquierda en cada hoja («Pinellas —
 * Reporte semanal de obra»); a la derecha siempre va la paginación.
 */
export async function aPdf(html: string, pieIzquierda: string): Promise<Buffer> {
  let browser: Browser | undefined;
  try {
    browser = await puppeteer.launch(configPuppeteer());
    const page = await browser.newPage();
    const tRender = Date.now();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdf = await page.pdf({
      format: 'letter',
      printBackground: true,
      margin: { top: '0.5in', right: '0.5in', bottom: '0.6in', left: '0.5in' },
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: `<div style="width:100%;padding:0 0.5in;font-family:Arial,Helvetica,sans-serif;
          font-size:9.5px;color:${GRAY};display:flex;justify-content:space-between;">
          <span>${esc(pieIzquierda)}</span>
          <span>Página <span class="pageNumber"></span> de <span class="totalPages"></span></span>
        </div>`,
    });
    console.log(`[reportePdf] navegador ${Date.now() - tRender} ms`);
    return Buffer.from(pdf);
  } finally {
    if (browser) await browser.close();
  }
}
