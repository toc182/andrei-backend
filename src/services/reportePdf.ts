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
 * Las fotos van incrustadas como datos, no como direcciones.
 *
 * El PDF se arma desde una cadena de texto con setContent: una direccion
 * firmada de R2 obligaria al navegador sin ventana a salir a buscarla, y esas
 * direcciones ademas vencen. Se traen los bytes y se meten en el documento.
 */
async function incrustarFotos(
  fotos: ReportePdfInput['fotos'],
): Promise<{ src: string; pie: string }[]> {
  const salida: { src: string; pie: string }[] = [];
  for (const f of fotos) {
    try {
      const buf = await downloadFile(f.r2_key);
      salida.push({
        src: `data:${f.tipo_mime || 'image/jpeg'};base64,${buf.toString('base64')}`,
        pie: f.nombre_archivo,
      });
    } catch {
      // Una foto que ya no esta no puede hundir el reporte entero.
    }
  }
  return salida;
}

function armarHtml(
  d: ReportePdfInput,
  fotos: { src: string; pie: string }[],
  logo: string,
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

  const bloqueFotos = fotos.length
    ? `<div class="sect"><div class="sect-h">Fotos del día · ${fotos.length}</div>
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

  const texto = (v: string | null, vacio: string) =>
    v ? `<p>${esc(v)}</p>` : `<p class="none">${vacio}</p>`;

  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; }
    body { margin:0; font-family: Arial, Helvetica, sans-serif; color:#000; font-size:10px; }
    .head { display:flex; align-items:flex-start; justify-content:space-between; }
    .logo { height:34px; }
    .doc-kind { font-size:11px; font-weight:700; letter-spacing:.13em;
                text-transform:uppercase; color:${NAVY}; text-align:right; }
    .doc-id { font-size:9px; color:${GRAY}; text-align:right; margin-top:3px; }
    .rule { height:1.5px; background:${NAVY}; margin-top:10px; }
    h1 { font-size:17px; color:${NAVY}; margin:18px 0 0; }
    .meta { margin-top:14px; display:flex; background:${LIGHT_BG};
            border:1px solid ${RULE}; border-radius:3px; }
    .meta > div { flex:1; padding:8px 11px; }
    .meta > div + div { border-left:1px solid ${RULE}; }
    .k { font-size:7.5px; font-weight:700; letter-spacing:.07em;
         text-transform:uppercase; color:${GRAY}; }
    .v { font-size:10px; font-weight:700; margin-top:2px; }
    .sect { margin-top:17px; page-break-inside:avoid; }
    .sect-h { font-size:8.5px; font-weight:700; letter-spacing:.11em;
              text-transform:uppercase; color:#fff; background:${NAVY};
              padding:4px 9px; border-radius:2px; }
    .sect-b { padding:10px 2px 0; }
    .cols { display:flex; gap:12px; }
    .cols > div { flex:1; }
    .cols > div.ancho { flex:2; }
    .prose { margin-top:11px; }
    .prose p { margin:0; font-size:10.5px; line-height:1.5; white-space:pre-wrap; }
    .none { color:${GRAY}; font-style:italic; }
    .shots { display:flex; flex-wrap:wrap; gap:12px; padding-top:10px; }
    .shot { width:calc(50% - 6px); margin:0; page-break-inside:avoid; }
    .shot img { width:100%; height:auto; border:1px solid ${RULE}; border-radius:2px; }
    .shot figcaption { font-size:8.5px; color:${GRAY}; margin-top:3px; }
    .fixes { width:100%; border-collapse:collapse; font-size:9.5px; margin-top:10px; }
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

    <div class="meta">
      <div><div class="k">Proyecto</div><div class="v">${esc(d.proyectoNombre)}</div></div>
      <div><div class="k">Elaborado por</div><div class="v">${esc(d.autorNombre)}</div></div>
      <div><div class="k">Fecha</div><div class="v">${esc(d.fechaCorta)}</div></div>
    </div>

    <div class="sect"><div class="sect-h">Clima</div><div class="sect-b"><div class="cols">
      <div><div class="k">Clima</div><div class="v">${esc(d.clima)}</div></div>
      <div><div class="k">Horas perdidas</div><div class="v">${horas}</div></div>
      <div class="ancho"><div class="k">Motivo</div>
        <div class="v" style="font-weight:400">${d.motivo ? esc(d.motivo) : '—'}</div></div>
    </div></div></div>

    <div class="sect"><div class="sect-h">Personal y equipo</div><div class="sect-b">
      <div class="cols">
        <div><div class="k">Personal calificado</div><div class="v">${d.personalCalificado}</div></div>
        <div><div class="k">Ayudantes</div><div class="v">${d.ayudantes}</div></div>
        <div><div class="k">Total en obra</div><div class="v">${d.personalCalificado + d.ayudantes}</div></div>
      </div>
      <div class="prose"><div class="k">Equipo utilizado</div>
        ${texto(d.equipo.length ? d.equipo.join(' · ') : null, 'No se registró equipo')}</div>
    </div></div>

    <div class="sect"><div class="sect-h">Trabajo ejecutado</div><div class="sect-b">
      <div class="prose"><div class="k">Áreas donde se trabajó</div>
        ${texto(d.areas.length ? d.areas.join(' · ') : null, 'No se indicaron áreas')}</div>
      <div class="prose"><div class="k">¿Qué se hizo hoy?</div><p>${esc(d.queSeHizo)}</p></div>
      <div class="prose"><div class="k">Atrasos o impedimentos</div>
        ${texto(d.atrasos, 'Sin atrasos reportados')}</div>
      <div class="prose"><div class="k">Novedades del día</div>
        ${texto(d.novedades, 'Sin novedades')}</div>
    </div></div>

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

  const fotos = await incrustarFotos(d.fotos);
  const html = armarHtml(d, fotos, logo);

  let browser: Browser | undefined;
  try {
    browser = await puppeteer.launch(configPuppeteer());
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdf = await page.pdf({
      format: 'letter',
      printBackground: true,
      margin: { top: '0.5in', right: '0.5in', bottom: '0.6in', left: '0.5in' },
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: `<div style="width:100%;padding:0 0.5in;font-family:Arial,Helvetica,sans-serif;
          font-size:7.5px;color:${GRAY};display:flex;justify-content:space-between;">
          <span>Pinellas, S.A. — Reporte diario de obra</span>
          <span>Página <span class="pageNumber"></span> de <span class="totalPages"></span></span>
        </div>`,
    });
    return Buffer.from(pdf);
  } finally {
    if (browser) await browser.close();
  }
}
