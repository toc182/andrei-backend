// Prueba de humo de la cola de envío del reporte, contra el servidor local.
// cd andrei-backend && npx tsx --env-file=.env scripts/reporte-cola-humo.ts
//
// Comprueba lo que cambió el 2026-09-11: /emitir ya no manda el correo, lo
// encola; el servidor lo manda por su cuenta; y una fila reservada no se puede
// coger dos veces, que es lo único que separa un reintento de un correo doble.
//
// Borra en un finally el reporte y los PDF que archiva en R2.
import jwt from 'jsonwebtoken';
import { query, pool } from '../src/database/config.js';
import { deleteFile } from '../src/services/storage.js';
import { procesarEnviosPendientes } from '../src/routes/proyectoReportes.js';
import {
  encolarEnvio,
  reservarPendientes,
  anotarFallo,
  MAX_INTENTOS,
} from '../src/services/reporteEnvio.js';

const API = 'http://localhost:5000/api';
const P = 1;

type Fila = {
  enviado_at: Date | null;
  envio_proximo_intento: Date | null;
  envio_intentos: number;
  envio_ultimo_error: string | null;
};

const main = async () => {
  // Salvaguarda: con clave de Resend esto mandaría correos de verdad.
  if (process.env.RESEND_API_KEY) {
    console.log('ABORTA: hay RESEND_API_KEY. Esta prueba mandaría correos reales.');
    await pool.end();
    process.exit(1);
  }

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

  const fila = async (id: number): Promise<Fila> =>
    (await query<Fila>(
      `SELECT enviado_at, envio_proximo_intento, envio_intentos, envio_ultimo_error
         FROM proyecto_reportes WHERE id = $1`, [id])).rows[0];

  let id: number | null = null;

  try {
    const creado = await pedir('POST', `/proyecto-reportes/${P}`, {
      fecha: '2026-09-11', clima: 'Soleado', que_se_hizo: 'Prueba de la cola de envio',
    });
    c(creado.estado === 201, `crea el reporte (dio ${creado.estado})`);
    id = creado.cuerpo.data.id as number;

    const recien = await fila(id);
    c(recien.envio_proximo_intento === null, 'un reporte recien creado NO esta en cola');

    // ---- /emitir encola y contesta enseguida, sin mandar nada ----
    const t = Date.now();
    const emitido = await pedir('POST', `/proyecto-reportes/${P}/${id}/emitir`);
    const ms = Date.now() - t;
    c(emitido.estado === 200, `emitir responde bien (dio ${emitido.estado})`);
    c(emitido.cuerpo?.data?.encolado === true, 'emitir dice que lo encolo');
    c(ms < 2000, `emitir contesta sin esperar al correo (tardo ${ms} ms)`);

    const enCola = await fila(id);
    c(enCola.envio_proximo_intento !== null, 'quedo en cola');
    c(enCola.enviado_at === null, 'y todavia NO figura como enviado');
    c(enCola.envio_intentos === 0, 'con la cuenta de intentos a cero');

    // ---- reservar es lo que impide el correo doble ----
    const primera = await reservarPendientes();
    c(primera.some((r) => r.id === id), 'la primera pasada del cron lo coge');
    const segunda = await reservarPendientes();
    c(!segunda.some((r) => r.id === id),
      'una segunda pasada a la vez NO lo vuelve a coger (esto evita el correo doble)');

    // ---- el trabajador lo manda de verdad ----
    await encolarEnvio(id);
    await procesarEnviosPendientes();
    const tras = await fila(id);
    c(tras.enviado_at !== null, 'el trabajador lo deja enviado');
    c(tras.envio_proximo_intento === null, 'y lo saca de la cola');
    c(tras.envio_ultimo_error === null, 'sin error anotado');

    // ---- ya enviado, emitir no lo reencola ----
    const otra = await pedir('POST', `/proyecto-reportes/${P}/${id}/emitir`);
    c(otra.cuerpo?.data?.reenviado === false, 'un segundo emitir no reenvia');
    c((await fila(id)).envio_proximo_intento === null, 'y no lo vuelve a poner en cola');

    // ---- cuando se acaban los intentos ----
    await query('UPDATE proyecto_reportes SET enviado_at = NULL WHERE id = $1', [id]);
    const agotado = await anotarFallo(id, MAX_INTENTOS - 1, 'fallo de mentira');
    c(agotado === true, 'al ultimo intento avisa de que se agoto');
    const final = await fila(id);
    c(final.envio_proximo_intento === null, 'y lo saca de la cola para no insistir en bucle');
    c(final.envio_ultimo_error === 'fallo de mentira', 'guarda el motivo real del fallo');

    const medias = await anotarFallo(id, 0, 'otro fallo');
    c(medias === false, 'un fallo temprano NO se da por agotado');
    c((await fila(id)).envio_proximo_intento !== null, 'y lo deja en cola para reintentar');
  } finally {
    if (id) {
      const pdfs = await query<{ r2_key: string }>(
        'SELECT r2_key FROM proyecto_reporte_pdfs WHERE reporte_id = $1', [id]);
      for (const p of pdfs.rows) await deleteFile(p.r2_key).catch(() => {});
      await query('DELETE FROM proyecto_reportes WHERE id = $1', [id]);
      console.log(`limpiado: ${pdfs.rows.length} PDF(s) de R2 y el reporte`);
    }
  }

  console.log(`${ok} pasaron, ${fallo} fallaron`);
  await pool.end();
  process.exit(fallo ? 1 : 0);
};
main();
