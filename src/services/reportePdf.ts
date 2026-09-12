/**
 * El PDF del reporte diario.
 *
 * Se arma con Puppeteer y no con PDFKit como generateSolicitudPDF, porque este
 * documento lleva una rejilla de fotos que fluye entre páginas; dibujarla
 * coordenada por coordenada seria mucho mas trabajo y mucho mas fragil.
 *
 * Los colores y las medidas salen de pdfGenerator.ts para que este papel se
 * vea como los que la empresa ya emite.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer, { Browser } from 'puppeteer';
import type { LaunchOptions } from 'puppeteer';
import sharp from 'sharp';
import { downloadFile } from './storage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const NAVY = '#1a365d';
const GRAY = '#718096';
const LIGHT_BG = '#f7fafc';
const RULE = '#e2e8f0';
const WARN = '#d97706';

export interface ReportePdfInput {
  numero: string;
  fechaLarga: string;
  fechaCorta: string;
  proyectoNombre: string;
  autorNombre: string;
  clima: string;
  horasPerdidas: number | null;
  motivo: string | null;
  personalCalificado: number;
  ayudantes: number;
  equipo: string[];
  // Las filas. Un reporte de antes del cambio las trae vacias y se imprime
  // con los dos numeros de arriba, que se quedaron en su sitio.
  personal: { nombre: string; empresa: string | null; cantidad: number }[];
  equipos: { nombre: string; unidades: number; horas: number }[];
  entregas: {
    categoria: string; descripcion: string;
    cantidad: number | null; unidad: string | null; notas: string | null;
  }[];
  areas: string[];
  queSeHizo: string;
  atrasos: string | null;
  novedades: string | null;
  fotos: { r2_key: string; nombre_archivo: string; tipo_mime: string | null }[];
  correcciones: { cuando: string; quien: string; que: string }[];
}

function esc(s: string): string {
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
 * (20 MB) salen en 2 s, 12 fotos (31 MB) no salen ni en 180 s. Tumbaba tanto el
 * envio por correo como el boton de ver el PDF, y sin decir por que.
 */
async function incrustarFotos(
  fotos: ReportePdfInput['fotos'],
): Promise<{ lista: { src: string; pie: string }[]; omitidas: number }> {
  const lista: { src: string; pie: string }[] = [];
  let peso = 0;
  let omitidas = 0;
  let msBajar = 0;
  let msReducir = 0;

  for (const f of fotos) {
    let bytes: Buffer;
    const t0 = Date.now();
    try {
      bytes = await downloadFile(f.r2_key);
    } catch {
      // Una foto que ya no esta no puede hundir el reporte entero.
      continue;
    }
    msBajar += Date.now() - t0;

    let mime = f.tipo_mime || 'image/jpeg';
    const t1 = Date.now();
    try {
      bytes = await sharp(bytes)
        .rotate() // respeta como venia girado el celular
        .resize(FOTO_LADO_MAX, FOTO_LADO_MAX, {
          fit: 'inside',
          withoutEnlargement: true,
        })
        .jpeg({ quality: 82 })
        .toBuffer();
      mime = 'image/jpeg';
    } catch (err) {
      console.error(`[reportePdf] no se pudo reducir ${f.r2_key}:`, err);
    }
    msReducir += Date.now() - t1;

    // Techo de peso. Con la reduccion funcionando nunca se alcanza: 20 fotos
    // pesan unos 9 MB. Es la red por si sharp falla, para no volver al cuelgue:
    // vale mas un reporte que avisa que le faltan fotos que uno que no sale.
    const src = `data:${mime};base64,${bytes.toString('base64')}`;
    if (peso + src.length > FOTOS_PESO_MAX) {
      omitidas++;
      continue;
    }
    peso += src.length;
    lista.push({ src, pie: f.nombre_archivo });
  }

  if (omitidas > 0) {
    console.error(
      `[reportePdf] ${omitidas} foto(s) quedaron fuera del PDF por peso`,
    );
  }
  if (fotos.length) {
    console.log(
      `[reportePdf] ${lista.length} foto(s): bajar ${msBajar} ms, reducir ${msReducir} ms, ${(peso / 1024 / 1024).toFixed(1)} MB al documento`,
    );
  }
  return { lista, omitidas };
}

function armarHtml(
  d: ReportePdfInput,
  fotos: { src: string; pie: string }[],
  logo: string,
  omitidas: number,
): string {
  const emitido = new Date().toLocaleString('es-PA', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

  const horas =
    d.horasPerdidas && d.horasPerdidas > 0
      ? `<span style="color:${WARN}">${d.horasPerdidas} h</span>`
      : '0 h';

  // Si alguna quedo fuera se dice en el papel, no solo en el log: quien lea
  // el reporte tiene que saber que no esta viendo todo lo que se subio.
  const aviso = omitidas
    ? ` · <span style="color:${WARN}">${omitidas} no se pudieron incluir</span>`
    : '';
  const bloqueFotos = fotos.length || omitidas
    ? `<div class="sect"><div class="sect-h">Fotos del día · ${fotos.length}${aviso}</div>
         <div class="shots">${fotos
           .map(
             (f, i) =>
               `<figure class="shot"><img src="${f.src}" alt="">
                  <figcaption>${i + 1}. ${esc(f.pie)}</figcaption></figure>`,
           )
           .join('')}</div></div>`
    : '';

  const bloqueCorrecciones = d.correcciones.length
    ? `<div class="sect"><div class="sect-h">Correcciones</div>
         <table class="fixes">${d.correcciones
           .map(
             (c) =>
               `<tr><td class="when">${esc(c.cuando)}</td>
                    <td class="who">${esc(c.quien)}</td>
                    <td>${esc(c.que)}</td></tr>`,
           )
           .join('')}</table></div>`
    : '';

  // Las filas en cero no se imprimen: es la regla acordada. Un reporte con
  // veinte puestos posibles y cuatro usados imprime cuatro lineas.
  const bloquePersonal = (r: ReportePdfInput): string => {
    if (r.personal.length === 0) {
      // Un reporte de antes del cambio: se imprime como se imprimia.
      const total = r.personalCalificado + r.ayudantes;
      if (total === 0) return '';
      return `<div class="sect"><div class="sect-h">Personal</div><div class="sect-b">
        <div class="cols">
          <div><div class="k">Personal calificado</div><div class="v">${r.personalCalificado}</div></div>
          <div><div class="k">Ayudantes</div><div class="v">${r.ayudantes}</div></div>
          <div><div class="k">Total en obra</div><div class="v">${total}</div></div>
        </div></div></div>`;
    }

    const grupos = [...new Set(r.personal.map((f) => f.empresa))];
    const total = r.personal.reduce((n, f) => n + f.cantidad, 0);
    const cuerpoGrupos = grupos
      .map((g) => {
        const filas = r.personal
          .filter((f) => f.empresa === g)
          .map((f) => `<tr><td>${esc(f.nombre)}</td><td class="n">${f.cantidad}</td></tr>`)
          .join('');
        // El nombre del bloque solo aparece cuando hay con quien confundirlo.
        const titulo = grupos.length > 1
          ? `<div class="grupo">${esc(g ?? 'Pinellas')}</div>`
          : '';
        return `<div>${titulo}<table class="filas">${filas}</table></div>`;
      })
      .join('');

    return `<div class="sect"><div class="sect-h">Personal</div><div class="sect-b">
      ${cuerpoGrupos}
      <div class="suma"><span>Total en obra</span><b>${total}</b></div>
    </div></div>`;
  };

  const bloqueEquipo = (r: ReportePdfInput): string => {
    if (r.equipos.length === 0) {
      // Reporte viejo: su lista de texto sigue valiendo.
      if (r.equipo.length === 0) return '';
      return `<div class="sect"><div class="sect-h">Equipo</div><div class="sect-b">
        <div class="prose"><p>${esc(r.equipo.join(' · '))}</p></div></div></div>`;
    }
    const filasEquipo = r.equipos
      .map((f) => `<tr><td>${esc(f.nombre)}</td>
                       <td class="n">${f.unidades} u</td>
                       <td class="n">${f.horas} h</td></tr>`)
      .join('');
    return `<div class="sect"><div class="sect-h">Equipo</div><div class="sect-b">
      <table class="filas">${filasEquipo}</table></div></div>`;
  };

  const bloqueEntregas = (r: ReportePdfInput): string => {
    if (r.entregas.length === 0) return '';
    const filas = r.entregas
      .map((f) => {
        const cuanto = [f.cantidad ?? '', f.unidad ?? '']
          .filter((x) => String(x) !== '')
          .join(' ');
        const notas = f.notas ? `<span class="nota">${esc(f.notas)}</span>` : '';
        return `<tr><td>${esc(f.descripcion)}
                     <span class="cat">${esc(f.categoria.toLowerCase())}</span>
                     ${notas}</td>
                 <td class="n">${esc(cuanto)}</td></tr>`;
      })
      .join('');
    return `<div class="sect"><div class="sect-h">Entregas</div><div class="sect-b">
      <table class="filas">${filas}</table></div></div>`;
  };

  /**
   * Personal a la izquierda; Equipo y Entregas a la derecha.
   *
   * Si la derecha viene vacia —un dia sin equipo ni entregas— Personal ocupa
   * el ancho entero: media hoja en blanco al lado se ve peor que el vacio que
   * esto vino a resolver.
   */
  const columnasFilas = (r: ReportePdfInput): string => {
    const izq = bloquePersonal(r);
    const der = bloqueEquipo(r) + bloqueEntregas(r);
    if (!der) return izq;
    if (!izq) return der;
    return `<div class="par-sect"><div>${izq}</div><div>${der}</div></div>`;
  };

  const texto = (v: string | null, vacio: string) =>
    v ? `<p>${esc(v)}</p>` : `<p class="none">${vacio}</p>`;

  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><style>
    /* Los tamanos van en px porque Chrome compone la pagina, pero la vara es
       el reporte impreso: 1px = 0.75pt. El cuerpo a 12.5px son 9.4pt, que es
       donde estaba el reporte que Ivan puso de referencia; antes estaba en
       10px = 7.5pt y se leia chico. El h1 se queda en 17px (12.75pt) a
       proposito: ya coincidia, y subirlo aplastaria la proporcion con el
       cuerpo, que en la referencia es de 1.37. */
    /* ---------------------------------------------------------------------
       UNA SOLA REGLA DE RAYAS. Todo el ritmo vertical va en multiplos de 4px.
       No es manía: 1px de CSS son 0.75pt en el PDF, así que una raya solo cae
       en una coordenada entera de puntos cuando su posicion es multiplo de 4.
       Si cae en 24.75px, el visor la reparte entre dos filas de pixeles y se
       lee como un borde doble o mas grueso que el de al lado. Por eso los
       interlineados van en px enteros y no en 1.5, y por eso el recuadro de
       arriba es una tabla con bordes fusionados: dos celdas vecinas comparten
       UNA raya y es imposible que se dupliquen.
       Al tocar esta hoja, mantener las alturas en multiplos de 4.
       --------------------------------------------------------------------- */
    * { box-sizing: border-box; }
    body { margin:0; font-family: Arial, Helvetica, sans-serif; color:#000;
           font-size:12.5px; line-height:16px; }
    .head { display:flex; align-items:flex-start; justify-content:space-between; }
    .logo { height:36px; }
    .doc-kind { font-size:13px; line-height:16px; font-weight:700; letter-spacing:.13em;
                text-transform:uppercase; color:${NAVY}; text-align:right; }
    .doc-id { font-size:11px; line-height:16px; color:${GRAY}; text-align:right; }
    .rule { height:2px; background:${NAVY}; margin-top:12px; }
    h1 { font-size:17px; line-height:24px; color:${NAVY}; margin:16px 0 0; }
    /* Tabla, no flex: con border-collapse las celdas vecinas comparten la
       misma raya, asi que ninguna puede salir doble. */
    .meta { margin-top:16px; width:100%; border-collapse:collapse;
            background:${LIGHT_BG}; }
    .meta td { border:1px solid ${RULE}; padding:8px 12px; width:33.33%;
               vertical-align:top; }
    .k { font-size:9.5px; line-height:12px; font-weight:700; letter-spacing:.07em;
         text-transform:uppercase; color:${GRAY}; }
    .v { font-size:12.5px; line-height:16px; font-weight:700; }
    .sect { margin-top:16px; page-break-inside:avoid; }
    .sect-h { font-size:10.5px; line-height:12px; font-weight:700; letter-spacing:.11em;
              text-transform:uppercase; color:#fff; background:${NAVY};
              padding:6px 9px; border-radius:2px; }
    .sect-b { padding:12px 2px 0; }
    .cols { display:flex; gap:12px; }
    .cols > div { flex:1; }
    .cols > div.ancho { flex:2; }
    .prose { margin-top:12px; }
    .prose p { margin:0; font-size:13px; line-height:20px; white-space:pre-wrap; }
    .none { color:${GRAY}; font-style:italic; }
    /* Tope de ALTO, no de ancho, y nada de recortar.
     *
     * Una foto de celular llega en vertical u horizontal, y a la misma anchura
     * de columna la vertical mide casi el doble de alto: cuatro verticales
     * ocupaban dos paginas enteras mientras cuatro horizontales cabian en una.
     * Con el tope, la vertical se reduce —sale mas estrecha y centrada, pero
     * COMPLETA— y la horizontal ni se entera porque ya es mas baja que el tope.
     *
     * 4.2in sale de la hoja carta: 9.9in de alto util menos el titulo de la
     * seccion, partido en dos filas con su pie y su separacion. Da 4 verticales
     * por pagina, o 6 horizontales. Subirlo devuelve el problema; bajarlo
     * empequeñece las fotos sin ganar ninguna fila.
     */
    .shots { display:flex; flex-wrap:wrap; gap:12px; padding-top:10px; }
    .shot { width:calc(50% - 6px); margin:0; page-break-inside:avoid; text-align:center; }
    .shot img { max-width:100%; max-height:4.2in; width:auto; height:auto;
                border:1px solid ${RULE}; border-radius:2px; }
    .shot figcaption { font-size:10px; color:${GRAY}; margin-top:3px; text-align:center; }
    /* Las tablas de filas: nombre a la izquierda y numeros a la derecha,
       alineados en columna, como en la pantalla.
       Personal va en una columna y Equipo con Entregas en la otra: a lo ancho
       de una hoja carta, una lista de nombres cortos con su numero pegado al
       borde derecho deja un vacio enorme en medio. */
    .par-sect { display:flex; gap:20px; align-items:flex-start; margin-top:16px; }
    .par-sect > div { flex:1; min-width:0; }
    .par-sect .sect { margin-top:0; }
    .par-sect .sect + .sect { margin-top:16px; }
    /* Fila de 24px: 16 de interlineado y 4 arriba y abajo. Multiplo de 4, que
       es lo que mantiene cada raya en una coordenada entera. */
    .filas { width:100%; border-collapse:collapse; font-size:12.5px; }
    .filas td { padding:4px 0; line-height:16px; border-bottom:1px solid ${RULE}; }
    .filas tr:last-child td { border-bottom:0; }
    .filas .n { text-align:right; width:64px; font-variant-numeric:tabular-nums; }
    /* La categoria va en linea, dentro del mismo renglon de 16px, para que no
       cambie la altura de la fila. Las notas si bajan, en su propia linea de
       12px: 24 + 12 = 36, que sigue siendo multiplo de 4. */
    .filas .cat { color:${GRAY}; font-size:11px; line-height:16px; }
    .filas .nota { display:block; color:${GRAY}; font-size:11px; line-height:12px; }
    .grupo { font-size:10px; line-height:12px; font-weight:700; letter-spacing:.09em;
             text-transform:uppercase; color:${NAVY}; padding-top:12px; }
    .suma { display:flex; justify-content:space-between; border-top:1px solid ${RULE};
            margin-top:4px; padding-top:8px; font-size:12.5px; line-height:16px; }
    .suma b { font-size:14px; }
    .fixes { width:100%; border-collapse:collapse; font-size:11.5px; margin-top:10px; }
    .fixes td { padding:5px 9px; border:1px solid ${RULE}; vertical-align:top; }
    .fixes .when { width:130px; color:${GRAY}; white-space:nowrap; }
    .fixes .who { width:120px; font-weight:700; white-space:nowrap; }
  </style></head><body>
    <div class="head">
      ${logo ? `<img class="logo" src="${logo}" alt="Pinellas">` : '<span></span>'}
      <div>
        <div class="doc-kind">Reporte diario de obra</div>
        <div class="doc-id">${esc(d.numero)} · emitido ${esc(emitido)}</div>
      </div>
    </div>
    <div class="rule"></div>

    <h1>${esc(d.fechaLarga)}</h1>

    <table class="meta"><tr>
      <td><div class="k">Proyecto</div><div class="v">${esc(d.proyectoNombre)}</div></td>
      <td><div class="k">Elaborado por</div><div class="v">${esc(d.autorNombre)}</div></td>
      <td><div class="k">Fecha</div><div class="v">${esc(d.fechaCorta)}</div></td>
    </tr></table>

    <div class="sect"><div class="sect-h">Clima</div><div class="sect-b"><div class="cols">
      <div><div class="k">Clima</div><div class="v">${esc(d.clima)}</div></div>
      <div><div class="k">Horas perdidas</div><div class="v">${horas}</div></div>
      <div class="ancho"><div class="k">Motivo</div>
        <div class="v" style="font-weight:400">${d.motivo ? esc(d.motivo) : '—'}</div></div>
    </div></div></div>

    <div class="sect"><div class="sect-h">Trabajo ejecutado</div><div class="sect-b">
      <div class="prose"><div class="k">Áreas de trabajo</div>
        ${texto(d.areas.length ? d.areas.join(' · ') : null, 'No se indicaron áreas')}</div>
      <div class="prose"><p>${esc(d.queSeHizo)}</p></div>
      <div class="prose"><div class="k">Atrasos o impedimentos</div>
        ${texto(d.atrasos, 'Sin atrasos reportados')}</div>
      <div class="prose"><div class="k">Novedades del día</div>
        ${texto(d.novedades, 'Sin novedades')}</div>
    </div></div>

    ${columnasFilas(d)}

    ${bloqueFotos}
    ${bloqueCorrecciones}
  </body></html>`;
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

export async function generateReportePDF(d: ReportePdfInput): Promise<Buffer> {
  let logo = '';
  try {
    const ruta = path.resolve(__dirname, '../../templates/LogoPinellas.png');
    logo = 'data:image/png;base64,' + fs.readFileSync(ruta).toString('base64');
  } catch {
    // Sin logo el documento se sigue emitiendo.
  }

  const { lista: fotos, omitidas } = await incrustarFotos(d.fotos);
  const html = armarHtml(d, fotos, logo, omitidas);

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
          <span>Pinellas, S.A. — Reporte diario de obra</span>
          <span>Página <span class="pageNumber"></span> de <span class="totalPages"></span></span>
        </div>`,
    });
    console.log(`[reportePdf] navegador ${Date.now() - tRender} ms`);
    return Buffer.from(pdf);
  } finally {
    if (browser) await browser.close();
  }
}
