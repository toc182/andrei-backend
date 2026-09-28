// Un papel muy grande tiene que salir, y rápido.
// npx tsx scripts/papel-grande.spec.ts
//
// Nace del 2026-09-28: el semanal RS-PBR-260921 (8.5 MB, 15 fotos) no salió
// nunca en Railway. El PDF se armaba pasándole el HTML al navegador con
// setContent, y pasado cierto tamaño eso se cuelga: medido en una computadora,
// 17 MB salían en 2 s y 34 MB no salían ni en 60 s. En Railway el límite está
// más abajo. aPdf ahora escribe el HTML en un archivo y lo abre; este papel de
// ~35 MB es el que antes se colgaba aquí mismo.
import sharp from 'sharp';
import { aPdf } from '../src/services/reportePdfComun.js';

let ok = 0; let fallo = 0;
const c = (cond: boolean, etq: string) => {
  if (cond) ok += 1; else { fallo += 1; console.log('FALLA ', etq); }
};

const main = async () => {
  // Una foto de ruido (no comprime), unos 0.85 MB en base64: 42 de ellas pasan de 34 MB.
  const ruido = Buffer.alloc(1100 * 700 * 3);
  for (let i = 0; i < ruido.length; i += 1) ruido[i] = (i * 2654435761) >>> 24;
  const jpg = await sharp(ruido, { raw: { width: 1100, height: 700, channels: 3 } })
    .jpeg({ quality: 95 }).toBuffer();
  const src = `data:image/jpeg;base64,${jpg.toString('base64')}`;
  const fotos = Array.from({ length: 42 }, (_, i) => `<figure><img src="${src}" alt=""><figcaption>${i + 1}.</figcaption></figure>`);
  const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><h1>Papel grande</h1>${fotos.join('')}</body></html>`;
  const mb = html.length / 1024 / 1024;
  c(mb > 30, `el papel de prueba pesa más de 30 MB (pesa ${mb.toFixed(1)})`);

  const t = Date.now();
  let pdf: Buffer | null = null;
  try {
    pdf = await aPdf(html, 'Prueba');
  } catch (e) {
    console.log('aPdf falló:', (e as Error).message);
  }
  const ms = Date.now() - t;
  c(pdf !== null && pdf.subarray(0, 4).toString() === '%PDF', 'sale un PDF');
  c(ms < 20_000, `y sale en menos de 20 s (tardó ${ms} ms)`);

  console.log(`${ok} pasaron, ${fallo} fallaron`);
  process.exit(fallo ? 1 : 0);
};
main();
