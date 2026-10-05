// Prueba de humo: una solicitud de pago pedida por su número solo se ve si es
// de un proyecto que esa persona puede ver.
// cd andrei-backend && npm run pruebas -- solicitud-acceso
//
// Encontrado el 2026-10-05 probando el enlace del WhatsApp de las urgentes
// (/solicitud/<id>): con acceso solo a un proyecto, cambiar el número en la
// dirección abría la solicitud de cualquier otro, datos de banco incluidos. Se
// exige, para alguien con acceso solo al proyecto 1:
// - la suya se abre; la del proyecto 3 da 404, como si no existiera, al abrirla,
//   en su PDF, sus correcciones, sus adjuntos y al intentar aprobarla;
// - un adjunto de la del proyecto 3 no se baja ni se borra por su número;
// - las rutas sin número (la lista, el contador) siguen como estaban;
// - el admin las abre todas;
// - el detalle dice si quien lo abre ya la marcó como revisada.
import { API } from './pruebas/contexto.js';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { query, pool } from '../src/database/config.js';

interface Usuario {
  id: number;
  email: string;
  rol: string;
}

const main = async () => {
  const admin = (
    await query<Usuario>("SELECT id, email, rol FROM users WHERE rol='admin' AND activo=true ORDER BY id LIMIT 1")
  ).rows[0];
  const ingeniero = (
    await query<Usuario>("SELECT id, email, rol FROM users WHERE email = 'aprobador1@pruebas.local'")
  ).rows[0];
  await query(
    `INSERT INTO user_permissions (user_id, solicitudes_ver) VALUES ($1, true)
     ON CONFLICT (user_id) DO UPDATE SET solicitudes_ver = true`,
    [ingeniero.id],
  );
  await query('INSERT INTO user_project_access (user_id, proyecto_id) VALUES ($1, 1) ON CONFLICT DO NOTHING', [ingeniero.id]);

  const solicitud = async (proyecto: number, numero: string): Promise<number> =>
    (await query<{ id: number }>(
      `INSERT INTO solicitudes_pago
         (proyecto_id, numero, fecha, proveedor, preparado_por, solicitado_por, subtotal, monto_total,
          estado, numero_cuenta, codigo_verificacion)
       VALUES ($1, $2, CURRENT_DATE, 'Proveedor de pruebas', $3, $3, 100, 100, 'pendiente', '0400-1234-5678', $4)
       RETURNING id`,
      [proyecto, numero, admin.id, randomUUID().slice(0, 8)],
    )).rows[0].id;
  const adjunto = async (solicitudId: number): Promise<number> =>
    (await query<{ id: number }>(
      `INSERT INTO solicitud_pago_adjuntos (solicitud_pago_id, nombre_original, r2_key, tipo_mime, tamano, subido_por)
       VALUES ($1, 'cotizacion.pdf', $2, 'application/pdf', 10, $3) RETURNING id`,
      [solicitudId, `PRUEBAS/no-existe-${randomUUID()}.pdf`, admin.id],
    )).rows[0].id;
  const suya = await solicitud(1, 'PRU1-901');
  const ajena = await solicitud(3, 'PRU3-901');
  const adjuntoAjeno = await adjunto(ajena);
  await adjunto(suya);
  await query('INSERT INTO solicitud_revisiones (solicitud_pago_id, user_id) VALUES ($1, $2)', [suya, ingeniero.id]);

  const firmar = (u: Usuario) =>
    jwt.sign({ userId: u.id, email: u.email, rol: u.rol }, process.env.JWT_SECRET!, { expiresIn: '10m' });
  const pedir = async (u: Usuario, metodo: string, ruta: string, cuerpo?: unknown) => {
    const res = await fetch(`${API}${ruta}`, {
      method: metodo,
      headers: { Authorization: `Bearer ${firmar(u)}`, 'Content-Type': 'application/json' },
      body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
    });
    const texto = await res.text();
    return { estado: res.status, texto };
  };

  let ok = 0;
  let fallo = 0;
  const c = (cond: boolean, etq: string) => {
    if (cond) ok += 1;
    else {
      fallo += 1;
      console.log('FALLA ', etq);
    }
  };

  const laSuya = await pedir(ingeniero, 'GET', `/solicitudes-pago/${suya}`);
  c(laSuya.estado === 200 && laSuya.texto.includes('PRU1-901'), `la de su proyecto se abre (dio ${laSuya.estado})`);
  c(laSuya.texto.includes('"revisada":true'), 'y dice que ya la marcó como revisada');

  for (const [metodo, ruta, que] of [
    ['GET', `/solicitudes-pago/${ajena}`, 'abrirla'],
    ['GET', `/solicitudes-pago/${ajena}/pdf`, 'su PDF'],
    ['GET', `/solicitudes-pago/${ajena}/correcciones`, 'sus correcciones'],
    ['GET', `/solicitudes-pago/${ajena}/adjuntos`, 'sus adjuntos'],
    ['GET', `/solicitudes-pago/${ajena}/adjuntos/urls`, 'los enlaces de sus adjuntos'],
    ['POST', `/solicitudes-pago/${ajena}/aprobar`, 'aprobarla'],
    ['POST', `/solicitudes-pago/${ajena}/revisar`, 'marcarla como revisada'],
    ['GET', `/solicitudes-pago/adjuntos/${adjuntoAjeno}/download`, 'bajar uno de sus adjuntos'],
    ['DELETE', `/solicitudes-pago/adjuntos/${adjuntoAjeno}`, 'borrar uno de sus adjuntos'],
  ] as const) {
    const r = await pedir(ingeniero, metodo, ruta, metodo === 'POST' ? { password: 'x' } : undefined);
    c(r.estado === 404 && !r.texto.includes('0400-1234-5678'), `la del proyecto 3, ${que}: 404 (dio ${r.estado})`);
  }
  const sigue = await query('SELECT 1 FROM solicitud_pago_adjuntos WHERE id = $1', [adjuntoAjeno]);
  c(sigue.rows.length === 1, 'y el adjunto ajeno sigue ahí');
  const revisadaAjena = await query('SELECT 1 FROM solicitud_revisiones WHERE solicitud_pago_id = $1', [ajena]);
  c(revisadaAjena.rows.length === 0, 'y la ajena no quedó marcada como revisada');

  const suyosAdjuntos = await pedir(ingeniero, 'GET', `/solicitudes-pago/${suya}/adjuntos`);
  c(suyosAdjuntos.estado === 200, `los adjuntos de la suya sí (dio ${suyosAdjuntos.estado})`);

  const lista = await pedir(ingeniero, 'GET', '/solicitudes-pago');
  c(lista.estado === 200 && lista.texto.includes('PRU1-901') && !lista.texto.includes('PRU3-901'), 'la lista sigue igual: la suya y no la ajena');
  const contador = await pedir(ingeniero, 'GET', '/solicitudes-pago/pending-approval-count');
  c(contador.estado === 200, `las rutas sin número no se tocan (contador: ${contador.estado})`);
  const noExiste = await pedir(ingeniero, 'GET', '/solicitudes-pago/999999');
  c(noExiste.estado === 404, `una que no existe sigue dando 404 (dio ${noExiste.estado})`);

  const delAdmin = await pedir(admin, 'GET', `/solicitudes-pago/${ajena}`);
  c(delAdmin.estado === 200 && delAdmin.texto.includes('PRU3-901'), `el admin abre la del proyecto 3 (dio ${delAdmin.estado})`);

  console.log(`${ok} pasaron, ${fallo} fallaron`);
  await pool.end();
  // Sin process.exit: ver aprobar-clave-humo.ts (Node en Windows revienta si se
  // corta con las conexiones cerrándose).
  process.exitCode = fallo ? 1 : 0;
};

main();
