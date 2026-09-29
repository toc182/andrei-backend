/**
 * El PDF del reporte diario.
 *
 * Se arma con Puppeteer y no con PDFKit como generateSolicitudPDF, porque este
 * documento lleva una rejilla de fotos que fluye entre paginas; dibujarla
 * coordenada por coordenada seria mucho mas trabajo y mucho mas fragil.
 *
 * Lo que comparte con el reporte semanal —las fotos, el navegador, la hora de
 * Panama, los colores— vive en reportePdfComun.ts. Aqui queda solo esta hoja.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import {
  GRAY, HORA_PANAMA, LIGHT_BG, NAVY, RULE, WARN,
  aPdf, esc, incrustarFotos, logoPinellas, pieDeFoto,
  type FotoIncrustada,
} from './reportePdfComun.js';

import { nombreEmisor, nombrePropio, type Consorcio } from './consorcioProyecto.js';
import type { CambioLegible, Trozo } from './reporteCambios.js';
import { agruparTrabajos, type TrabajoGuardado } from './reporteTrabajos.js';
import type { ColumnaEmpresa } from './siglasEmpresas.js';

// Las piezas comunes se siguen pudiendo importar desde aqui: rutas y pruebas
// las piden a este modulo desde antes de que existiera el reporte semanal.
export { claveReducida, reducirFoto, pieDeFoto, HORA_PANAMA } from './reportePdfComun.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Las tablas de Personal y Equipo por cuadrilla
// ---------------------------------------------------------------------------

/** Una fila de Personal o Equipo con la cuadrilla a la que pertenece. */
type FilaCuadrilla = { nombre: string; empresaId: number | null };

/**
 * Las filas de la tabla: un nombre, y lo de cada cuadrilla bajo ese nombre.
 * Los «Ayudantes» del propio y los de un subcontratista son una sola fila con
 * un número en cada columna.
 */
function porNombre<F extends FilaCuadrilla>(filas: F[]) {
  const nombres: string[] = [];
  const celdas = new Map<string, F>();
  for (const f of filas) {
    if (!nombres.includes(f.nombre)) nombres.push(f.nombre);
    celdas.set(`${f.nombre}|${f.empresaId ?? 'propio'}`, f);
  }
  return {
    nombres,
    de: (nombre: string, c: ColumnaEmpresa) =>
      celdas.get(`${nombre}|${c.empresa_id ?? 'propio'}`),
  };
}

/** Solo las cuadrillas que tienen filas en esta tabla. */
const conFilas = (columnas: ColumnaEmpresa[], filas: FilaCuadrilla[]) =>
  columnas.filter((c) => filas.some((f) => f.empresaId === c.empresa_id));

/** Una casilla de número; el cero es una raya tenue, para que se lea lo que hay. */
const celda = (v: number, clase = '') =>
  `<td class="n${v ? '' : ' cero'}${clase ? ` ${clase}` : ''}">${v || '–'}</td>`;

/** Qué quiere decir cada sigla, debajo de la tabla. */
function clave(columnas: ColumnaEmpresa[], extra = ''): string {
  const siglas = columnas.length > 1
    ? columnas.map((c) => `<span><b>${esc(c.sigla)}</b> ${esc(c.nombre)}</span>`).join('')
    : '';
  if (!siglas && !extra) return '';
  return `<div class="clave">${extra ? `<span>${extra}</span>` : ''}${siglas}</div>`;
}

// Las marcas de Correcciones, en rojo y verde apagados. Ivan los pidió así: el
// tachado y el subrayado son los que dicen qué pasó; el color solo acompaña, y
// en blanco y negro no hace falta.
const QUITADO = '#9a8686';
const QUITADO_LINEA = '#d3c2c2';
const AGREGADO = '#71887a';
const AGREGADO_LINEA = '#c2d1c6';


export interface ReportePdfInput {
  numero: string;
  fechaLarga: string;
  fechaCorta: string;
  proyectoNombre: string;
  /**
   * En un proyecto en consorcio, el consorcio: su nombre va donde el papel
   * decia «Pinellas» y su logo arriba. Ausente o null, el reporte es de
   * Pinellas, como siempre.
   */
  consorcio?: Consorcio | null;
  autorNombre: string;
  clima: string;
  horasPerdidas: number | null;
  motivo: string | null;
  personalCalificado: number;
  ayudantes: number;
  equipo: string[];
  // Las filas. Un reporte de antes del cambio las trae vacias y se imprime
  // con los dos numeros de arriba, que se quedaron en su sitio.
  personal: { nombre: string; empresaId: number | null; cantidad: number }[];
  equipos: { nombre: string; empresaId: number | null; unidades: number; horas: number }[];
  /**
   * Las cuadrillas con filas en este reporte, con sus siglas: las columnas de
   * las tablas de Personal y Equipo. Las mismas que ve la pantalla.
   */
  columnas: ColumnaEmpresa[];
  entregas: {
    categoria: string; descripcion: string;
    cantidad: number | null; unidad: string | null; notas: string | null;
  }[];
  /**
   * El trabajo ejecutado por areas. Vacio en un reporte de antes del cambio,
   * que trae su texto en queSeHizo y su lista de areas aparte, y se imprime
   * como se imprimia.
   */
  trabajos: TrabajoGuardado[];
  areas: string[];
  queSeHizo: string | null;
  atrasos: string | null;
  novedades: string | null;
  /** En el orden del reporte. Sin leyenda, la foto sale solo con su numero. */
  fotos: {
    r2_key: string;
    nombre_archivo: string;
    tipo_mime: string | null;
    leyenda?: string | null;
  }[];
  /** fecha y hora ya escritas en la hora de Panamá. */
  correcciones: { fecha: string; hora: string; quien: string; cambios: CambioLegible[] }[];
  /**
   * Es un borrador: todavia no se ha enviado.
   *
   * Sale con «BORRADOR» cruzado en cada hoja y sin numero, porque el numero se
   * asigna al enviarlo. Lo usa el asistente de WhatsApp, que le manda al
   * ingeniero el papel exacto que va a salir para que lo revise antes.
   */
  borrador?: boolean;
}

/**
 * Cuanto puede medir de alto una foto en el papel, segun como venga. Los topes
 * salen de la hoja carta con el titulo de la seccion y la leyenda mas larga
 * debajo de cada foto: dos filas de verticales o tres de horizontales. Medido
 * el 2026-09-16 con la letra del servidor de Railway; subirlos parte la hoja.
 */
const ALTO_VERTICAL = '4.0in';
const ALTO_HORIZONTAL = '2.5in';

/**
 * El HTML del reporte, tal cual se imprime.
 *
 * Se exporta para poder MIRARLO sin imprimir: una foto de esta pagina dice en
 * un vistazo si el sello del borrador salio, y eso en un PDF ya impreso no se
 * puede comprobar —el texto va dentro del archivo como dibujo de letras.
 */
export function armarHtml(
  d: ReportePdfInput,
  fotos: FotoIncrustada[],
  logo: string,
  omitidas: number,
): string {
  const emitido = new Date().toLocaleString('es-PA', {
    ...HORA_PANAMA,
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
             (f) =>
               `<figure class="shot${f.horizontal ? ' horizontal' : ''}"><img src="${f.src}" alt="">
                  <figcaption>${esc(pieDeFoto(f.numero, f.leyenda))}</figcaption></figure>`,
           )
           .join('')}</div></div>`
    : '';

  // Solo lo que cambio, con las mismas marcas que la pantalla: lo quitado
  // tachado, lo agregado subrayado. Sin leyenda: Ivan la quito el 2026-09-16.
  const trozoHtml = (t: Trozo): string => {
    switch (t.tipo) {
      case 'quitado': return `<del>${esc(t.texto)}</del>`;
      case 'agregado': return `<ins>${esc(t.texto)}</ins>`;
      case 'corte': return `<span class="gap">${esc(t.texto)}</span>`;
      case 'nota': return `<span class="more">${esc(t.texto)}</span>`;
      default: return esc(t.texto);
    }
  };
  const cambioHtml = (k: CambioLegible): string =>
    `<div class="chg"><span class="campo">${esc(k.etiqueta)}</span><span>${k.renglones
      .map((r) => r.map(trozoHtml).join(' '))
      .join('<br>')}</span></div>`;
  const bloqueCorrecciones = d.correcciones.length
    ? `<div class="sect"><div class="sect-h">Correcciones</div>
         <table class="fixes">${d.correcciones
           .map(
             (c) =>
               // La fecha arriba y la hora debajo: en un solo renglon la
               // columna le quitaba ancho a los cambios.
               `<tr><td class="when">${esc(c.fecha)}<br>${esc(c.hora)}</td>
                    <td class="who">${esc(c.quien)}</td>
                    <td>${c.cambios.map(cambioHtml).join('')}</td></tr>`,
           )
           .join('')}</table></div>`
    : '';

  // Las filas en cero no se imprimen: es la regla acordada. Un reporte con
  // veinte puestos posibles y cuatro usados imprime cuatro lineas.
  //
  // Personal y Equipo van como tabla con una columna por cuadrilla (decision
  // de Ivan del 2026-09-28): arriba las siglas, debajo la clave. En Equipo cada
  // cuadrilla lleva U y H separadas por una raya. La pantalla dice lo mismo
  // (TablasCuadrillas.tsx); con una sola cuadrilla no hay siglas ni clave.
  const bloquePersonal = (r: ReportePdfInput): string => {
    if (r.personal.length === 0) {
      // Un reporte de antes del cambio: se imprime como se imprimia.
      const total = r.personalCalificado + r.ayudantes;
      if (total === 0) return '';
      return `<div class="sect entera"><div class="sect-h">Personal</div><div class="sect-b">
        <div class="cols">
          <div><div class="k">Personal calificado</div><div class="v">${r.personalCalificado}</div></div>
          <div><div class="k">Ayudantes</div><div class="v">${r.ayudantes}</div></div>
          <div><div class="k">Total en obra</div><div class="v">${total}</div></div>
        </div></div></div>`;
    }

    const columnas = conFilas(r.columnas, r.personal);
    const varias = columnas.length > 1;
    const { nombres, de } = porNombre(r.personal);
    const cantidad = (n: string, c: ColumnaEmpresa) => de(n, c)?.cantidad ?? 0;
    const totalFila = (n: string) => columnas.reduce((s, c) => s + cantidad(n, c), 0);
    const totalColumna = (c: ColumnaEmpresa) => nombres.reduce((s, n) => s + cantidad(n, c), 0);
    const total = nombres.reduce((s, n) => s + totalFila(n), 0);

    const cabeza = `<tr><th></th>${
      varias ? columnas.map((c) => `<th class="n">${esc(c.sigla)}</th>`).join('') : ''
    }<th class="n${varias ? ' tot' : ''}">${varias ? 'Total' : 'Cantidad'}</th></tr>`;
    const filas = nombres
      .map((n) => `<tr><td>${esc(n)}</td>${
        varias ? columnas.map((c) => celda(cantidad(n, c))).join('') : ''
      }${celda(totalFila(n), varias ? 'tot' : '')}</tr>`)
      .join('');
    const suma = `<tr class="suma-fila"><td>Total en obra</td>${
      varias ? columnas.map((c) => `<td class="n">${totalColumna(c)}</td>`).join('') : ''
    }<td class="n${varias ? ' tot' : ''}">${total}</td></tr>`;

    return `<div class="sect"><div class="sect-h">Personal</div><div class="sect-b">
      <table class="cuadrillas"><thead>${cabeza}</thead><tbody>${filas}${suma}</tbody></table>
      ${clave(columnas)}
    </div></div>`;
  };

  const bloqueEquipo = (r: ReportePdfInput): string => {
    if (r.equipos.length === 0) {
      // Reporte viejo: su lista de texto sigue valiendo.
      if (r.equipo.length === 0) return '';
      return `<div class="sect"><div class="sect-h">Equipo</div><div class="sect-b">
        <div class="prose"><p>${esc(r.equipo.join(' · '))}</p></div></div></div>`;
    }

    const columnas = conFilas(r.columnas, r.equipos);
    const varias = columnas.length > 1;
    const raya = varias ? ' raya' : '';
    const { nombres, de } = porNombre(r.equipos);

    const siglas = varias
      ? `<tr><th></th>${columnas
        .map((c) => `<th class="c raya" colspan="2">${esc(c.sigla)}</th>`).join('')}</tr>`
      : '';
    const uh = `<tr class="uh"><th></th>${columnas
      .map(() => `<th class="n${raya}">U</th><th class="n">H</th>`).join('')}</tr>`;
    const filas = nombres
      .map((n) => `<tr><td>${esc(n)}</td>${columnas
        .map((c) => {
          const f = de(n, c);
          return celda(f?.unidades ?? 0, raya.trim()) + celda(f?.horas ?? 0);
        })
        .join('')}</tr>`)
      .join('');

    return `<div class="sect"><div class="sect-h">Equipo</div><div class="sect-b">
      <table class="cuadrillas"><thead>${siglas}${uh}</thead><tbody>${filas}</tbody></table>
      ${clave(columnas, '<b>U</b> unidades · <b>H</b> horas')}
    </div></div>`;
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

  // Un reporte por areas: «Resumen del dia» con tres partes, y el trabajo en
  // una tabla con el area a la izquierda y sus puntos a la derecha (opcion 1
  // de Ivan, 2026-09-25). Novedades va antes que Atrasos, tambien por el.
  const resumenDelDia = `<div class="sect"><div class="sect-h">Resumen del día</div><div class="sect-b">
      <div class="parte"><div class="k">Trabajo ejecutado</div>
        <table class="areas">${agruparTrabajos(d.trabajos).map((g) => `<tr>
          <td class="area">${esc(g.nombre)}</td>
          <td><ul class="puntos">${g.puntos.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></td>
        </tr>`).join('')}</table></div>
      <div class="parte"><div class="k">Novedades del día</div>
        ${texto(d.novedades, 'Sin novedades')}</div>
      <div class="parte"><div class="k">Atrasos o impedimentos</div>
        ${texto(d.atrasos, 'Sin atrasos reportados')}</div>
    </div></div>`;

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
    /* Alto fijo, el del logo: un consorcio que aun no subio el suyo sale sin
       logo, y la hoja no puede correrse 4px por eso. */
    .head { display:flex; align-items:flex-start; justify-content:space-between;
            min-height:36px; }
    .logo { height:36px; }
    .doc-kind { font-size:13px; line-height:16px; font-weight:700; letter-spacing:.13em;
                text-transform:uppercase; color:${NAVY}; text-align:right; }
    .doc-id { font-size:11px; line-height:16px; color:${GRAY}; text-align:right; }
    /* El sello del borrador. position:fixed lo repite en TODAS las hojas al
       imprimir, que es justamente lo que tiene que pasar: una hoja suelta sin
       sello pasaria por definitiva. */
    .sello { position:fixed; top:45%; left:0; right:0; text-align:center;
             font-size:96px; font-weight:800; letter-spacing:12px;
             color:rgba(185,28,28,0.14); transform:rotate(-24deg); z-index:0; }
    .rule { height:2px; background:${NAVY}; margin-top:12px; }
    h1 { font-size:17px; line-height:24px; color:${NAVY}; margin:16px 0 0; }
    /* Tabla, no flex: con border-collapse las celdas vecinas comparten la
       misma raya, asi que ninguna puede salir doble. */
    .meta { margin-top:16px; width:100%; border-collapse:collapse;
            background:${LIGHT_BG}; }
    .meta td { border:1px solid ${RULE}; padding:8px 12px; width:33.33%;
               vertical-align:top; }
    .k { break-after:avoid; font-size:9.5px; line-height:12px; font-weight:700; letter-spacing:.07em;
         text-transform:uppercase; color:${GRAY}; }
    .v { font-size:12.5px; line-height:16px; font-weight:700; }
    /* Una seccion larga SI se parte entre hojas. Antes ninguna se partia, y
       cuando «Resumen del dia» no cabia en lo que quedaba de la primera hoja
       saltaba entera a la segunda y dejaba tres cuartos de hoja en blanco
       (Santa Isabel, 28-sep-2026, que Ivan señalo). Lo que no se parte es lo
       chico: cada fila, cada foto, y las secciones .entera como Clima.
       Un titulo nunca se queda solo al pie de una hoja: va pegado a lo que
       le sigue. */
    .sect { margin-top:16px; }
    .sect.entera { break-inside:avoid; }
    .sect-h { break-after:avoid; font-size:10.5px; line-height:12px; font-weight:700; letter-spacing:.11em;
              text-transform:uppercase; color:#fff; background:${NAVY};
              padding:6px 9px; border-radius:2px; }
    .sect-b { padding:12px 2px 0; }
    .cols { display:flex; gap:12px; }
    .cols > div { flex:1; }
    .cols > div.ancho { flex:2; }
    .prose { margin-top:12px; }
    .prose p { margin:0; font-size:13px; line-height:20px; white-space:pre-wrap; }
    /* Las tres partes de «Resumen del dia». La primera va pegada al titulo:
       con el margen de las demas quedaba un hueco que Ivan senalo. */
    .parte { margin-top:14px; }
    .parte:first-child { margin-top:0; }
    .parte .k { margin-bottom:6px; }
    .parte p, .prose p { orphans:3; widows:3; }
    .parte p { margin:0; font-size:13px; line-height:20px; white-space:pre-wrap; }
    table.areas { width:100%; border-collapse:collapse; }
    /* Un area SI se parte entre hojas, con al menos tres renglones a cada
       lado. Si no se partiera, un area larga —un ingeniero escribe todo el
       frente en un solo punto— saltaria entera a la hoja siguiente y
       volveria a dejar el hueco en blanco. */
    .puntos li { orphans:3; widows:3; }
    table.areas td { border:1px solid ${RULE}; padding:6px 10px; vertical-align:top;
                     font-size:13px; line-height:20px; }
    table.areas td.area { width:30%; background:${LIGHT_BG}; font-weight:700; }
    .puntos { margin:0; padding-left:16px; }
    .puntos li { margin:0; white-space:pre-wrap; }
    .none { color:${GRAY}; font-style:italic; }
    /* Tope de ALTO, no de ancho, y nada de recortar.
     *
     * Una foto de celular llega en vertical u horizontal, y a la misma anchura
     * de columna la vertical mide casi el doble de alto: cuatro verticales
     * ocupaban dos paginas enteras mientras cuatro horizontales cabian en una.
     * Con el tope, la foto se reduce —sale mas estrecha y centrada, pero
     * COMPLETA—.
     *
     * Los topes salen de la hoja carta, 9.9in de alto util, con el titulo de la
     * seccion arriba y la leyenda mas larga debajo de cada foto: dos filas de
     * verticales o tres de horizontales. La leyenda mas larga son 150
     * caracteres en mayusculas, tres renglones con la letra que tiene el
     * servidor de Railway (DejaVu Sans, mas ancha que la Arial de un Windows).
     * Medido el 2026-09-16 con esa letra: 4.05in y 2.5in son lo maximo que
     * cabe; 4.2in y el ancho entero de la columna ya partian la primera hoja
     * con una leyenda de dos renglones. scripts/reporte-leyendas-humo.ts lo
     * vigila con la letra de la maquina donde corre. Subirlos devuelve el
     * problema; bajarlos empequeñece las fotos sin ganar ninguna fila.
     */
    .shots { display:flex; flex-wrap:wrap; gap:12px; padding-top:10px; }
    .shot { width:calc(50% - 6px); margin:0; page-break-inside:avoid; text-align:center; }
    .shot img { max-width:100%; max-height:${ALTO_VERTICAL}; width:auto; height:auto;
                border:1px solid ${RULE}; border-radius:2px; }
    .shot.horizontal img { max-height:${ALTO_HORIZONTAL}; }
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
    .filas tr, .cuadrillas tr, .fixes tr { break-inside:avoid; }
    .filas td { padding:4px 0; line-height:16px; border-bottom:1px solid ${RULE}; }
    .filas tr:last-child td { border-bottom:0; }
    .filas .n { text-align:right; width:64px; font-variant-numeric:tabular-nums; }
    /* La categoria va en linea, dentro del mismo renglon de 16px, para que no
       cambie la altura de la fila. Las notas si bajan, en su propia linea de
       12px: 24 + 12 = 36, que sigue siendo multiplo de 4. */
    .filas .cat { color:${GRAY}; font-size:11px; line-height:16px; }
    .filas .nota { display:block; color:${GRAY}; font-size:11px; line-height:12px; }
    /* Personal y Equipo por cuadrilla. Mismas filas de 24px que .filas. */
    .cuadrillas { width:100%; border-collapse:collapse; font-size:12.5px; }
    .cuadrillas th { font-size:10px; line-height:12px; font-weight:700; color:${NAVY};
                     padding:0 5px 4px; border-bottom:1px solid ${RULE}; }
    .cuadrillas th.c { text-align:center; border-bottom:0; padding-bottom:2px; }
    .cuadrillas .uh th { color:${GRAY}; }
    .cuadrillas td { padding:4px 5px; line-height:16px; border-bottom:1px solid ${RULE}; }
    .cuadrillas td:first-child, .cuadrillas th:first-child { padding-left:0; text-align:left; }
    .cuadrillas .n { text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }
    .cuadrillas .cero { color:${RULE}; }
    .cuadrillas .tot { background:${LIGHT_BG}; }
    .cuadrillas .raya { border-left:1px solid ${RULE}; }
    .cuadrillas .suma-fila td { font-weight:700; border-top:1px solid ${GRAY}; border-bottom:0; }
    .clave { display:flex; flex-wrap:wrap; gap:2px 10px; margin-top:6px;
             font-size:10px; line-height:12px; color:${GRAY}; }
    .clave b { color:${NAVY}; }
    .fixes { width:100%; border-collapse:collapse; font-size:11.5px; line-height:15px; margin-top:10px; }
    .fixes td { padding:5px 9px; border:1px solid ${RULE}; vertical-align:top; }
    /* width:1% y sin cortes: la columna mide lo que mide la fecha. */
    .fixes .when { width:1%; color:${GRAY}; white-space:nowrap; }
    .fixes .who { width:96px; }
    .fixes .chg { display:grid; grid-template-columns:132px 1fr; gap:8px; }
    .fixes .chg + .chg { margin-top:4px; }
    .fixes .campo, .fixes .gap, .fixes .more { color:${GRAY}; }
    .fixes .more { font-size:11px; }
    /* Tonos apagados a pedido de Ivan: el tachado y el subrayado son los que
       dicen que paso; el color solo acompana, y en blanco y negro no hace falta. */
    .fixes del { color:${QUITADO}; text-decoration-color:${QUITADO_LINEA}; }
    .fixes ins { color:${AGREGADO}; text-decoration:underline; text-decoration-color:${AGREGADO_LINEA};
                 text-underline-offset:2px; }
  </style></head><body>
    ${d.borrador ? '<div class="sello">BORRADOR</div>' : ''}
    <div class="head">
      ${logo ? `<img class="logo" src="${esc(logo)}" alt="${esc(nombrePropio(d.consorcio))}">` : '<span></span>'}
      <div>
        <div class="doc-kind">Reporte diario de obra</div>
        <div class="doc-id">${
          d.borrador ? 'BORRADOR · sin número todavía' : `${esc(d.numero)} · emitido ${esc(emitido)}`
        }</div>
      </div>
    </div>
    <div class="rule"></div>

    <h1>${esc(d.fechaLarga)}</h1>

    <table class="meta"><tr>
      <td><div class="k">Proyecto</div><div class="v">${esc(d.proyectoNombre)}</div></td>
      <td><div class="k">Elaborado por</div><div class="v">${esc(d.autorNombre)}</div></td>
      <td><div class="k">Fecha</div><div class="v">${esc(d.fechaCorta)}</div></td>
    </tr></table>

    <div class="sect entera"><div class="sect-h">Clima</div><div class="sect-b"><div class="cols">
      <div><div class="k">Clima</div><div class="v">${esc(d.clima)}</div></div>
      <div><div class="k">Horas perdidas</div><div class="v">${horas}</div></div>
      <div class="ancho"><div class="k">Motivo</div>
        <div class="v" style="font-weight:400">${d.motivo ? esc(d.motivo) : '—'}</div></div>
    </div></div></div>

    ${d.trabajos.length ? resumenDelDia : `<div class="sect"><div class="sect-h">Trabajo ejecutado</div><div class="sect-b">
      <div class="prose"><div class="k">Áreas de trabajo</div>
        ${texto(d.areas.length ? d.areas.join(' · ') : null, 'No se indicaron áreas')}</div>
      <div class="prose"><p>${esc(d.queSeHizo ?? '')}</p></div>
      <div class="prose"><div class="k">Atrasos o impedimentos</div>
        ${texto(d.atrasos, 'Sin atrasos reportados')}</div>
      <div class="prose"><div class="k">Novedades del día</div>
        ${texto(d.novedades, 'Sin novedades')}</div>
    </div></div>`}

    ${columnasFilas(d)}

    ${bloqueFotos}
    ${bloqueCorrecciones}
  </body></html>`;
}

export async function generateReportePDF(d: ReportePdfInput): Promise<Buffer> {
  // En un consorcio va SU logo, y si todavia no lo subieron, ninguno: el de
  // Pinellas en un papel del consorcio diria algo que no es.
  const logo = d.consorcio ? d.consorcio.logo ?? '' : logoPinellas(__dirname);
  const { lista: fotos, omitidas } = await incrustarFotos(d.fotos);
  const html = armarHtml(d, fotos, logo, omitidas);
  return aPdf(html, `${nombreEmisor(d.consorcio)} — Reporte diario de obra`);
}
