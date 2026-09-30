// Prueba de humo: cuarenta fotos por reporte, y todas en el PDF.
// npm run pruebas -- reporte-fotos-tope
//
// Salio del reporte de Cesar del 2026-09-30: subio 40 fotos y en el PDF salieron
// 27, porque el techo de peso era de unos 9 MB. Decision de Ivan: techo mas alto
// y un tope de 40 fotos. Se exige:
// - desde la pantalla, la foto 41 se rechaza con un mensaje claro;
// - fotos tan pesadas que no caben se aprietan todas en vez de dejar alguna
//   fuera del PDF;
// - por WhatsApp, al pasar de 40 el asistente recibe el aviso para decirlo, y
//   al reporte entran solo las primeras 40.
import { API } from './pruebas/contexto.js';
import { SECRETOS_PRUEBA } from './pruebas/entorno.js';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import sharp from 'sharp';
import { query, pool } from '../src/database/config.js';
import { uploadFile } from '../src/services/storage.js';
import { claveReducida, incrustarFotos } from '../src/services/reportePdfComun.js';
import { conversacionViva, guardarConversacion } from '../src/services/whatsapp/conversacion.js';
import { armarBorrador } from '../src/services/whatsapp/borrador.js';

const META = process.env.PRUEBAS_META ?? '';
const NUMERO = '50761110004';
const P = 1;

let fallos = 0;
const exigir = (bien: boolean, que: string, visto?: unknown): void => {
  console.log(`${bien ? '  ok  ' : 'FALLA '} ${que}${bien || visto === undefined ? '' : ` → ${JSON.stringify(visto)}`}`);
  if (!bien) fallos += 1;
};
const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

const main = async () => {
  const admin = (
    await query<{ id: number; email: string; rol: string }>(
      "SELECT id, email, rol FROM users WHERE rol = 'admin' AND activo ORDER BY id LIMIT 1",
    )
  ).rows[0];
  const token = jwt.sign({ userId: admin.id, email: admin.email, rol: admin.rol }, process.env.JWT_SECRET!, {
    expiresIn: '10m',
  });
  const pequena = await sharp({
    create: { width: 40, height: 30, channels: 3, background: { r: 10, g: 90, b: 60 } },
  }).jpeg().toBuffer();

  // ── desde la pantalla: la 41 no entra ───────────────────────────────────
  const creado = await fetch(`${API}/proyecto-reportes/${P}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fecha: '2026-09-10', clima: 'Soleado', que_se_hizo: 'Prueba del tope de fotos' }),
  });
  const reporteId = ((await creado.json()) as { data: { id: number } }).data.id;
  for (let i = 1; i <= 40; i += 1) {
    await query(
      `INSERT INTO proyecto_reporte_fotos (reporte_id, nombre_archivo, r2_key, tipo_mime, tamano, orden, creado_por)
       VALUES ($1, $2, $3, 'image/jpeg', 100, $4, $5)`,
      [reporteId, `f${i}.jpg`, `PRUEBAS1/tope/pantalla-${i}.jpg`, i, admin.id],
    );
  }
  const subir = async () => {
    const form = new FormData();
    form.append('fotos', new Blob([new Uint8Array(pequena)], { type: 'image/jpeg' }), 'otra.jpg');
    const r = await fetch(`${API}/proyecto-reportes/${P}/${reporteId}/fotos`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form,
    });
    return { estado: r.status, cuerpo: (await r.json().catch(() => null)) as { message?: string } | null };
  };
  const la41 = await subir();
  exigir(
    la41.estado === 409 && Boolean(la41.cuerpo?.message?.includes('máximo 40 fotos')),
    'con 40 fotos, la 41 se rechaza y se dice por qué',
    la41,
  );
  await query('DELETE FROM proyecto_reporte_fotos WHERE reporte_id = $1 AND orden = 40', [reporteId]);
  const la40 = await subir();
  exigir(la40.estado === 201, 'con 39, una más sí entra', la40.estado);

  // ── fotos que no caben: se aprietan todas ───────────────────────────────
  // Ruido: lo que no deja al JPEG comprimir. Treinta copias reducidas de este
  // peso pasan del techo del PDF.
  const pesadas: { r2_key: string; nombre_archivo: string; tipo_mime: string }[] = [];
  let bruto = 0;
  for (let i = 0; i < 30; i += 1) {
    const bytes = await sharp({
      create: {
        width: 1400, height: 1050, channels: 3, background: { r: 0, g: 0, b: 0 },
        noise: { type: 'gaussian', mean: 100 + i * 3, sigma: 30 },
      },
    }).jpeg({ quality: 82 }).toBuffer();
    bruto += bytes.length;
    const clave = `PRUEBAS1/tope/pesada-${i}.jpg`;
    await uploadFile(claveReducida(clave), bytes, 'image/jpeg');
    pesadas.push({ r2_key: clave, nombre_archivo: `pesada-${i}.jpg`, tipo_mime: 'image/jpeg' });
  }
  exigir(bruto > 15 * 1024 * 1024, 'las treinta pasan del techo tal como están', `${(bruto / 1024 / 1024).toFixed(1)} MB`);
  const { lista, omitidas } = await incrustarFotos(pesadas);
  const peso = lista.reduce((a, f) => a + f.src.length, 0);
  exigir(
    lista.length === 30 && omitidas === 0 && peso <= 20 * 1024 * 1024,
    'se aprietan todas y entran las treinta, sin dejar ninguna fuera',
    { entran: lista.length, omitidas, mb: (peso / 1024 / 1024).toFixed(1) },
  );

  // ── por WhatsApp: el aviso y las primeras 40 ────────────────────────────
  await query('UPDATE users SET whatsapp = $1 WHERE id = $2', [NUMERO, admin.id]);
  const conversacion = await conversacionViva(NUMERO, admin.id);
  conversacion.proyectoId = P;
  conversacion.modo = 'reporte_diario';
  conversacion.datos = {
    fecha: '2026-09-11', clima: 'Soleado', preguntadas: ['fecha'],
    trabajos: [{ areaId: null, texto: 'Prueba del tope por WhatsApp' }],
  };
  await guardarConversacion(conversacion.id, {
    proyectoId: P, modo: 'reporte_diario', datos: conversacion.datos,
  });
  // Cuarenta fotos ya atendidas, y lo ultimo que salio fue una respuesta.
  for (let i = 1; i <= 40; i += 1) {
    await query(
      `INSERT INTO whatsapp_mensajes (direccion, wa_id, telefono, user_id, tipo, conversacion_id, r2_key, procesado_at)
       VALUES ('entrante', $1, $2, $3, 'image', $4, $5, CURRENT_TIMESTAMP)`,
      [`wamid.T${i}`, NUMERO, admin.id, conversacion.id, `whatsapp/tope/${i}.jpg`],
    );
  }
  await query(
    `INSERT INTO whatsapp_mensajes (direccion, telefono, tipo, texto, conversacion_id, procesado_at)
     VALUES ('saliente', $1, 'text', 'Recibí las fotos.', $2, CURRENT_TIMESTAMP)`,
    [NUMERO, conversacion.id],
  );

  // La 41, de verdad, por el webhook.
  const media = (await (
    await fetch(`${META}/_prueba/media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base64: pequena.toString('base64'), tipoMime: 'image/jpeg' }),
    })
  ).json()) as { mediaId: string };
  await fetch(`${META}/_prueba/ia`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([{ content: [{ type: 'text', text: 'Van 41: la última no entra.' }], stop_reason: 'end_turn' }]),
  });
  const crudo = Buffer.from(
    JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{
        id: '1',
        changes: [{
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { phone_number_id: SECRETOS_PRUEBA.numeroId },
            messages: [{ id: 'wamid.T41', from: NUMERO, type: 'image', image: { id: media.mediaId, mime_type: 'image/jpeg' } }],
          },
        }],
      }],
    }),
    'utf8',
  );
  await fetch(`${API}/whatsapp/webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Hub-Signature-256':
        'sha256=' + crypto.createHmac('sha256', SECRETOS_PRUEBA.appSecret).update(crudo).digest('hex'),
    },
    body: crudo,
  });
  let peticiones: { system?: { text: string }[] }[] = [];
  for (const hasta = Date.now() + 20000; Date.now() < hasta && peticiones.length === 0; ) {
    peticiones = (await (await fetch(`${META}/_prueba/ia/peticiones`)).json()) as never;
    if (peticiones.length === 0) await esperar(250);
  }
  const sistema = (peticiones.at(-1)?.system ?? []).map((s) => s.text).join('\n');
  exigir(
    sistema.includes('entran solo las primeras 40') && sistema.includes('Ya van 41'),
    'al pasar de 40 por WhatsApp, el asistente recibe el aviso para decirlo',
  );

  const borrador = await armarBorrador(await conversacionViva(NUMERO, admin.id));
  const enElReporte = borrador.ok
    ? (await query<{ n: number }>('SELECT COUNT(*)::int AS n FROM proyecto_reporte_fotos WHERE reporte_id = $1', [borrador.reporteId])).rows[0].n
    : -1;
  exigir(enElReporte === 40, 'y al reporte entran solo las primeras 40', borrador.ok ? enElReporte : borrador);

  await pool.end();
  console.log(fallos === 0 ? '\nTodo bien' : `\n${fallos} fallo(s)`);
  process.exit(fallos === 0 ? 0 : 1);
};

main().catch(async (e) => {
  console.error(e);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
