// Prueba de humo del PDF con muchas fotos, contra el servidor local.
//
// Nace del fallo del 2026-09-10: el PDF incrustaba cada foto a tamano
// original, y pasada la decima la cadena que recibe setContent se hacia tan
// grande que Puppeteer dejaba de responder y se rendia a los 30 segundos. Se
// cayeron el envio por correo y el boton de ver el PDF, sin decir por que.
//
// Sube 12 fotos de 12 megapixeles, como las que manda un celular, y exige que
// el PDF salga. Borra en un finally todo lo que crea, aqui y en R2.
import jwt from 'jsonwebtoken';
import sharp from 'sharp';
import { query, pool } from '../src/database/config.js';
import { deleteFile, downloadFile } from '../src/services/storage.js';
import { generateReportePDF } from '../src/services/reportePdf.js';

const API = 'http://localhost:5000/api';
const P = 1;
const CUANTAS = 12;
const TECHO_MS = 15_000;
const TECHO_PDF = 10 * 1024 * 1024;

const main = async () => {
  const u = await query<{ id: number; email: string; rol: string }>(
    "SELECT id, email, rol FROM users WHERE rol='admin' AND activo=true ORDER BY id LIMIT 1");
  const token = jwt.sign(
    { userId: u.rows[0].id, email: u.rows[0].email, rol: u.rows[0].rol },
    process.env.JWT_SECRET!, { expiresIn: '10m' });

  const pedir = async (m: string, r: string, b?: unknown) => {
    const res = await fetch(`${API}${r}`, {
      method: m,
      headers: { Authorization: `Bearer ${token}`, ...(b ? { 'Content-Type': 'application/json' } : {}) },
      ...(b ? { body: JSON.stringify(b) } : {}),
    });
    return { estado: res.status, cuerpo: await res.json().catch(() => null) };
  };

  let ok = 0; let fallo = 0;
  const c = (cond: boolean, etq: string) => {
    if (cond) ok += 1; else { fallo += 1; console.log('FALLA ', etq); }
  };

  let id: number | null = null;
  const claves: string[] = [];

  try {
    // Fotos de celular: 4032x3024 con ruido, que es lo que no deja al JPEG
    // comprimir y lo que hace que una foto real pese megabytes.
    const fotos: Buffer[] = [];
    for (let i = 0; i < CUANTAS; i++) {
      fotos.push(await sharp({
        create: {
          width: 4032, height: 3024, channels: 3,
          noise: { type: 'gaussian', mean: 110 + i * 8, sigma: 14 },
        },
      }).jpeg({ quality: 80 }).toBuffer());
    }
    const pesoTotal = fotos.reduce((a, b) => a + b.length, 0);
    console.log(`${CUANTAS} fotos de ${(fotos[0].length / 1024 / 1024).toFixed(2)} MB c/u = ${(pesoTotal / 1024 / 1024).toFixed(1)} MB`);
    c(fotos.every((f) => f.length < 10 * 1024 * 1024), 'cada foto cabe en el limite de subida');

    const creado = await pedir('POST', `/proyecto-reportes/${P}`, {
      fecha: '2026-09-10', clima: 'Soleado', que_se_hizo: 'Prueba de fotos pesadas',
    });
    c(creado.estado === 201, `crea el reporte (dio ${creado.estado})`);
    id = creado.cuerpo.data.id;

    const form = new FormData();
    fotos.forEach((f, i) => form.append('fotos', new Blob([new Uint8Array(f)], { type: 'image/jpeg' }), `obra-${i + 1}.jpg`));
    const subida = await fetch(`${API}/proyecto-reportes/${P}/${id}/fotos`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form,
    });
    const subidas = await subida.json().catch(() => null);
    c(subida.status === 201, `suben las ${CUANTAS} fotos (dio ${subida.status})`);
    for (const f of subidas?.data ?? []) claves.push(f.r2_key);
    c(claves.length === CUANTAS, `quedaron guardadas las ${CUANTAS} (hay ${claves.length})`);

    // Un reporte recien creado es borrador y su PDF da 404 hasta que /emitir
    // lo completa.
    const emitido = await pedir('POST', `/proyecto-reportes/${P}/${id}/emitir`);
    c(emitido.estado === 200, `emitir completa el reporte (dio ${emitido.estado})`);

    // El fallo: aqui se colgaba.
    const t = Date.now();
    const res = await fetch(`${API}/proyecto-reportes/${P}/${id}/pdf`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const pdf = Buffer.from(await res.arrayBuffer());
    const ms = Date.now() - t;
    console.log(`PDF: ${res.status}, ${(pdf.length / 1024 / 1024).toFixed(1)} MB, ${(ms / 1000).toFixed(1)} s`);

    c(res.status === 200, `el PDF con ${CUANTAS} fotos sale (dio ${res.status})`);
    c(ms < TECHO_MS, `sale en menos de ${TECHO_MS / 1000} s (tardo ${(ms / 1000).toFixed(1)} s)`);
    c(pdf.subarray(0, 4).toString() === '%PDF', 'es un PDF de verdad');
    c(pdf.length < TECHO_PDF, `pesa menos de ${TECHO_PDF / 1024 / 1024} MB y cabe en un correo (pesa ${(pdf.length / 1024 / 1024).toFixed(1)})`);
    c(pdf.length > 200 * 1024, 'trae las fotos dentro, no solo el texto');

    // Otra vez pero por dentro, para ver en que se va el tiempo. Lo caro es
    // bajar los originales de R2, no reducirlos ni dibujar el PDF.
    const propio = await generateReportePDF({
      numero: 'PRUEBA-001', fechaLarga: '10 de septiembre de 2026', fechaCorta: '10 sep',
      proyectoNombre: 'Prueba', autorNombre: 'Prueba', clima: 'Soleado',
      horasPerdidas: null, motivo: null, personalCalificado: 0, ayudantes: 0,
      equipo: [], personal: [], equipos: [], entregas: [], areas: [],
      queSeHizo: 'Prueba', atrasos: null, novedades: null, correcciones: [],
      fotos: claves.map((k, i) => ({ r2_key: k, nombre_archivo: `obra-${i + 1}.jpg`, tipo_mime: 'image/jpeg' })),
    });
    c(propio.length > 200 * 1024, 'el generador llamado directo tambien saca el PDF');

    // El original se guarda intacto: solo se reduce la copia que va al papel.
    const guardada = await downloadFile(claves[0]);
    c(guardada.length === fotos[0].length, 'la foto guardada sigue a tamano original');
  } finally {
    for (const k of claves) await deleteFile(k).catch(() => {});
    if (id) await query('DELETE FROM proyecto_reportes WHERE id = $1', [id]);
    const quedan = await query<{ n: string }>(
      'SELECT count(*) n FROM proyecto_reporte_fotos WHERE reporte_id = $1', [id ?? 0]);
    console.log('filas de fotos tras limpiar:', quedan.rows[0].n);
  }

  console.log(`${ok} pasaron, ${fallo} fallaron`);
  await pool.end();
  process.exit(fallo ? 1 : 0);
};
main();
