// Una tabla de solicitudes de pago, en PDF o en Excel, pedida por WhatsApp.
//
// Decision de Ivan del 2026-09-29: «si le pido algun resumen especifico, que me
// lo mande por correo o por el mismo WhatsApp en PDF o en Excel». El modelo
// decide QUE va —que solicitudes, que columnas, agrupadas como— y el sistema
// arma el archivo: las filas, los subtotales y el total salen de la base, igual
// que en las respuestas por escrito. Arriba del archivo va dicho que filtro se
// uso, para que la persona vea que es lo que pidio.
//
// Las filas salen de consultaDeSolicitudes (solicitudes.ts): los mismos
// permisos, y ninguna columna bancaria. scripts/whatsapp-solicitudes.spec.ts
// revisa tambien este archivo.

import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { query } from '../../database/config.js';
import type { Usuario } from './herramientas.js';
import { consultaDeSolicitudes, dinero, ESTADOS, ORDENES, type Filtros } from './solicitudes.js';

/** Las columnas que se pueden pedir. El monto va siempre, al final. */
export const COLUMNAS = {
  numero: { titulo: 'Número', sql: 'sp.numero', ancho: 13 },
  obra: { titulo: 'Obra', sql: "COALESCE(NULLIF(pr.nombre_corto, ''), pr.nombre)", ancho: 16 },
  fecha: { titulo: 'Fecha', sql: "to_char(sp.fecha, 'DD/MM/YYYY')", ancho: 11 },
  proveedor: { titulo: 'Proveedor', sql: 'sp.proveedor', ancho: 26 },
  que_se_compro: {
    titulo: 'Qué se compró',
    sql: `(SELECT LEFT(string_agg(i.descripcion, '; ' ORDER BY i.orden, i.id), 200)
             FROM solicitud_pago_items i WHERE i.solicitud_pago_id = sp.id)`,
    ancho: 40,
  },
  estado: { titulo: 'Estado', sql: 'sp.estado', ancho: 20 },
  le_toca_a: { titulo: 'Le toca firmar a', sql: 'sig.nombre', ancho: 20 },
  fecha_pago: {
    titulo: 'Fecha de pago',
    sql: `(SELECT to_char(MAX(c.fecha_pago), 'DD/MM/YYYY') FROM comprobantes_pago c
            WHERE c.solicitud_pago_id = sp.id)`,
    ancho: 12,
  },
  categoria: {
    titulo: 'Categoría',
    sql: '(SELECT cg.nombre FROM categorias_gastos cg WHERE cg.id = sp.categoria_id)',
    ancho: 18,
  },
  urgente: { titulo: 'Urgente', sql: "CASE WHEN sp.urgente THEN 'Sí' ELSE '' END", ancho: 8 },
} as const;
export type Columna = keyof typeof COLUMNAS;

/** Por que se puede agrupar, con subtotal por grupo. */
export const AGRUPAR = {
  obra: "COALESCE(NULLIF(pr.nombre_corto, ''), pr.nombre, '(sin obra)')",
  proveedor: "COALESCE(sp.proveedor, '(sin proveedor)')",
  estado: 'sp.estado',
  aprobador: "COALESCE(sig.nombre, '(no le toca a nadie)')",
} as const;
export type Agrupar = keyof typeof AGRUPAR;

/** Mas de esto no es un resumen: se le pide que filtre. */
export const TOPE_TABLA = 2000;

const POR_DEFECTO: Columna[] = ['numero', 'obra', 'fecha', 'proveedor', 'estado'];

export interface Tabla {
  titulo: string;
  /** El filtro, dicho como lo entiende la persona. */
  filtro: string;
  /** «29/09/2026». */
  corte: string;
  columnas: { titulo: string; ancho: number }[];
  grupos: {
    nombre: string | null;
    filas: { celdas: string[]; monto: number }[];
    cantidad: number;
    subtotal: number;
  }[];
  total: { cantidad: number; monto: number };
}

type Armada = { ok: true; tabla: Tabla } | { ok: false; error: string; extra?: unknown };

const estadoDicho = (e: string): string => (e in ESTADOS ? ESTADOS[e as keyof typeof ESTADOS] : e);

/**
 * Las filas, los subtotales y el total de la tabla. Todo sale de la base: el
 * total es SUM de la base, no la suma de lo que se escribio en el archivo.
 */
export async function armarTabla(
  usuario: Usuario,
  pedido: { filtros: Filtros; columnas?: string[]; agrupar_por?: string; titulo?: string },
): Promise<Armada> {
  const consulta = await consultaDeSolicitudes(usuario, pedido.filtros);
  if (!consulta.ok) return consulta;
  const { f, desde, params, descripcion } = consulta;

  const pedidas = (pedido.columnas ?? []).filter((c): c is Columna => c in COLUMNAS);
  const columnas = [...new Set(pedidas.length ? pedidas : POR_DEFECTO)];
  const agrupar = pedido.agrupar_por && pedido.agrupar_por in AGRUPAR
    ? (pedido.agrupar_por as Agrupar)
    : null;
  const grupo = agrupar ? AGRUPAR[agrupar] : 'NULL';

  const total = await query<{ cantidad: string; monto: string }>(
    `SELECT COUNT(*)::text AS cantidad, COALESCE(SUM(sp.monto_total), 0)::text AS monto ${desde}`,
    params,
  );
  const cantidad = Number(total.rows[0]?.cantidad ?? 0);
  if (cantidad === 0) return { ok: false, error: 'No hay ninguna solicitud con ese filtro: no hay tabla que mandar.' };
  if (cantidad > TOPE_TABLA) {
    return {
      ok: false,
      error: `Son ${cantidad} solicitudes: demasiadas para una tabla. Pregúntale cómo las filtra (obra, estado, fechas…).`,
    };
  }

  // Las columnas y el orden salen de las listas de arriba, nunca de lo que
  // mando el modelo: por eso pueden ir dentro del SQL.
  const [filas, subtotales] = await Promise.all([
    query<Record<string, string | null>>(
      `SELECT ${columnas.map((c) => `${COLUMNAS[c].sql} AS "${c}"`).join(', ')},
              sp.monto_total::text AS monto, ${grupo} AS grupo
         ${desde}
        ORDER BY ${agrupar ? `${grupo}, ` : ''}${ORDENES[f.orden ?? 'recientes']}`,
      params,
    ),
    query<{ grupo: string | null; cantidad: string; monto: string }>(
      `SELECT ${grupo} AS grupo, COUNT(*)::text AS cantidad,
              COALESCE(SUM(sp.monto_total), 0)::text AS monto
         ${desde}
        GROUP BY 1`,
      params,
    ),
  ]);

  const grupos = new Map<string | null, Tabla['grupos'][number]>();
  for (const s of subtotales.rows) {
    const nombre = s.grupo === null ? null : agrupar === 'estado' ? estadoDicho(s.grupo) : s.grupo;
    grupos.set(s.grupo, { nombre, filas: [], cantidad: Number(s.cantidad), subtotal: Number(s.monto) });
  }
  for (const r of filas.rows) {
    const celdas = columnas.map((c) => {
      const v = r[c] ?? '';
      return c === 'estado' ? estadoDicho(v) : v;
    });
    grupos.get(r.grupo)?.filas.push({ celdas, monto: Number(r.monto) });
  }

  const hoy = new Date().toLocaleDateString('en-GB', { timeZone: 'America/Panama' });
  return {
    ok: true,
    tabla: {
      titulo: pedido.titulo?.trim() || 'Solicitudes de pago',
      filtro: descripcion.join(' · '),
      corte: hoy,
      columnas: [
        ...columnas.map((c) => ({ titulo: COLUMNAS[c].titulo, ancho: COLUMNAS[c].ancho })),
        { titulo: 'Monto', ancho: 14 },
      ],
      // En el orden en que salieron las filas.
      grupos: [...new Set(filas.rows.map((r) => r.grupo))].map((g) => grupos.get(g)!),
      total: { cantidad, monto: Number(total.rows[0]?.monto ?? 0) },
    },
  };
}

// ─── Excel ───────────────────────────────────────────────────────────────

const FORMATO_MONTO = '"B/." #,##0.00';

export async function tablaEnExcel(t: Tabla): Promise<Buffer> {
  const libro = new ExcelJS.Workbook();
  libro.creator = 'Pinellas';
  const hoja = libro.addWorksheet('Solicitudes');
  const ancho = t.columnas.length;

  hoja.addRow([t.titulo]).font = { bold: true, size: 14 };
  hoja.addRow([`Filtro: ${t.filtro}`]);
  hoja.addRow([`Al ${t.corte} · ${t.total.cantidad} solicitudes`]).font = { italic: true };
  hoja.addRow([]);

  const cabecera = hoja.addRow(t.columnas.map((c) => c.titulo));
  cabecera.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  cabecera.eachCell((c) => {
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3A4D' } };
  });
  hoja.views = [{ state: 'frozen', ySplit: cabecera.number }];

  const montoEn = (fila: ExcelJS.Row): void => {
    fila.getCell(ancho).numFmt = FORMATO_MONTO;
  };
  for (const g of t.grupos) {
    if (g.nombre !== null) {
      const titulo = hoja.addRow([g.nombre]);
      titulo.font = { bold: true };
    }
    for (const f of g.filas) montoEn(hoja.addRow([...f.celdas, f.monto]));
    if (g.nombre !== null) {
      const sub = hoja.addRow([
        `Subtotal ${g.nombre} (${g.cantidad})`,
        ...Array(ancho - 2).fill(''),
        g.subtotal,
      ]);
      sub.font = { bold: true };
      montoEn(sub);
    }
  }
  const total = hoja.addRow([`Total (${t.total.cantidad})`, ...Array(ancho - 2).fill(''), t.total.monto]);
  total.font = { bold: true };
  montoEn(total);

  t.columnas.forEach((c, i) => {
    hoja.getColumn(i + 1).width = c.ancho;
  });
  hoja.getColumn(ancho).alignment = { horizontal: 'right' };

  return Buffer.from(await libro.xlsx.writeBuffer());
}

// ─── PDF ─────────────────────────────────────────────────────────────────

/** Lo que la letra del PDF (Helvetica) no tiene, dicho con lo que si tiene.
 *  Sin esto «B/. 200.00 → B/. 300.00» salia como «B/. 200.00 !' B/. 300.00». */
const EQUIVALENTES: Record<string, string> = {
  '→': '->', '←': '<-', '⇒': '=>', '≥': '>=', '≤': '<=', '≠': '!=', '×': 'x', '✓': 'OK',
};
/** Lo que Helvetica escribe bien: ASCII, Latin-1 y los signos de WinAnsi. */
const IMPRIMIBLE = /[\x20-\x7E\xA0-\xFF€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ\n]/;
export function paraPdf(texto: string): string {
  return [...texto]
    .map((c) => EQUIVALENTES[c] ?? (IMPRIMIBLE.test(c) ? c : ''))
    .join('');
}

/** Carta apaisada, porque una tabla de solicitudes es ancha. */
export async function tablaEnPdf(t: Tabla): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'LETTER', layout: 'landscape', margin: 36 });
  const trozos: Buffer[] = [];
  doc.on('data', (b: Buffer) => trozos.push(b));
  const listo = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(trozos))));

  const izquierda = doc.page.margins.left;
  const util = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const suma = t.columnas.reduce((a, c) => a + c.ancho, 0);
  const anchos = t.columnas.map((c) => (c.ancho / suma) * util);
  const abajo = doc.page.height - doc.page.margins.bottom;
  const FUENTE = 8;
  const RELLENO = 3;

  // Una fila con sus celdas; «unida» es un rotulo a todo lo ancho y el monto al
  // final (grupos, subtotales, total), para que el rotulo no se amontone en la
  // primera columna.
  const fila = (
    todas: string[],
    opciones: { negrita?: boolean; fondo?: string; blanco?: boolean; unida?: boolean } = {},
  ): void => {
    const celdas = opciones.unida ? [todas[0], todas[todas.length - 1]] : todas;
    const anchosFila = opciones.unida
      ? [util - anchos[anchos.length - 1], anchos[anchos.length - 1]]
      : anchos;
    doc.font(opciones.negrita ? 'Helvetica-Bold' : 'Helvetica').fontSize(FUENTE);
    const alto = Math.max(
      ...celdas.map((c, i) => doc.heightOfString(paraPdf(c), { width: anchosFila[i] - 2 * RELLENO })),
    ) + 2 * RELLENO;
    if (doc.y + alto > abajo) {
      doc.addPage();
      encabezado();
    }
    const y = doc.y;
    if (opciones.fondo) doc.rect(izquierda, y, util, alto).fill(opciones.fondo);
    doc.fillColor(opciones.blanco ? '#FFFFFF' : '#1B2422');
    let x = izquierda;
    celdas.forEach((c, i) => {
      const esMonto = i === celdas.length - 1;
      doc.text(paraPdf(c), x + RELLENO, y + RELLENO, {
        width: anchosFila[i] - 2 * RELLENO,
        align: esMonto ? 'right' : 'left',
      });
      x += anchosFila[i];
    });
    doc.moveTo(izquierda, y + alto).lineTo(izquierda + util, y + alto).lineWidth(0.3).strokeColor('#C9D3CF').stroke();
    doc.x = izquierda;
    doc.y = y + alto;
  };
  const encabezado = (): void => {
    fila(t.columnas.map((c) => c.titulo), { negrita: true, fondo: '#1F3A4D', blanco: true });
  };
  doc.font('Helvetica-Bold').fontSize(14).fillColor('#1B2422').text(paraPdf(`Pinellas · ${t.titulo}`), izquierda);
  doc.font('Helvetica').fontSize(9).fillColor('#4A5652').text(paraPdf(`Filtro: ${t.filtro}`));
  doc.text(`Al ${t.corte} · ${t.total.cantidad} solicitudes`);
  doc.moveDown(0.6);
  encabezado();

  for (const g of t.grupos) {
    if (g.nombre !== null) fila([g.nombre, ''], { negrita: true, fondo: '#E6EFF7', unida: true });
    for (const f of g.filas) fila([...f.celdas, dinero(f.monto)]);
    if (g.nombre !== null) {
      fila([`Subtotal ${g.nombre} (${g.cantidad})`, dinero(g.subtotal)], { negrita: true, unida: true });
    }
  }
  fila([`Total (${t.total.cantidad})`, dinero(t.total.monto)], { negrita: true, fondo: '#E6EFF7', unida: true });

  doc.end();
  return listo;
}

/** «Solicitudes-20260929.xlsx». */
export function nombreDeTabla(formato: 'pdf' | 'excel'): string {
  const dia = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Panama' }).replace(/-/g, '');
  return `Solicitudes-${dia}.${formato === 'pdf' ? 'pdf' : 'xlsx'}`;
}

export const TIPO_EXCEL = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
