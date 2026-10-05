// Prueba de humo: el WhatsApp de las solicitudes urgentes.
// npm run pruebas -- whatsapp-urgentes
//
// Ivan, 2026-10-05: cuando una solicitud URGENTE llega al turno de alguien, a
// esa persona le sale un WhatsApp con un boton «Aprobar» que abre la solicitud
// en el sistema. Se exige, con una cadena de tres (los dos primeros con
// WhatsApp, el tercero sin):
// - al crearla urgente, le llega al primero: la plantilla aprobada por Meta, con
//   numero, proveedor, monto y proyecto, y el boton con el id de la solicitud;
// - una que no es urgente no manda nada;
// - cuando firma el primero, le llega al segundo; un rechazo no manda nada;
// - reenviada despues del rechazo, le vuelve a llegar al primero;
// - aprobando varias a la vez, igual: le llega al siguiente;
// - el mismo turno no se avisa dos veces;
// - a quien no tiene WhatsApp no se le manda nada, y nada se rompe;
// - cada aviso queda apuntado, y el mensaje queda con los demas que se mandan.
import { API } from './pruebas/contexto.js';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { query, pool } from '../src/database/config.js';
import { SECRETOS_PRUEBA } from './pruebas/entorno.js';

const META = process.env.PRUEBAS_META ?? '';
const P = 3;
const CLAVE = 'clave-de-pruebas';
const TEL1 = '50760000001';
const TEL2 = '50760000002';

interface Usuario {
  id: number;
  email: string;
  rol: string;
}
interface Enviado {
  telefono: string;
  tipo: string;
  cuerpo: {
    template?: {
      name: string;
      language: { code: string };
      components: { type: string; sub_type?: string; parameters: { text: string }[] }[];
    };
  };
}

let fallos = 0;
const exigir = (bien: boolean, que: string, visto?: unknown): void => {
  console.log(`${bien ? '  ok  ' : 'FALLA '} ${que}${bien || visto === undefined ? '' : ` → ${JSON.stringify(visto)}`}`);
  if (!bien) fallos += 1;
};
const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

const plantillas = async (telefono: string): Promise<Enviado[]> =>
  ((await (await fetch(`${META}/_prueba/enviados`)).json()) as Enviado[]).filter(
    (e) => e.telefono === telefono && e.tipo === 'template',
  );

/** Espera a que a ese telefono le hayan llegado `cuantas` plantillas (o se cansa). */
const hastaQueLleguen = async (telefono: string, cuantas: number): Promise<Enviado[]> => {
  let v: Enviado[] = [];
  for (const hasta = Date.now() + 8000; Date.now() < hasta; ) {
    v = await plantillas(telefono);
    if (v.length >= cuantas) break;
    await esperar(200);
  }
  return v;
};

const main = async () => {
  if (!META) {
    console.error('falta PRUEBAS_META');
    process.exit(1);
  }
  const admin = (
    await query<Usuario>("SELECT id, email, rol FROM users WHERE rol='admin' AND activo=true ORDER BY id LIMIT 1")
  ).rows[0];
  const uno = async (email: string): Promise<Usuario> =>
    (await query<Usuario>('SELECT id, email, rol FROM users WHERE email = $1', [email])).rows[0];
  const a1 = await uno('aprobador1@pruebas.local');
  const a2 = await uno('aprobador2@pruebas.local');
  const a3 = await uno('aprobador3@pruebas.local');

  const hash = await bcrypt.hash(CLAVE, 4);
  for (const [u, tel] of [[a1, TEL1], [a2, TEL2], [a3, null]] as const) {
    await query('UPDATE users SET password = $1, whatsapp = $2 WHERE id = $3', [hash, tel, u.id]);
    await query(
      `INSERT INTO user_permissions (user_id, solicitudes_ver) VALUES ($1, true)
       ON CONFLICT (user_id) DO UPDATE SET solicitudes_ver = true`,
      [u.id],
    );
    await query('INSERT INTO user_project_access (user_id, proyecto_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [u.id, P]);
  }
  await query(
    `INSERT INTO proyecto_ajustes_aprobacion (proyecto_id, user_id, orden, activo)
     VALUES ($1, $2, 1, true), ($1, $3, 2, true), ($1, $4, 3, true)`,
    [P, a1.id, a2.id, a3.id],
  );

  const firmar = (u: Usuario) =>
    jwt.sign({ userId: u.id, email: u.email, rol: u.rol }, process.env.JWT_SECRET!, { expiresIn: '10m' });
  const pedir = async (u: Usuario, metodo: string, ruta: string, cuerpo?: unknown) => {
    const res = await fetch(`${API}${ruta}`, {
      method: metodo,
      headers: { Authorization: `Bearer ${firmar(u)}`, 'Content-Type': 'application/json' },
      body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
    });
    return { estado: res.status, cuerpo: (await res.json().catch(() => null)) as Record<string, unknown> | null };
  };
  const crear = async (urgente: boolean) => {
    const r = await pedir(admin, 'POST', '/solicitudes-pago', {
      proyecto_id: P,
      solicitado_por: admin.id,
      proveedor: 'Ferretería Las Tablas',
      urgente,
      items: [{ cantidad: 1, descripcion: 'Cemento', precio_unitario: 1250 }],
    });
    const s = r.cuerpo?.solicitud as { id: number; numero: string } | undefined;
    if (!s) throw new Error(`no se pudo crear la solicitud: ${r.estado} ${JSON.stringify(r.cuerpo)}`);
    return s;
  };

  // ── al crearla urgente: al primero ──────────────────────────────────────
  const urgente = await crear(true);
  let a1Recibio = await hastaQueLleguen(TEL1, 1);
  const t = a1Recibio[0]?.cuerpo.template;
  const cuerpo = t?.components.find((c) => c.type === 'body')?.parameters.map((p) => p.text);
  const boton = t?.components.find((c) => c.type === 'button');
  exigir(a1Recibio.length === 1, 'al crearla urgente, le llega al primero de la cadena', a1Recibio.length);
  exigir(t?.name === 'solicitud_urgente' && t.language.code === 'es', 'con la plantilla que aprobó Meta, en español', t);
  exigir(
    JSON.stringify(cuerpo) === JSON.stringify([urgente.numero, 'Ferretería Las Tablas', 'B/. 1,250.00', 'PRUEBAS3']),
    'con el número, el proveedor, el monto y el proyecto',
    cuerpo,
  );
  exigir(
    boton?.sub_type === 'url' && boton.parameters[0]?.text === String(urgente.id),
    'y el botón lleva a esa solicitud',
    boton,
  );
  exigir((await plantillas(TEL2)).length === 0, 'al segundo todavía no le llega nada');

  // ── una que no es urgente ───────────────────────────────────────────────
  await crear(false);
  await esperar(1500);
  exigir((await plantillas(TEL1)).length === 1, 'una que no es urgente no manda nada');

  // ── firma el primero: al segundo ────────────────────────────────────────
  const ap1 = await pedir(a1, 'POST', `/solicitudes-pago/${urgente.id}/aprobar`, { password: CLAVE });
  exigir(ap1.estado === 200, `el primero aprueba (dio ${ap1.estado})`, ap1.cuerpo);
  let a2Recibio = await hastaQueLleguen(TEL2, 1);
  exigir(a2Recibio.length === 1, 'y le llega al segundo', a2Recibio.length);

  // ── rechazo y reenvío: otra vez al primero ──────────────────────────────
  const re = await pedir(a2, 'POST', `/solicitudes-pago/${urgente.id}/rechazar`, {
    password: CLAVE,
    comentario: 'Falta la cotización',
  });
  exigir(re.estado === 200, `el segundo la rechaza (dio ${re.estado})`, re.cuerpo);
  await esperar(1500);
  exigir((await plantillas(TEL1)).length === 1 && (await plantillas(TEL2)).length === 1, 'un rechazo no manda nada');
  // updated_at cambia al reenviar; que no caiga en el mismo milisegundo.
  await esperar(20);
  const reenvio = await pedir(admin, 'PATCH', `/solicitudes-pago/${urgente.id}/estado`, { estado: 'pendiente' });
  exigir(reenvio.estado === 200, `se reenvía (dio ${reenvio.estado})`, reenvio.cuerpo);
  a1Recibio = await hastaQueLleguen(TEL1, 2);
  exigir(a1Recibio.length === 2, 'reenviada, le vuelve a llegar al primero', a1Recibio.length);

  // ── varias a la vez: al siguiente ───────────────────────────────────────
  const rev = await pedir(a1, 'POST', `/solicitudes-pago/${urgente.id}/revisar`);
  const masivo = await pedir(a1, 'POST', '/solicitudes-pago/aprobar-masivo', { ids: [urgente.id], password: CLAVE });
  exigir(rev.estado === 200 && masivo.cuerpo?.aprobadas === 1, 'el primero la aprueba con otras, a la vez', masivo.cuerpo);
  a2Recibio = await hastaQueLleguen(TEL2, 2);
  exigir(a2Recibio.length === 2, 'y le llega al segundo', a2Recibio.length);

  // ── el mismo turno, dos veces ───────────────────────────────────────────
  // Lo mismo que haria un segundo servidor durante un despliegue: avisar otra
  // vez el turno que ya se aviso.
  process.env.WHATSAPP_API_URL = META;
  process.env.WHATSAPP_TOKEN = SECRETOS_PRUEBA.token;
  process.env.WHATSAPP_PHONE_NUMBER_ID = SECRETOS_PRUEBA.numeroId;
  const { avisarTurnoUrgente } = await import('../src/services/whatsapp/avisoUrgente.js');
  await avisarTurnoUrgente(urgente.id);
  await avisarTurnoUrgente(urgente.id);
  await esperar(500);
  exigir((await plantillas(TEL2)).length === 2, 'el mismo turno no se avisa dos veces');
  // Y que de aqui SI se manda: una urgente puesta directo en la base (sin pasar
  // por el servidor, que ya habria avisado) se avisa una vez, aunque se pida
  // dos a la vez.
  const directa = (
    await query<{ id: number }>(
      `INSERT INTO solicitudes_pago
         (proyecto_id, numero, fecha, proveedor, preparado_por, solicitado_por, subtotal, monto_total,
          estado, urgente, codigo_verificacion)
       VALUES ($1, 'PRU3-DIRECTA', CURRENT_DATE, 'Otro proveedor', $2, $2, 10, 10, 'pendiente', true, 'directa01')
       RETURNING id`,
      [P, admin.id],
    )
  ).rows[0].id;
  await Promise.all([avisarTurnoUrgente(directa), avisarTurnoUrgente(directa)]);
  const aDirecta = (await plantillas(TEL1)).filter(
    (e) => e.cuerpo.template?.components[0]?.parameters[0]?.text === 'PRU3-DIRECTA',
  );
  exigir(aDirecta.length === 1, 'pedido dos veces a la vez, sale uno solo', aDirecta.length);

  // ── el tercero no tiene WhatsApp ────────────────────────────────────────
  const ap2 = await pedir(a2, 'POST', `/solicitudes-pago/${urgente.id}/aprobar`, { password: CLAVE });
  exigir(ap2.estado === 200, `el segundo aprueba (dio ${ap2.estado})`, ap2.cuerpo);
  await esperar(1500);
  const avisos = (
    await query<{ user_id: number; turno: number; salio: boolean | null }>(
      'SELECT user_id, turno, salio FROM whatsapp_avisos_urgentes WHERE solicitud_pago_id = $1 ORDER BY id',
      [urgente.id],
    )
  ).rows;
  exigir(!avisos.some((a) => a.user_id === a3.id), 'al tercero, sin WhatsApp, no se le manda nada', avisos);
  exigir(
    JSON.stringify(avisos.map((a) => [a.user_id, a.turno, a.salio])) ===
      JSON.stringify([[a1.id, 1, true], [a2.id, 2, true], [a1.id, 1, true], [a2.id, 2, true]]),
    'cada aviso queda apuntado: a quién, qué turno y que salió',
    avisos,
  );
  const enMensajes = await query<{ n: number }>(
    "SELECT COUNT(*)::int AS n FROM whatsapp_mensajes WHERE direccion = 'saliente' AND tipo = 'template' AND texto LIKE $1",
    [`%${urgente.numero}%`],
  );
  exigir(enMensajes.rows[0].n === 4, 'y los cuatro mensajes quedan con los demás que se mandan', enMensajes.rows[0].n);

  await pool.end();
  console.log(fallos === 0 ? '\nTodo bien' : `\n${fallos} fallo(s)`);
  process.exitCode = fallos === 0 ? 0 : 1;
};

main().catch(async (e) => {
  console.error(e);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
