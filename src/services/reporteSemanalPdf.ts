/**
 * El PDF del reporte semanal de obra.
 *
 * La hoja es la que Ivan aprobó en la maqueta del 2026-09-17, y en el mismo
 * orden: resumen, equipo de trabajo, equipo, materiales, pagos, comparación,
 * metas, problemas, plan, decisiones y fotos. Las secciones vacías no salen
 * —«si no hay decisiones, no sale ni el título»—.
 *
 * Todo lo que comparte con el reporte diario (las fotos, el navegador, los
 * colores, la hora de Panamá) viene de reportePdfComun.ts; aquí solo está esta
 * hoja.
 *
 * Dos detalles que no son de estilo:
 *
 * - los números vienen congelados en `datos`, tal como estaban al enviarse: el
 *   papel dice lo que dijo al salir aunque después se corrija un diario;
 * - una meta se marca SOLO con el color de su punto, sin la palabra al lado.
 *   Lo decidió Ivan el 2026-09-17, sabiendo que en blanco y negro los tres se
 *   parecen.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import {
  GRAY, LIGHT_BG, NAVY, RULE, WARN,
  aPdf, esc, incrustarFotos, logoPinellas, pieDeFoto,
  type FotoDelReporte, type FotoIncrustada,
} from './reportePdfComun.js';
import { HORA_PANAMA } from './reportePdfComun.js';
import { nombreEmisor, nombrePropio, type Consorcio } from './consorcioProyecto.js';
import type { DatosSemana } from './reporteSemanalDatos.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Los colores de los puntos de las metas. */
const VERDE = '#3f9463';
const AMBAR = '#d9a13a';
const ROJO = '#c75050';

export interface MetaPdf {
  texto: string;
  cantidad: number | null;
  unidad: string | null;
  estado: 'completada' | 'parcial' | 'no_completada' | null;
  cantidad_hecha: number | null;
  porcentaje: number | null;
  motivo: string | null;
  fuera_del_plan: boolean;
}

export interface ReporteSemanalPdfInput {
  numero: string;
  semanaIso: number;
  anioIso: number;
  /** «7 al 13 de septiembre de 2026». */
  semanaLarga: string;
  /** «Lun 7 – Dom 13 sept 2026», el recuadro de arriba. */
  semanaCorta: string;
  /** «14 al 20 sept», el título del plan. */
  proximaSemana: string;
  proximaSemanaIso: number;
  proyectoNombre: string;
  consorcio?: Consorcio | null;
  autorNombre: string;
  resumen: string | null;
  loQueSeEspera: string | null;
  datos: DatosSemana;
  metas: MetaPdf[];
  metasPlan: { texto: string; cantidad: number | null; unidad: string | null }[];
  problemas: { fecha: string | null; problema: string; accion: string | null }[];
  decisiones: string[];
  fotos: (FotoDelReporte & { fecha: string })[];
}

const DIAS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sept', 'oct', 'nov', 'dic'];

/** «Lun 7», la cabecera de una columna de día. */
function diaCorto(fecha: string, i: number): string {
  return `${DIAS[i]} ${Number(fecha.slice(8, 10))}`;
}

/** «7 sept», para los motivos y las entregas. */
function diaYMes(fecha: string): string {
  return `${Number(fecha.slice(8, 10))} ${MESES[Number(fecha.slice(5, 7)) - 1]}`;
}

const dinero = (n: number): string =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Una casilla de día: vacía cuando ese día no tiene reporte diario. */
function celda(valor: number | null, sufijo = ''): string {
  if (valor === null) return '<td class="n sin">—</td>';
  if (valor === 0) return '<td class="n cero">0</td>';
  return `<td class="n">${valor}${sufijo}</td>`;
}

/**
 * La hoja, en HTML. Se exporta para poder mirarla en un navegador sin generar
 * el PDF entero, que es como se revisó contra la maqueta que Ivan aprobó.
 */
export function armarHtmlSemanal(d: ReporteSemanalPdfInput, fotos: FotoIncrustada[], logo: string, omitidas: number): string {
  const emitido = new Date().toLocaleString('es-PA', {
    ...HORA_PANAMA,
    day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });

  const datos = d.datos;
  // El domingo solo ocupa columna si alguien reportó ese día: se asume libre.
  const indices = datos.dias
    .map((x, i) => ({ x, i }))
    .filter(({ x, i }) => i < 6 || x.numero !== null)
    .map(({ i }) => i);
  const cabeceraDias = indices
    .map((i) => `<th class="n d">${esc(diaCorto(datos.dias[i].fecha, i))}</th>`)
    .join('');

  const seccion = (titulo: string, cuerpo: string): string =>
    cuerpo
      ? `<div class="sect"><div class="sect-h">${esc(titulo)}</div><div class="sect-b">${cuerpo}</div></div>`
      : '';

  // ---- equipo de trabajo ----
  const filasPersonal = datos.personal
    .map((g) => {
      const titulo = datos.personal.length > 1
        ? `<tr class="grp"><td colspan="${indices.length + 1}">${esc(g.empresa ?? nombrePropio(d.consorcio))}</td></tr>`
        : '';
      const filas = g.filas
        .map((f) => `<tr><td>${esc(f.nombre)}</td>${indices.map((i) => celda(f.por_dia[i])).join('')}</tr>`)
        .join('');
      return titulo + filas;
    })
    .join('');
  const motivos = datos.horas_perdidas.motivos
    .map(
      (m) => `<li><span class="dia">${esc(diaYMes(m.fecha))}</span>
                  <span class="hh">${m.horas} h</span>
                  <span>${esc(m.motivo ?? 'Sin motivo anotado')}</span></li>`,
    )
    .join('');
  const bloqueTrabajo = filasPersonal
    ? `<table class="t">
         <thead><tr><th></th>${cabeceraDias}</tr></thead>
         <tbody>
           ${filasPersonal}
           <tr class="tot"><td>Total en obra</td>${indices.map((i) => celda(datos.personal_total[i])).join('')}</tr>
           <tr><td>Horas perdidas</td>${indices
             .map((i) => {
               const h = datos.horas_perdidas.por_dia[i];
               if (h === null) return '<td class="n sin">—</td>';
               if (h === 0) return '<td class="n cero">0</td>';
               return `<td class="n alerta">${h} h</td>`;
             })
             .join('')}</tr>
         </tbody>
       </table>
       ${motivos ? `<ul class="motivos">${motivos}</ul>` : ''}`
    : '';

  // ---- equipo ----
  const bloqueEquipo = datos.equipos.length
    ? `<table class="t">
         <thead><tr><th>Horas por día</th>${cabeceraDias}<th class="n d">Semana</th></tr></thead>
         <tbody>${datos.equipos
           .map(
             (e) => `<tr><td>${esc(e.nombre)}</td>${indices.map((i) => celda(e.por_dia[i])).join('')}
                       <td class="n"><b>${e.total} h</b></td></tr>`,
           )
           .join('')}</tbody>
       </table>`
    : '';

  // ---- materiales ----
  const bloqueMateriales = datos.materiales.length
    ? `<table class="t">
         <thead><tr><th class="dia">Día</th><th>Qué llegó</th><th class="n w">Cantidad</th></tr></thead>
         <tbody>${datos.materiales
           .map((m) => {
             const cuanto = [m.cantidad ?? '', m.unidad ?? '']
               .filter((x) => String(x) !== '')
               .join(' ');
             return `<tr><td class="dia">${esc(diaYMes(m.fecha))}</td>
                       <td>${esc(m.descripcion)} <span class="cat">${esc(m.categoria.toLowerCase())}</span>
                       ${m.notas ? `<span class="nota">${esc(m.notas)}</span>` : ''}</td>
                       <td class="n">${esc(cuanto)}</td></tr>`;
           })
           .join('')}</tbody>
       </table>`
    : '';

  // ---- pagos ----
  const bloquePagos = datos.pagos.filas.length
    ? `<p class="sub">Solo las solicitudes marcadas como pagadas en el sistema. No incluye pagos
         hechos por fuera.</p>
       <table class="t">
         <thead><tr><th>Categoría</th><th class="n w">Solicitudes</th><th class="n w">Monto</th></tr></thead>
         <tbody>
           ${datos.pagos.filas
             .map(
               (p) => `<tr><td>${esc(p.categoria ?? 'Sin categoría')}</td>
                         <td class="n">${p.solicitudes}</td>
                         <td class="n">${dinero(p.monto)}</td></tr>`,
             )
             .join('')}
           <tr class="tot"><td>Total de la semana</td>
             <td class="n">${datos.pagos.solicitudes}</td>
             <td class="n">${dinero(datos.pagos.monto)}</td></tr>
         </tbody>
       </table>`
    : '';

  // ---- comparación ----
  const bloqueComparacion = datos.comparacion.filas.some((f) => f.actual !== null || f.anterior !== null)
    ? `<table class="t chica">
         <thead><tr><th></th><th class="n w">Semana anterior</th><th class="n w">Esta semana</th></tr></thead>
         <tbody>${datos.comparacion.filas
           .map(
             (f) => `<tr><td>${esc(f.etiqueta)}</td>
                       <td class="n">${f.anterior === null ? '—' : `${f.anterior}${f.unidad ? ` ${f.unidad}` : ''}`}</td>
                       <td class="n">${f.actual === null ? '—' : `${f.actual}${f.unidad ? ` ${f.unidad}` : ''}`}</td></tr>`,
           )
           .join('')}</tbody>
       </table>`
    : '';

  // ---- metas ----
  const punto = (estado: MetaPdf['estado']): string => {
    const color = estado === 'completada' ? VERDE : estado === 'parcial' ? AMBAR : ROJO;
    return estado === null
      ? '<span class="punto vacio"></span>'
      : `<span class="punto" style="background:${color}"></span>`;
  };
  const avance = (m: MetaPdf): string => {
    if (m.estado !== 'parcial') return '';
    if (m.cantidad !== null && m.cantidad_hecha !== null) {
      return `<b class="av">${m.cantidad_hecha} de ${m.cantidad} ${esc(m.unidad ?? '')}</b>`;
    }
    return m.porcentaje === null ? '' : `<b class="av">${m.porcentaje}%</b>`;
  };
  const bloqueMetas = d.metas.length
    ? `<table class="t dos">
         <thead><tr><th class="col-meta">Meta</th><th class="e"></th><th>Avance y motivo</th></tr></thead>
         <tbody>${d.metas
           .map(
             (m) => `<tr>
               <td>${esc(m.texto)}
                 ${m.fuera_del_plan ? '<span class="chip">fuera del plan</span>' : ''}
                 ${m.cantidad !== null ? `<span class="cant">${m.cantidad} ${esc(m.unidad ?? '')}</span>` : ''}</td>
               <td class="e">${punto(m.estado)}</td>
               <td>${avance(m)}${m.motivo ? `<span class="mot">${esc(m.motivo)}</span>` : ''}</td>
             </tr>`,
           )
           .join('')}</tbody>
       </table>`
    : '';

  // ---- problemas ----
  const bloqueProblemas = d.problemas.length
    ? `<table class="t dos">
         <thead><tr><th class="dia">Día</th><th class="mitad">Problema</th><th>Acción a tomar</th></tr></thead>
         <tbody>${d.problemas
           .map(
             (p) => `<tr>
               <td class="dia">${esc(p.fecha ? diaYMes(p.fecha) : 'La semana')}</td>
               <td>${esc(p.problema)}</td>
               <td>${p.accion ? esc(p.accion) : '<span class="sin">Sin acción anotada</span>'}</td>
             </tr>`,
           )
           .join('')}</tbody>
       </table>`
    : '';

  // ---- plan ----
  const bloquePlan = d.loQueSeEspera || d.metasPlan.length
    ? `${d.loQueSeEspera
      ? `<div class="bloque"><div class="k">Lo que se espera</div>
           <p class="prosa">${esc(d.loQueSeEspera)}</p></div>`
      : ''}
       ${d.metasPlan.length
      ? `<div class="bloque"><div class="k">Metas</div>
           <table class="t metas-plan"><tbody>${d.metasPlan
        .map(
          (m) => `<tr><td>${esc(m.texto)}</td>
                    <td class="n w">${m.cantidad === null ? '' : `${m.cantidad} ${esc(m.unidad ?? '')}`}</td></tr>`,
        )
        .join('')}</tbody></table></div>`
      : ''}`
    : '';

  // ---- decisiones ----
  const bloqueDecisiones = d.decisiones.length
    ? `<table class="t decis"><tbody>${d.decisiones
      .map((t) => `<tr><td class="caja"><span class="box"></span></td><td>${esc(t)}</td></tr>`)
      .join('')}</tbody></table>`
    : '';

  // ---- fotos ----
  const aviso = omitidas
    ? ` · <span style="color:${WARN}">${omitidas} no se pudieron incluir</span>`
    : '';
  const bloqueFotos = fotos.length || omitidas
    ? `<div class="sect"><div class="sect-h">Fotos de la semana · ${fotos.length}${aviso}</div>
         <div class="shots">${fotos
      .map(
        (f) => `<figure class="shot${f.horizontal ? ' horizontal' : ''}"><img src="${f.src}" alt="">
                  <figcaption>${esc(pieDeFoto(f.numero, f.leyenda))}</figcaption></figure>`,
      )
      .join('')}</div></div>`
    : '';

  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><style>
    /* Las medidas son las del reporte diario: mismo cuerpo, mismas rayas, mismo
       ritmo vertical en múltiplos de 4px (1px = 0.75pt, así que una raya solo
       cae en una coordenada entera de puntos cuando su posición es múltiplo
       de 4). Al tocar esta hoja, mantener las alturas en múltiplos de 4. */
    * { box-sizing: border-box; }
    body { margin:0; font-family: Arial, Helvetica, sans-serif; color:#000;
           font-size:12.5px; line-height:16px; }
    .head { display:flex; align-items:flex-start; justify-content:space-between; min-height:36px; }
    .logo { height:36px; }
    .doc-kind { font-size:13px; line-height:16px; font-weight:700; letter-spacing:.13em;
                text-transform:uppercase; color:${NAVY}; text-align:right; }
    .doc-id { font-size:11px; line-height:16px; color:${GRAY}; text-align:right; }
    .rule { height:2px; background:${NAVY}; margin-top:12px; }
    h1 { font-size:17px; line-height:24px; color:${NAVY}; margin:16px 0 0; }
    .meta { margin-top:16px; width:100%; border-collapse:collapse; background:${LIGHT_BG}; }
    .meta td { border:1px solid ${RULE}; padding:8px 12px; width:33.33%; vertical-align:top; }
    .k { font-size:9.5px; line-height:12px; font-weight:700; letter-spacing:.07em;
         text-transform:uppercase; color:${GRAY}; }
    .v { font-size:12.5px; line-height:16px; font-weight:700; }
    .sect { margin-top:16px; page-break-inside:avoid; }
    .sect-h { font-size:10.5px; line-height:12px; font-weight:700; letter-spacing:.11em;
              text-transform:uppercase; color:#fff; background:${NAVY};
              padding:6px 9px; border-radius:2px; }
    .sect-b { padding:12px 2px 0; }
    .sub { font-size:11px; line-height:16px; color:${GRAY}; margin:0 0 8px; }
    .prosa { margin:0; font-size:13px; line-height:20px; white-space:pre-wrap; }
    .bloque + .bloque { margin-top:12px; }
    .bloque .k { margin-bottom:4px; }

    .t { width:100%; border-collapse:collapse; font-size:12px; }
    .t.chica { font-size:11.5px; }
    .t th { font-size:9.5px; line-height:12px; font-weight:700; letter-spacing:.06em;
            text-transform:uppercase; color:${GRAY}; text-align:left;
            padding:0 0 6px; border-bottom:1px solid #cbd5e0; white-space:nowrap; }
    .t th.n { text-align:right; }
    .t td { padding:4px 0; line-height:16px; border-bottom:1px solid ${RULE}; vertical-align:top; }
    .t tr:last-child td { border-bottom:0; }
    .t .n { text-align:right; font-variant-numeric:tabular-nums; }
    .t .d { width:58px; }
    .t .w { width:96px; }
    .t .dia { width:58px; color:${GRAY}; font-size:11px; white-space:nowrap; }
    .t .col-meta { width:40%; }
    .t .mitad { width:42%; }
    .t .cero, .t .sin { color:#cbd5e0; }
    .t .alerta { color:${WARN}; font-weight:700; }
    .t .cat { color:${GRAY}; font-size:11px; }
    .t .nota, .t .cant, .t .mot { display:block; color:${GRAY}; font-size:11px; line-height:14px; }
    .t .av { display:block; font-variant-numeric:tabular-nums; }
    .t tr.grp td { border-bottom:0; padding-top:10px; font-size:10px; line-height:12px;
                   font-weight:700; letter-spacing:.09em; text-transform:uppercase; color:${NAVY}; }
    .t tr.tot td { font-weight:700; border-top:1px solid #cbd5e0; border-bottom:0; padding-top:6px; }
    .t.dos td { padding:6px 0; }
    .t.dos td + td, .t.dos th + th { padding-left:16px; }
    .t.dos .e, .t.dos td.e { width:30px; padding-left:12px; }
    .t.dos td.e + td { padding-left:8px; }
    .chip { display:inline-block; font-size:9.5px; line-height:14px; padding:0 6px; border-radius:2px;
            border:1px solid #cbd5e0; color:${GRAY}; margin-left:6px; vertical-align:1px; }
    /* El estado de una meta es SOLO el color del punto: sin palabra al lado.
       Decisión de Ivan del 2026-09-17. */
    .punto { display:inline-block; width:14px; height:14px; border-radius:50%; margin-top:1px; }
    .punto.vacio { border:2px solid #cbd5e0; }
    .metas-plan td:first-child { width:auto; }
    .decis td { padding:5px 0; }
    .decis .caja { width:22px; }
    .decis .box { display:inline-block; width:11px; height:11px; border:1.5px solid ${NAVY};
                  border-radius:2px; margin-top:2px; }
    .motivos { margin:8px 0 0; padding:0; list-style:none; font-size:11.5px; line-height:16px; }
    .motivos li { margin-bottom:2px; }
    .motivos .dia { display:inline-block; width:58px; color:${GRAY}; }
    .motivos .hh { display:inline-block; width:40px; color:${WARN}; font-weight:700;
                   text-align:right; font-variant-numeric:tabular-nums; margin-right:8px; }

    /* Las fotos, con los mismos topes que el reporte diario: nada se recorta. */
    .shots { display:flex; flex-wrap:wrap; gap:12px; padding-top:10px; }
    .shot { width:calc(50% - 6px); margin:0; page-break-inside:avoid; text-align:center; }
    .shot img { max-width:100%; max-height:4.0in; width:auto; height:auto;
                border:1px solid ${RULE}; border-radius:2px; }
    .shot.horizontal img { max-height:2.5in; }
    .shot figcaption { font-size:10px; color:${GRAY}; margin-top:3px; text-align:center; }
  </style></head><body>
    <div class="head">
      ${logo ? `<img class="logo" src="${esc(logo)}" alt="${esc(nombreEmisor(d.consorcio))}">` : '<span></span>'}
      <div>
        <div class="doc-kind">Reporte semanal de obra</div>
        <div class="doc-id">${esc(d.numero)} · emitido ${esc(emitido)}</div>
      </div>
    </div>
    <div class="rule"></div>

    <h1>Semana ${d.semanaIso} · del ${esc(d.semanaLarga)}</h1>

    <table class="meta"><tr>
      <td><div class="k">Proyecto</div><div class="v">${esc(d.proyectoNombre)}</div></td>
      <td><div class="k">Elaborado por</div><div class="v">${esc(d.autorNombre)}</div></td>
      <td><div class="k">Fechas</div><div class="v">${esc(d.semanaCorta)}</div></td>
    </tr></table>

    ${seccion('Resumen de la semana', d.resumen ? `<p class="prosa">${esc(d.resumen)}</p>` : '')}
    ${seccion('Equipo de trabajo', bloqueTrabajo)}
    ${seccion('Equipo', bloqueEquipo)}
    ${seccion('Materiales que llegaron', bloqueMateriales)}
    ${seccion('Pagos registrados en el sistema esta semana', bloquePagos)}
    ${seccion('Comparación con la semana anterior', bloqueComparacion)}
    ${seccion('Metas de la semana', bloqueMetas)}
    ${seccion('Problemas y atrasos', bloqueProblemas)}
    ${seccion(`Plan de la semana ${d.proximaSemanaIso} · ${d.proximaSemana}`, bloquePlan)}
    ${seccion('Decisiones que se necesitan', bloqueDecisiones)}
    ${bloqueFotos}
  </body></html>`;
}

export async function generateReporteSemanalPDF(d: ReporteSemanalPdfInput): Promise<Buffer> {
  // En un consorcio va SU logo, y si todavía no lo subieron, ninguno.
  const logo = d.consorcio ? d.consorcio.logo ?? '' : logoPinellas(__dirname);
  const { lista: fotos, omitidas } = await incrustarFotos(d.fotos);
  const html = armarHtmlSemanal(d, fotos, logo, omitidas);
  return aPdf(html, `${nombreEmisor(d.consorcio)} — Reporte semanal de obra`);
}
