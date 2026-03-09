import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import QRCode from 'qrcode';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Types ---

interface SolicitudData {
  numero: string;
  fecha: string;
  proveedor: string;
  proyecto_nombre: string;
  preparado_nombre: string;
  solicitado_nombre: string | null;
  observaciones: string | null;
  urgente: boolean;
  subtotal: number;
  descuentos: number;
  impuestos: number;
  monto_total: number;
  beneficiario: string | null;
  banco: string | null;
  tipo_cuenta: string | null;
  numero_cuenta: string | null;
}

interface ItemData {
  descripcion: string;
  descripcion_detallada: string | null;
  cantidad: number;
  unidad: string;
  precio_unitario: number;
  precio_total: number;
}

interface AjusteData {
  tipo: string;
  descripcion: string;
  monto: number;
}

interface AprobacionData {
  usuario_nombre: string;
  accion: string;
  fecha: string;
}

interface PDFInput {
  solicitud: SolicitudData;
  items: ItemData[];
  ajustes: AjusteData[];
  aprobaciones: AprobacionData[];
  comprobante?: {
    fecha_pago: string;
    registrado_por_nombre: string;
  };
  factura?: {
    fecha_factura: string;
    numero_factura?: string;
    registrado_por_nombre: string;
  };
  codigo_verificacion?: string;
}

// --- Colors ---
const NAVY = '#1a365d';
const GRAY = '#718096';
const LIGHT_BG = '#f7fafc';
const BANK_BG = '#f0f4f8';
const APPROVAL_BG = '#f0fff4';

// --- Layout constants ---
const MARGIN = 40;
const PAGE_BOTTOM = 752; // 792 - 40 margin

// --- Helpers ---

function formatMoney(amount: number): string {
  return `B/. ${Number(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(dateString: string): string {
  const date = new Date(dateString);
  return date.toLocaleDateString('es-PA', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

// --- Main generator ---

export async function generateSolicitudPDF(data: PDFInput): Promise<Buffer> {
  // Pre-generate QR code buffer (must be done before entering PDFKit's sync callback)
  let qrBuffer: Buffer | null = null;
  let verifyUrl = '';
  if (data.codigo_verificacion) {
    verifyUrl = `https://sistema.pinellaspanama.com/verificar/${data.codigo_verificacion}`;
    const qrDataUrl = await QRCode.toDataURL(verifyUrl, {
      width: 180,
      margin: 0,
      color: { dark: '#1a365d', light: '#ffffff' }
    });
    qrBuffer = Buffer.from(qrDataUrl.split(',')[1], 'base64');
  }

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'LETTER',
      margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
      bufferPages: true
    });

    doc.info.Title = `SP-${data.solicitud.numero}`;

    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const pageWidth = 612 - MARGIN * 2; // 532
    const tableX = MARGIN;

    // Load logo
    const logoPath = path.resolve(__dirname, '../../templates/LogoPinellas.png');
    let logoBuffer: Buffer | null = null;
    try {
      logoBuffer = fs.readFileSync(logoPath);
    } catch {
      // Logo not found, continue without it
    }

    // Table column config
    const cols = [24, 220, 40, 40, 104, 104]; // = 532
    const colHeaders = ['#', 'Descripción', 'Cant.', 'Und.', 'P.Unit (B/.)', 'P.Total (B/.)'];

    // Draw table header row (reusable for page breaks)
    const drawTableHeader = (atY: number) => {
      doc.rect(tableX, atY, pageWidth, 16).fill(NAVY);
      doc.font('Helvetica-Bold').fontSize(7).fillColor('#ffffff');
      let cx = tableX + 3;
      for (let i = 0; i < colHeaders.length; i++) {
        const align = i >= 4 ? 'right' : 'left';
        doc.text(colHeaders[i], cx, atY + 4, { width: cols[i] - 6, align, lineBreak: false });
        cx += cols[i];
      }
    };

    // ==========================================
    // 1. HEADER
    // ==========================================
    let y = MARGIN;

    if (logoBuffer) {
      doc.image(logoBuffer, MARGIN, y, { width: 80 });
    }

    doc.font('Helvetica-Bold').fontSize(14).fillColor(NAVY);
    doc.text('SOLICITUD DE PAGO', 0, y + 2, { align: 'right', width: 612 - MARGIN, lineBreak: false });
    doc.font('Helvetica').fontSize(10).fillColor(NAVY);
    doc.text(data.solicitud.numero, 0, y + 20, { align: 'right', width: 612 - MARGIN, lineBreak: false });

    // Separator line
    y += 38;
    doc.moveTo(MARGIN, y).lineTo(MARGIN + pageWidth, y).strokeColor(NAVY).lineWidth(0.75).stroke();

    // ==========================================
    // 2. DATOS GENERALES (compact 2-col grid)
    // ==========================================
    y += 8;
    const colLeft = MARGIN;
    const colRight = MARGIN + pageWidth / 2 + 5;
    const colW = pageWidth / 2 - 5;

    const drawField = (label: string, value: string, x: number, yPos: number, w: number): number => {
      doc.font('Helvetica').fontSize(7).fillColor(GRAY);
      doc.text(label, x, yPos, { width: w, lineBreak: false });
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#000000');
      doc.text(value || '-', x, yPos + 9, { width: w, lineBreak: false });
      return yPos + 22;
    };

    // Row 1: Fecha | Proyecto
    y = drawField('Fecha', formatDate(data.solicitud.fecha), colLeft, y, colW);
    drawField('Proyecto', data.solicitud.proyecto_nombre || '-', colRight, y - 22, colW);

    // Row 2: Proveedor | Solicitado por
    y = drawField('Proveedor', data.solicitud.proveedor, colLeft, y, colW);
    drawField('Solicitado por', data.solicitud.solicitado_nombre || '-', colRight, y - 22, colW);

    // Row 3: Preparado por | Urgente badge
    y = drawField('Preparado por', data.solicitud.preparado_nombre || '-', colLeft, y, colW);
    if (data.solicitud.urgente) {
      doc.save();
      const badgeX = colRight;
      const badgeY = y - 14;
      doc.roundedRect(badgeX, badgeY, 58, 14, 2).fill('#e53e3e');
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#ffffff');
      doc.text('URGENTE', badgeX + 8, badgeY + 3, { lineBreak: false });
      doc.restore();
    }

    // ==========================================
    // 3. TABLA DE ITEMS
    // ==========================================
    y += 3;

    // Table header
    drawTableHeader(y);
    y += 16;

    // Item rows
    for (let idx = 0; idx < data.items.length; idx++) {
      const item = data.items[idx];
      const isAlt = idx % 2 === 1;

      // Calculate row height
      const descHeight = doc.font('Helvetica').fontSize(8).heightOfString(item.descripcion, { width: cols[1] - 6 });
      const detailHeight = item.descripcion_detallada
        ? doc.font('Helvetica').fontSize(6.5).heightOfString(item.descripcion_detallada, { width: cols[1] - 6 })
        : 0;
      const rowHeight = Math.max(15, descHeight + detailHeight + (item.descripcion_detallada ? 8 : 5));

      // Page break: repeat table header on new page
      if (y + rowHeight > PAGE_BOTTOM) {
        doc.addPage();
        y = MARGIN;
        drawTableHeader(y);
        y += 16;
      }

      // Alternating background
      if (isAlt) {
        doc.rect(tableX, y, pageWidth, rowHeight).fill(LIGHT_BG);
      }

      let cx = tableX + 3;

      // # column
      doc.font('Helvetica').fontSize(8).fillColor('#000000');
      doc.text(String(idx + 1), cx, y + 3, { width: cols[0] - 6, lineBreak: false });
      cx += cols[0];

      // Description
      doc.font('Helvetica').fontSize(8).fillColor('#000000');
      doc.text(item.descripcion, cx, y + 3, { width: cols[1] - 6 });
      if (item.descripcion_detallada) {
        const mainH = doc.font('Helvetica').fontSize(8).heightOfString(item.descripcion, { width: cols[1] - 6 });
        doc.font('Helvetica').fontSize(6.5).fillColor(GRAY);
        doc.text(item.descripcion_detallada, cx, y + 3 + mainH + 1, { width: cols[1] - 6 });
      }
      cx += cols[1];

      // Quantity
      doc.font('Helvetica').fontSize(8).fillColor('#000000');
      doc.text(String(item.cantidad), cx, y + 3, { width: cols[2] - 6, lineBreak: false });
      cx += cols[2];

      // Unit
      doc.text(item.unidad, cx, y + 3, { width: cols[3] - 6, lineBreak: false });
      cx += cols[3];

      // Unit price
      doc.text(formatMoney(item.precio_unitario).replace('B/. ', ''), cx, y + 3, { width: cols[4] - 6, align: 'right', lineBreak: false });
      cx += cols[4];

      // Total price
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#000000');
      doc.text(formatMoney(item.precio_total).replace('B/. ', ''), cx, y + 3, { width: cols[5] - 6, align: 'right', lineBreak: false });

      y += rowHeight;
    }

    // Table bottom border
    doc.moveTo(tableX, y).lineTo(tableX + pageWidth, y).strokeColor('#e2e8f0').lineWidth(0.5).stroke();

    // ==========================================
    // 4. TOTALES
    // ==========================================
    y += 6;
    const totalsValueX = tableX + 3 + cols[0] + cols[1] + cols[2] + cols[3] + cols[4];
    const totalsValueW = cols[5] - 6;
    const totalsLabelW = 110;
    const totalsLabelX = totalsValueX - totalsLabelW - 5;

    if (y + 50 > PAGE_BOTTOM) { doc.addPage(); y = MARGIN; }

    // Subtotal
    doc.font('Helvetica').fontSize(8).fillColor(GRAY);
    doc.text('Subtotal:', totalsLabelX, y, { width: totalsLabelW, align: 'right', lineBreak: false });
    doc.font('Helvetica').fontSize(8).fillColor('#000000');
    doc.text(formatMoney(data.solicitud.subtotal), totalsValueX, y, { width: totalsValueW, align: 'right', lineBreak: false });
    y += 13;

    // Ajustes
    for (const ajuste of data.ajustes) {
      const isDescuento = ajuste.tipo === 'descuento';
      const color = isDescuento ? '#e53e3e' : '#000000';
      const montoStr = isDescuento
        ? `- ${formatMoney(Math.abs(ajuste.monto))}`
        : formatMoney(Math.abs(ajuste.monto));
      doc.font('Helvetica').fontSize(8).fillColor(GRAY);
      doc.text(`${ajuste.descripcion}:`, totalsLabelX, y, { width: totalsLabelW, align: 'right', lineBreak: false });
      doc.font('Helvetica').fontSize(8).fillColor(color);
      doc.text(montoStr, totalsValueX, y, { width: totalsValueW, align: 'right', lineBreak: false });
      y += 13;
    }

    // Total line
    doc.moveTo(totalsLabelX + 20, y).lineTo(totalsValueX + totalsValueW, y).strokeColor('#cbd5e0').lineWidth(0.5).stroke();
    y += 4;

    doc.font('Helvetica-Bold').fontSize(10).fillColor(NAVY);
    doc.text('TOTAL:', totalsLabelX, y, { width: totalsLabelW, align: 'right', lineBreak: false });
    doc.text(formatMoney(data.solicitud.monto_total), totalsValueX, y, { width: totalsValueW, align: 'right', lineBreak: false });
    y += 18;

    // ==========================================
    // 5. OBSERVACIONES
    // ==========================================
    if (data.solicitud.observaciones) {
      if (y + 30 > PAGE_BOTTOM) { doc.addPage(); y = MARGIN; }

      const obsH = doc.font('Helvetica').fontSize(8).heightOfString(data.solicitud.observaciones, { width: pageWidth - 16 });
      const boxH = obsH + 22;

      doc.roundedRect(tableX, y, pageWidth, boxH, 2).strokeColor('#e2e8f0').lineWidth(0.5).stroke();
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(NAVY);
      doc.text('Observaciones', tableX + 8, y + 5, { width: pageWidth - 16, lineBreak: false });
      doc.font('Helvetica').fontSize(8).fillColor('#000000');
      doc.text(data.solicitud.observaciones, tableX + 8, y + 16, { width: pageWidth - 16 });
      y += boxH + 6;
    }

    // ==========================================
    // 6. DATOS BANCARIOS (inline 2-col)
    // ==========================================
    if (data.solicitud.beneficiario || data.solicitud.banco) {
      if (y + 30 > PAGE_BOTTOM) { doc.addPage(); y = MARGIN; }

      const bankLines: Array<[string, string]> = [];
      if (data.solicitud.beneficiario) bankLines.push(['Beneficiario', data.solicitud.beneficiario]);
      if (data.solicitud.banco) bankLines.push(['Banco', data.solicitud.banco]);
      if (data.solicitud.tipo_cuenta) bankLines.push(['Tipo cuenta', data.solicitud.tipo_cuenta]);
      if (data.solicitud.numero_cuenta) bankLines.push(['Nro. cuenta', data.solicitud.numero_cuenta]);

      // Layout: 2 fields per row
      const bankRows = Math.ceil(bankLines.length / 2);
      const bankBoxH = 18 + bankRows * 13;

      doc.roundedRect(tableX, y, pageWidth, bankBoxH, 2).fill(BANK_BG);
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(NAVY);
      doc.text('Datos Bancarios', tableX + 8, y + 5, { width: pageWidth - 16, lineBreak: false });

      let bY = y + 18;
      const halfW = (pageWidth - 16) / 2;
      for (let i = 0; i < bankLines.length; i += 2) {
        // Left field
        doc.font('Helvetica').fontSize(7).fillColor(GRAY);
        doc.text(`${bankLines[i][0]}: `, tableX + 8, bY, { width: halfW, continued: true, lineBreak: false });
        doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#000000');
        doc.text(bankLines[i][1], { lineBreak: false });
        // Right field
        if (i + 1 < bankLines.length) {
          doc.font('Helvetica').fontSize(7).fillColor(GRAY);
          doc.text(`${bankLines[i + 1][0]}: `, tableX + 8 + halfW, bY, { width: halfW, continued: true, lineBreak: false });
          doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#000000');
          doc.text(bankLines[i + 1][1], { lineBreak: false });
        }
        bY += 13;
      }
      y += bankBoxH + 6;
    }

    // ==========================================
    // 7. APROBACIONES
    // ==========================================
    const approvedAprobaciones = data.aprobaciones.filter(a => a.accion === 'aprobado');
    if (approvedAprobaciones.length > 0) {
      if (y + 25 > PAGE_BOTTOM) { doc.addPage(); y = MARGIN; }

      const apBoxH = 18 + approvedAprobaciones.length * 13;

      doc.roundedRect(tableX, y, pageWidth, apBoxH, 2).fill(APPROVAL_BG);
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#276749');
      doc.text('Aprobaciones', tableX + 8, y + 5, { width: pageWidth - 16, lineBreak: false });

      let apY = y + 18;
      for (const aprobacion of approvedAprobaciones) {
        doc.font('Helvetica').fontSize(7.5).fillColor('#276749');
        doc.text(`\u2713 ${aprobacion.usuario_nombre} — ${formatDate(aprobacion.fecha)}`, tableX + 8, apY, { width: pageWidth - 16, lineBreak: false });
        apY += 13;
      }
      y += apBoxH + 6;
    }

    // ==========================================
    // 8. COMPROBANTE DE PAGO
    // ==========================================
    if (data.comprobante) {
      if (y + 40 > PAGE_BOTTOM) { doc.addPage(); y = MARGIN; }

      const PAYMENT_BG = '#eff6ff';
      const cpBoxH = 32;

      doc.roundedRect(tableX, y, pageWidth, cpBoxH, 2).fill(PAYMENT_BG);
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#1e40af');
      doc.text('Comprobante de Pago', tableX + 8, y + 5, { width: pageWidth - 16, lineBreak: false });

      doc.font('Helvetica').fontSize(7.5).fillColor('#1e40af');
      doc.text(`Fecha de pago: ${formatDate(data.comprobante.fecha_pago)}  —  Registrado por: ${data.comprobante.registrado_por_nombre}`, tableX + 8, y + 18, { width: pageWidth - 16, lineBreak: false });

      y += cpBoxH + 6;
    }

    // ==========================================
    // 9. FACTURA
    // ==========================================
    if (data.factura) {
      if (y + 40 > PAGE_BOTTOM) { doc.addPage(); y = MARGIN; }

      const FACTURA_BG = '#f0fdf4';
      let factText = `Fecha de factura: ${formatDate(data.factura.fecha_factura)}`;
      if (data.factura.numero_factura) {
        factText += `  —  Nro: ${data.factura.numero_factura}`;
      }
      factText += `  —  Registrado por: ${data.factura.registrado_por_nombre}`;

      const factBoxH = 32;

      doc.roundedRect(tableX, y, pageWidth, factBoxH, 2).fill(FACTURA_BG);
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#166534');
      doc.text('Factura', tableX + 8, y + 5, { width: pageWidth - 16, lineBreak: false });

      doc.font('Helvetica').fontSize(7.5).fillColor('#166534');
      doc.text(factText, tableX + 8, y + 18, { width: pageWidth - 16, lineBreak: false });

      y += factBoxH + 6;
    }

    // ==========================================
    // 10. QR DE VERIFICACIÓN
    // ==========================================
    if (qrBuffer) {
      const qrSize = 60;
      const qrBlockH = qrSize + 10;

      if (y + qrBlockH > PAGE_BOTTOM) { doc.addPage(); y = MARGIN; }

      doc.image(qrBuffer, tableX, y, { width: qrSize, height: qrSize });

      doc.font('Helvetica').fontSize(7).fillColor(GRAY);
      doc.text('Escanee para verificar autenticidad', tableX + qrSize + 10, y + 18, { width: 200, lineBreak: false });
      doc.font('Helvetica').fontSize(6).fillColor(GRAY);
      doc.text(verifyUrl, tableX + qrSize + 10, y + 30, { width: 250, lineBreak: false });
    }

    doc.end();
  });
}
