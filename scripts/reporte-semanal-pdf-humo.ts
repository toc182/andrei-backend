// Prueba de humo del PDF y la cola de correo del reporte semanal.
// cd andrei-backend && npm run pruebas -- reporte-semanal-pdf
//
// El PDF es lo único de todo esto que sale de la empresa, así que lo que se
// vigila aquí es que exista, que pese lo que pesa un PDF, que se archive en R2
// al enviarlo y que la cola lo mande UNA vez y no dos.
//
// Las fotos entran a propósito: son lo que rompió el PDF del diario en
// producción (12 fotos sin reducir colgaban el navegador), y el semanal usa el
// mismo camino.
import { API } from './pruebas/contexto.js';
import jwt from 'jsonwebtoken';
import sharp from 'sharp';
import { query, pool } from '../src/database/config.js';
import { procesarEnviosSemanalesPendientes } from '../src/services/reporteSemanalEnvio.js';

const P = 1;
const LUNES = '2026-11-02'; // semana 45 de 2026, que no toca ninguna otra prueba

const main = async () => {
  const admin = await query<{ id: number; email: string; rol: string }>(
    "SELECT id, email, rol FROM users WHERE rol='admin' AND activo=true ORDER BY id LIMIT 1");
  const token = jwt.sign(
    { userId: admin.rows[0].id, email: admin.rows[0].email, rol: admin.rows[0].rol },
    process.env.JWT_SECRET!, { expiresIn: '10m' },
  );

  const pedir = async (m: string, r: string, b?: unknown) => {
    const res = await fetch(`${API}${r}`, {
      method: m,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(b ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(b ? { body: JSON.stringify(b) } : {}),
    });
    const tipo = res.headers.get('content-type') ?? '';
    return {
      estado: res.status,
      tipo,
      cuerpo: tipo.includes('json') ? await res.json().catch(() => null) : null,
      bytes: tipo.includes('pdf') ? Buffer.from(await res.arrayBuffer()) : null,
    };
  };

  let ok = 0; let fallo = 0;
  const c = (cond: boolean, etq: string) => {
    if (cond) ok += 1; else { fallo += 1; console.log('FALLA ', etq); }
  };

  // ---- un día de obra con dos fotos ----
  const listas = await pedir('GET', `/proyecto-listas/${P}`);
  const puesto = listas.cuerpo.data.puestos[0];
  const equipo = listas.cuerpo.data.equipos[0];
  const creado = await pedir('POST', `/proyecto-reportes/${P}`, {
    fecha: LUNES, clima: 'Lluvia parcial', que_se_hizo: 'Colado de losa del nivel 3',
    horas_perdidas: 2, motivo: 'Lluvia de 1 a 3 pm',
    personal: [{ puesto_id: puesto.id, cantidad: 12 }],
    equipos: equipo ? [{ equipo_id: equipo.id, unidades: 1, horas: 6 }] : [],
  });
  const diarioId = creado.cuerpo.data.id as number;

  // Dos fotos de verdad, hechas aqui: el PDF las baja, las reduce y las mete.
  let tono = 0;
  for (const leyenda of ['Colado de la losa', '']) {
    tono += 1;
    const jpg = await sharp({
      create: { width: 640, height: 480, channels: 3,
        background: { r: (tono * 61) % 256, g: (tono * 37) % 256, b: 90 } },
    }).jpeg().toBuffer();
    const datos = new FormData();
    datos.append('leyenda', leyenda);
    datos.append('fotos', new Blob([new Uint8Array(jpg)], { type: 'image/jpeg' }), 'obra.jpg');
    await fetch(`${API}/proyecto-reportes/${P}/${diarioId}/fotos`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: datos,
    });
  }
  await pedir('POST', `/proyecto-reportes/${P}/${diarioId}/emitir`);

  // ---- el reporte semanal ----
  const semanal = await pedir('POST', `/proyecto-reportes-semanales/${P}`, { fecha: LUNES });
  const id = semanal.cuerpo.data.id as number;
  const detalle = await pedir('GET', `/proyecto-reportes-semanales/${P}/${id}`);
  const fotos = (detalle.cuerpo.data.fotos ?? []) as { id: number }[];
  c(fotos.length === 2, `las dos fotos del diario se ofrecen al semanal (ofrecio ${fotos.length})`);

  await pedir('PUT', `/proyecto-reportes-semanales/${P}/${id}`, {
    resumen: 'Semana de estructura: se coló la losa del nivel 3 y se perdieron 2 horas por lluvia.',
    lo_que_se_espera: 'Cerrar el nivel 3.',
    metas_plan: [{ texto: 'Colar la rampa', cantidad: 7, unidad: 'm3' }],
    problemas: [{
      fecha: LUNES, problema: 'Lluvia por la tarde', accion: 'Se cubrio el acero',
      // Contestado: sin eso el reporte no sale (migración 174).
      pendiente: false,
    }],
    decisiones: [{ texto: 'Aprobar la madera adicional' }],
    fotos: fotos.map((f) => f.id),
  });

  // ---- el PDF del borrador se arma al vuelo ----
  const previo = await pedir('GET', `/proyecto-reportes-semanales/${P}/${id}/pdf`);
  c(previo.estado === 200 && previo.tipo.includes('pdf'),
    `el borrador ya deja ver su PDF (dio ${previo.estado} ${previo.tipo})`);
  c((previo.bytes?.length ?? 0) > 20_000,
    `y pesa lo que pesa un PDF con fotos (${previo.bytes?.length ?? 0} bytes)`);
  c(previo.bytes?.subarray(0, 4).toString() === '%PDF', 'y es de verdad un PDF');
  c((await query<{ n: string }>(
    'SELECT COUNT(*)::text n FROM proyecto_reporte_semanal_pdfs WHERE reporte_id = $1', [id],
  )).rows[0].n === '0', 'mirar el borrador NO archiva ninguna version');

  // ---- se envía: entra en la cola ----
  await pedir('POST', `/proyecto-reportes-semanales/${P}/${id}/emitir`);
  const enCola = await query<{ envio_proximo_intento: Date | null; enviado_at: Date | null }>(
    'SELECT envio_proximo_intento, enviado_at FROM proyecto_reportes_semanales WHERE id = $1', [id]);
  c(enCola.rows[0].envio_proximo_intento !== null, 'al enviarlo entra en la cola de correo');
  c(enCola.rows[0].enviado_at === null, 'y todavia no esta enviado: lo manda el cron');

  // ---- la cola lo manda y archiva su PDF ----
  await procesarEnviosSemanalesPendientes();
  const despues = await query<{ enviado_at: Date | null; envio_proximo_intento: Date | null }>(
    'SELECT enviado_at, envio_proximo_intento FROM proyecto_reportes_semanales WHERE id = $1', [id]);
  c(despues.rows[0].enviado_at !== null, 'la cola lo manda');
  c(despues.rows[0].envio_proximo_intento === null, 'y lo saca de la cola');

  const pdfs = await query<{ version: number; r2_key: string }>(
    'SELECT version, r2_key FROM proyecto_reporte_semanal_pdfs WHERE reporte_id = $1 ORDER BY version', [id]);
  c(pdfs.rows.length === 1 && pdfs.rows[0].version === 1, 'queda archivada la version 1');
  c(pdfs.rows[0].r2_key.includes('/reportes-semanales/') && pdfs.rows[0].r2_key.endsWith('.pdf'),
    `y en su carpeta (${pdfs.rows[0]?.r2_key})`);

  // Otra pasada no puede mandarlo dos veces.
  await procesarEnviosSemanalesPendientes();
  const otra = await query<{ n: string }>(
    'SELECT COUNT(*)::text n FROM proyecto_reporte_semanal_pdfs WHERE reporte_id = $1', [id]);
  c(otra.rows[0].n === '1', 'una segunda pasada del cron no lo manda otra vez');

  // ---- el PDF que se ve ahora es el archivado ----
  const enviado = await pedir('GET', `/proyecto-reportes-semanales/${P}/${id}/pdf`);
  c(enviado.estado === 200 && (enviado.bytes?.length ?? 0) > 20_000,
    'el PDF del reporte enviado se sigue pudiendo abrir');

  console.log(`${ok} pasaron, ${fallo} fallaron`);
  await pool.end();
  process.exit(fallo ? 1 : 0);
};
main();
