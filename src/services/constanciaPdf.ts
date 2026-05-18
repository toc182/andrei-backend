import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Assets live at andrei-backend/assets/ — resolved relative to the
// running script. Works in both dev (tsx watch from src/) and prod
// (node from dist/) because src/ and dist/ are siblings of assets/.
const ASSETS_DIR = path.join(__dirname, '..', '..', 'assets');

const NAVY     = rgb(0.1216, 0.2157, 0.3725); // #1F375F — Pinellas Navy
const SLATE_700 = rgb(0.2,    0.255,  0.333);  // body text
const SLATE_500 = rgb(0.392,  0.455,  0.545);  // footer / muted
const SLATE_300 = rgb(0.796,  0.835,  0.882);  // dividers
const BLACK     = rgb(0,      0,      0);

export interface ConstanciaCierreData {
  cajaNombre: string;
  proyectoNombre: string;
  responsableNombre: string;
  fechaCierre: Date;
}

export async function generateConstanciaCierreCajaMenuda(
  data: ConstanciaCierreData,
): Promise<Buffer> {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.registerFontkit(fontkit);

  // Embed brand fonts.
  const serifSemibold = await pdfDoc.embedFont(
    fs.readFileSync(path.join(ASSETS_DIR, 'fonts', 'SourceSerif4-Semibold.ttf')),
  );
  const sansRegular = await pdfDoc.embedFont(
    fs.readFileSync(path.join(ASSETS_DIR, 'fonts', 'SourceSans3-Regular.ttf')),
  );
  const sansMedium = await pdfDoc.embedFont(
    fs.readFileSync(path.join(ASSETS_DIR, 'fonts', 'SourceSans3-Medium.ttf')),
  );

  // Embed logo.
  const logoBytes = fs.readFileSync(path.join(ASSETS_DIR, 'logo.png'));
  const logo = await pdfDoc.embedPng(logoBytes);
  const logoDims = logo.scaleToFit(120, 60);

  const page = pdfDoc.addPage([595, 842]); // A4 portrait
  const { height } = page.getSize();
  const margin = 56; // ~20mm

  // Logo, top-left.
  page.drawImage(logo, {
    x: margin,
    y: height - margin - logoDims.height,
    width: logoDims.width,
    height: logoDims.height,
  });

  // Title, two lines, serif semibold, navy.
  let y = height - margin - logoDims.height - 56;
  page.drawText('CONSTANCIA DE CIERRE', {
    x: margin,
    y,
    size: 22,
    font: serifSemibold,
    color: NAVY,
  });
  y -= 28;
  page.drawText('DE CAJA MENUDA', {
    x: margin,
    y,
    size: 22,
    font: serifSemibold,
    color: NAVY,
  });

  // 2pt navy underline.
  y -= 12;
  page.drawLine({
    start: { x: margin, y },
    end: { x: margin + 320, y },
    thickness: 2,
    color: NAVY,
  });

  // Intro paragraph, sans regular.
  y -= 36;
  const intro = [
    'Por medio de la presente se hace constar que la Caja Menuda',
    'detallada a continuación ha sido cerrada con saldo cero,',
    'sin fondos pendientes de devolución.',
  ];
  for (const line of intro) {
    page.drawText(line, {
      x: margin,
      y,
      size: 11,
      font: sansRegular,
      color: SLATE_700,
    });
    y -= 18;
  }

  // Key-value table.
  y -= 28;
  const fechaTxt = data.fechaCierre.toLocaleDateString('es-PA', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  });
  const rows: Array<[string, string]> = [
    ['Caja Menuda:',     data.cajaNombre],
    ['Proyecto:',        data.proyectoNombre],
    ['Responsable:',     data.responsableNombre],
    ['Fecha de cierre:', fechaTxt],
    ['Saldo final:',     'B/. 0.00'],
  ];
  const labelX = margin;
  const valueX = margin + 130;
  for (const [label, value] of rows) {
    page.drawText(label, {
      x: labelX,
      y,
      size: 12,
      font: sansMedium,
      color: SLATE_500,
    });
    page.drawText(value, {
      x: valueX,
      y,
      size: 12,
      font: sansRegular,
      color: BLACK,
    });
    y -= 22;
  }

  // Footer: auto-gen note, right-aligned, muted.
  const now = new Date();
  const generadoTxt = `Documento generado automáticamente · ${now.toLocaleDateString(
    'es-PA',
    { day: '2-digit', month: '2-digit', year: 'numeric' },
  )} ${now.toLocaleTimeString('es-PA', { hour: '2-digit', minute: '2-digit', hour12: false })}`;
  const footerWidth = sansRegular.widthOfTextAtSize(generadoTxt, 9);
  const footerY = 56;
  page.drawLine({
    start: { x: margin, y: footerY + 14 },
    end:   { x: 595 - margin, y: footerY + 14 },
    thickness: 0.5,
    color: SLATE_300,
  });
  page.drawText(generadoTxt, {
    x: 595 - margin - footerWidth,
    y: footerY,
    size: 9,
    font: sansRegular,
    color: SLATE_500,
  });

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}
