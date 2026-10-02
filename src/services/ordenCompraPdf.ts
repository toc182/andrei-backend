/**
 * El papel de la orden de compra: lo que Martina baja y le manda al proveedor.
 *
 * Sigue el modelo en Excel que Pinellas ya usaba (correo de compras del
 * 2026-09-24), con dos diferencias que Ivan pidio:
 *
 *   * Donde el modelo tenia tres rayas para firmar —elaborado, verificado,
 *     aprobado— va el codigo de verificacion. Las firmas ya viven en el
 *     sistema; el papel solo dice que la orden fue aprobada, y quien quiera
 *     los nombres escanea el codigo.
 *   * El termino de pago aparece arriba, junto al proyecto: el proveedor
 *     necesita leerlo, y el modelo nunca lo traia.
 */
import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import QRCode from 'qrcode';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const NAVY = '#1a365d';
const GRIS = '#718096';
const GRIS_LINEA = '#94a3b8';
const BANDA = '#e2e8f0';
const TINTA = '#0f172a';

const MARGEN = 40;
const ANCHO = 612 - MARGEN * 2; // 532
const FONDO_PAGINA = 792 - MARGEN;

/** Las seis columnas del modelo, sumando 532. */
const COLS = [46, 44, 58, 214, 80, 90];
const CABECERAS = ['Cant.', 'Unidad', 'Código', 'Descripción del producto o servicio', 'P. Unit.', 'P. Total'];

export interface OrdenPdfItem {
  cantidad: number | string;
  unidad: string;
  codigo: string | null;
  descripcion: string;
  precio_unitario: number | string;
  precio_total: number | string;
}

export interface OrdenPdfInput {
  numero: string;
  /** Del pool viene como Date; de una prueba, como texto. Las dos sirven. */
  fecha: string | Date;
  proveedor: string;
  proveedor_ruc: string | null;
  proyecto_nombre: string;
  termino_dias: number;
  entrega: string;
  condiciones: string | null;
  subtotal: number | string;
  descuento: number | string;
  itbms_tasa: number | string;
  itbms: number | string;
  monto_total: number | string;
  items: OrdenPdfItem[];
  /** Solo se dibuja el codigo cuando la orden ya paso por todas las firmas. */
  codigo_verificacion: string | null;
  aprobada: boolean;
}

const dinero = (n: number | string): string =>
  Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const cantidad = (n: number | string): string => {
  const v = Number(n);
  // 1200 se lee «1,200» y 1.5 se lee «1.5»: los sacos son enteros y los metros
  // cubicos no siempre.
  return Number.isInteger(v)
    ? v.toLocaleString('en-US')
    : v.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 3 });
};

/**
 * dd/mm/aaaa, armada a mano y en UTC.
 *
 * Con toLocaleDateString esta fecha salia dos veces mal: el 2026-08-18 se
 * imprimia «08/17/2026». Lo primero es que `new Date('2026-08-18')` es
 * medianoche UTC, y visto desde Panama (UTC-5) todavia es el 17. Lo segundo es
 * que el formato de es-PA depende del ICU que traiga el Node de turno, y en
 * Railway no tiene por que ser el mismo que aqui. Un papel que le llega al
 * proveedor no puede decir un dia distinto segun donde se genere.
 */
function fecha(valor: string | Date): string {
  const d = valor instanceof Date ? valor : new Date(`${String(valor).slice(0, 10)}T00:00:00Z`);
  const dia = String(d.getUTCDate()).padStart(2, '0');
  const mes = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${dia}/${mes}/${d.getUTCFullYear()}`;
}

function terminoEnPalabras(dias: number): string {
  if (dias === 0) return 'Contado';
  return `${dias} día${dias === 1 ? '' : 's'} desde cada entrega`;
}

export async function generarOrdenCompraPDF(data: OrdenPdfInput): Promise<Buffer> {
  // El QR se arma antes de entrar a PDFKit: dentro del dibujo no se puede esperar.
  let qr: Buffer | null = null;
  let urlVerificar = '';
  if (data.aprobada && data.codigo_verificacion) {
    urlVerificar = `https://sistema.pinellaspanama.com/verificar/${data.codigo_verificacion}`;
    const dataUrl = await QRCode.toDataURL(urlVerificar, {
      width: 180,
      margin: 0,
      color: { dark: NAVY, light: '#ffffff' },
    });
    qr = Buffer.from(dataUrl.split(',')[1], 'base64');
  }

  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'LETTER',
      margins: { top: MARGEN, bottom: MARGEN, left: MARGEN, right: MARGEN },
      bufferPages: true,
    });
    doc.info.Title = data.numero;

    const trozos: Buffer[] = [];
    doc.on('data', (t: Buffer) => trozos.push(t));
    doc.on('end', () => resolve(Buffer.concat(trozos)));
    doc.on('error', reject);

    // ---------------------------------------------------------- encabezado
    let y = MARGEN;
    try {
      const logo = fs.readFileSync(path.resolve(__dirname, '../../templates/LogoPinellas.png'));
      doc.image(logo, MARGEN, y, { width: 150 });
    } catch {
      // Sin logo el papel sigue saliendo; no vale la pena tumbar la descarga.
      doc.font('Helvetica-Bold').fontSize(14).fillColor(NAVY).text('PINELLAS, S.A.', MARGEN, y + 8);
    }

    doc
      .font('Helvetica-Bold')
      .fontSize(16)
      .fillColor(NAVY)
      .text('ORDEN DE COMPRA', MARGEN, y + 4, { width: ANCHO, align: 'right' });

    doc.font('Helvetica').fontSize(9).fillColor(GRIS);
    doc.text('N°', MARGEN, y + 28, { width: ANCHO - 100, align: 'right' });
    doc.text('Fecha', MARGEN, y + 42, { width: ANCHO - 100, align: 'right' });
    doc.font('Helvetica-Bold').fontSize(10).fillColor(TINTA);
    doc.text(data.numero, MARGEN, y + 27, { width: ANCHO, align: 'right' });
    doc.text(fecha(data.fecha), MARGEN, y + 41, { width: ANCHO, align: 'right' });

    y += 74;

    // ------------------------------------------------- proveedor y proyecto
    const anchoCaja = (ANCHO - 12) / 2;
    const cajaAlto = 52;
    const caja = (x: number, titulo: string, linea1: string, linea2: string | null) => {
      doc.rect(x, y, anchoCaja, cajaAlto).lineWidth(0.7).strokeColor(GRIS_LINEA).stroke();
      doc.rect(x, y, anchoCaja, 15).fill(BANDA);
      doc.font('Helvetica-Bold').fontSize(7).fillColor(TINTA);
      doc.text(titulo.toUpperCase(), x + 6, y + 5, { width: anchoCaja - 12 });
      doc.font('Helvetica-Bold').fontSize(10).fillColor(TINTA);
      doc.text(linea1, x + 6, y + 21, { width: anchoCaja - 12, ellipsis: true, height: 13 });
      if (linea2) {
        doc.font('Helvetica').fontSize(8).fillColor('#334155');
        doc.text(linea2, x + 6, y + 35, { width: anchoCaja - 12, ellipsis: true, height: 11 });
      }
    };
    caja(MARGEN, 'Proveedor', data.proveedor, data.proveedor_ruc ? `RUC ${data.proveedor_ruc}` : null);
    caja(
      MARGEN + anchoCaja + 12,
      'Proyecto / cuenta',
      data.proyecto_nombre,
      `Término de pago: ${terminoEnPalabras(data.termino_dias)}`,
    );

    y += cajaAlto + 14;

    // ------------------------------------------------------------ la tabla
    const dibujarCabecera = (enY: number): number => {
      doc.rect(MARGEN, enY, ANCHO, 16).fill(BANDA);
      doc.rect(MARGEN, enY, ANCHO, 16).lineWidth(0.7).strokeColor(GRIS_LINEA).stroke();
      doc.font('Helvetica-Bold').fontSize(7).fillColor(TINTA);
      let x = MARGEN;
      CABECERAS.forEach((etq, i) => {
        const alineado = i === 0 || i >= 4 ? 'right' : 'left';
        doc.text(etq, x + 4, enY + 5, { width: COLS[i] - 8, align: alineado });
        x += COLS[i];
      });
      return enY + 16;
    };

    y = dibujarCabecera(y);

    doc.font('Helvetica').fontSize(8.5);
    for (const it of data.items) {
      const textos = [
        cantidad(it.cantidad),
        it.unidad,
        it.codigo ?? '',
        it.descripcion,
        dinero(it.precio_unitario),
        dinero(it.precio_total),
      ];
      // La descripcion es la que puede envolver: de ella sale el alto de la fila.
      const altoDesc = doc.heightOfString(textos[3], { width: COLS[3] - 8 });
      const alto = Math.max(18, altoDesc + 8);

      if (y + alto > FONDO_PAGINA - 60) {
        doc.addPage();
        y = dibujarCabecera(MARGEN);
        doc.font('Helvetica').fontSize(8.5);
      }

      doc.rect(MARGEN, y, ANCHO, alto).lineWidth(0.5).strokeColor('#cbd5e1').stroke();
      let x = MARGEN;
      textos.forEach((t, i) => {
        if (i > 0) doc.moveTo(x, y).lineTo(x, y + alto).lineWidth(0.5).strokeColor('#cbd5e1').stroke();
        doc.fillColor(i === 2 ? GRIS : TINTA);
        doc.text(t, x + 4, y + 4, {
          width: COLS[i] - 8,
          align: i === 0 || i >= 4 ? 'right' : 'left',
        });
        x += COLS[i];
      });
      y += alto;
    }

    // ------------------------------------------------------------- totales
    const anchoEtq = 90;
    const anchoVal = COLS[5];
    const xEtq = MARGEN + ANCHO - anchoVal - anchoEtq;
    const fila = (etq: string, valor: string, fuerte = false) => {
      if (y + 18 > FONDO_PAGINA - 40) {
        doc.addPage();
        y = MARGEN;
      }
      if (fuerte) doc.rect(xEtq, y, anchoEtq + anchoVal, 18).fill(BANDA);
      doc.rect(xEtq, y, anchoEtq + anchoVal, 18).lineWidth(0.5).strokeColor(GRIS_LINEA).stroke();
      doc
        .font(fuerte ? 'Helvetica-Bold' : 'Helvetica')
        .fontSize(fuerte ? 9.5 : 8.5)
        .fillColor(TINTA);
      doc.text(etq, xEtq + 5, y + 5, { width: anchoEtq - 10, align: 'right' });
      doc.text(valor, xEtq + anchoEtq + 4, y + 5, { width: anchoVal - 8, align: 'right' });
      y += 18;
    };

    const tasa = Number(data.itbms_tasa);
    fila('Sub total', dinero(data.subtotal));
    fila('Descuento', dinero(data.descuento));
    fila(`ITBMS ${(tasa * 100).toFixed(tasa * 100 % 1 === 0 ? 0 : 2)}%`, dinero(data.itbms));
    fila('Total', dinero(data.monto_total), true);

    y += 16;

    // ------------------------------------------------------------- entrega
    if (y + 20 > FONDO_PAGINA - 40) {
      doc.addPage();
      y = MARGEN;
    }
    const casilla = (x: number, marcada: boolean, etq: string) => {
      doc.rect(x, y, 9, 9).lineWidth(0.8).strokeColor(marcada ? TINTA : GRIS_LINEA).stroke();
      if (marcada) {
        doc
          .moveTo(x + 2, y + 4.5)
          .lineTo(x + 3.8, y + 6.6)
          .lineTo(x + 7, y + 2.4)
          .lineWidth(1.3)
          .strokeColor(TINTA)
          .stroke();
      }
      doc.font('Helvetica').fontSize(9).fillColor(marcada ? TINTA : GRIS);
      doc.text(etq, x + 14, y + 1);
    };
    casilla(MARGEN, data.entrega === 'sitio', 'Entrega en sitio');
    casilla(MARGEN + 150, data.entrega === 'local', 'Retiro en el local');

    y += 24;

    // -------------------------------------------------------- condiciones
    const altoCond = Math.max(
      44,
      doc.font('Helvetica').fontSize(9).heightOfString(data.condiciones ?? '', { width: ANCHO - 12 }) + 26,
    );
    if (y + altoCond > FONDO_PAGINA - 110) {
      doc.addPage();
      y = MARGEN;
    }
    doc.rect(MARGEN, y, ANCHO, altoCond).lineWidth(0.7).strokeColor(GRIS_LINEA).stroke();
    doc.rect(MARGEN, y, ANCHO, 15).fill(BANDA);
    doc.font('Helvetica-Bold').fontSize(7).fillColor(TINTA);
    doc.text('COMENTARIOS ADICIONALES Y/O CONDICIONES DE COMPRA', MARGEN + 6, y + 5);
    if (data.condiciones) {
      doc.font('Helvetica').fontSize(9).fillColor(TINTA);
      doc.text(data.condiciones, MARGEN + 6, y + 21, { width: ANCHO - 12 });
    }
    y += altoCond + 18;

    // ------------------------------------------------------------- el pie
    if (y + 100 > FONDO_PAGINA) {
      doc.addPage();
      y = MARGEN;
    }
    doc.moveTo(MARGEN, y).lineTo(MARGEN + ANCHO, y).lineWidth(0.7).strokeColor('#cbd5e1').stroke();
    y += 14;

    if (qr) {
      doc.image(qr, MARGEN, y, { width: 76 });
      const xTexto = MARGEN + 92;
      const anchoTexto = ANCHO - 92;
      doc.font('Helvetica-Bold').fontSize(9).fillColor(TINTA);
      doc.text('Aprobada en el sistema de Pinellas', xTexto, y + 2, { width: anchoTexto });
      doc.font('Helvetica').fontSize(8).fillColor(GRIS);
      doc.text(
        `Escanee el código o visite ${urlVerificar} para confirmar que esta orden salió de Pinellas y ver quién la aprobó.`,
        xTexto,
        y + 18,
        { width: anchoTexto },
      );
    } else {
      // Sin todas las firmas no hay codigo que dar: el papel lo dice en vez de
      // dejar un hueco que se pueda confundir con una orden aprobada.
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#B45309');
      doc.text('BORRADOR — esta orden todavía no está aprobada', MARGEN, y, { width: ANCHO });
    }

    doc.end();
  });
}
