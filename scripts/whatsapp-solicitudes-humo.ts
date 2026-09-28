// Prueba de humo: las preguntas sobre solicitudes de pago por WhatsApp.
// npm run pruebas -- whatsapp-solicitudes
//
// Lo que se comprueba es lo que NO puede depender del modelo:
// - cada persona ve por WhatsApp lo mismo que en la pantalla: el admin todo;
//   un usuario con permiso, solo sus proyectos; uno sin permiso, nada;
// - un proyecto ajeno se rechaza entero, y una solicitud ajena se contesta
//   igual que una que no existe;
// - cuantas son y cuanto suman lo calcula la base, sobre TODAS las que
//   calzan, no solo sobre las que se muestran;
// - «esperando mi aprobacion» sigue la cadena de aprobadores del proyecto;
// - no sale ningun dato bancario;
// - y por WhatsApp de verdad: el modelo recibe la lista de proyectos que la
//   persona puede ver, llama a la herramienta y su respuesta sale.
import { API } from './pruebas/contexto.js';
import { SECRETOS_PRUEBA } from './pruebas/entorno.js';
import crypto from 'crypto';
import { query, pool } from '../src/database/config.js';
import { buscarSolicitudes, verSolicitud } from '../src/services/whatsapp/solicitudes.js';
import type { Usuario } from '../src/services/whatsapp/herramientas.js';

const META = process.env.PRUEBAS_META ?? '';
const WEBHOOK = `${API}/whatsapp/webhook`;
const NUMERO = '50761110001';

let fallos = 0;
const exigir = (bien: boolean, que: string): void => {
  console.log(`${bien ? '  ok  ' : 'FALLA '} ${que}`);
  if (!bien) fallos += 1;
};
const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Lo que devuelven las funciones, en la forma en que se lee aqui.
interface Busqueda {
  total: { cantidad: number; monto: string };
  por_estado: { estado: string; cantidad: number; monto: string }[];
  por_proyecto?: { proyecto: string; cantidad: number }[];
  solicitudes: { numero: string; le_toca_aprobar_a?: string }[];
}
const buscar = async (u: Usuario, f: object) => {
  const r = await buscarSolicitudes(u, f);
  return r.ok ? { ok: true as const, c: r.contenido as Busqueda } : { ok: false as const, error: r.error };
};

const main = async () => {
  if (!META) {
    console.error('falta PRUEBAS_META');
    process.exit(1);
  }

  const usuarios = await query<Usuario & { email: string }>(
    `SELECT id, nombre, rol, email FROM users WHERE activo = true ORDER BY id`,
  );
  const admin = usuarios.rows.find((u) => u.rol === 'admin')!;
  const ingeniero = usuarios.rows.find((u) => u.email === 'aprobador1@pruebas.local')!;
  const sinPermiso = usuarios.rows.find((u) => u.email === 'aprobador2@pruebas.local')!;
  const firmante = usuarios.rows.find((u) => u.email === 'aprobador3@pruebas.local')!;

  // El ingeniero ve solicitudes, pero solo del proyecto 1.
  await query(
    `INSERT INTO user_permissions (user_id, solicitudes_ver) VALUES ($1, true)
     ON CONFLICT (user_id) DO UPDATE SET solicitudes_ver = true`,
    [ingeniero.id],
  );
  await query(
    'INSERT INTO user_project_access (user_id, proyecto_id) VALUES ($1, 1) ON CONFLICT DO NOTHING',
    [ingeniero.id],
  );

  // Cadena del proyecto 1: primero el firmante, despues el admin.
  await query(
    `INSERT INTO proyecto_ajustes_aprobacion (proyecto_id, user_id, orden, activo)
     VALUES (1, $1, 1, true), (1, $2, 2, true)`,
    [firmante.id, admin.id],
  );

  let n = 0;
  const crear = async (proyecto: number, estado: string, monto: number, proveedor: string) =>
    (
      await query<{ id: number; numero: string }>(
        `INSERT INTO solicitudes_pago
           (proyecto_id, numero, fecha, proveedor, preparado_por, solicitado_por, estado,
            monto_total, subtotal, beneficiario, banco, numero_cuenta, codigo_verificacion)
         VALUES ($1, $2, '2026-09-20', $3, $4, $4, $5, $6, $6,
                 'Beneficiario Secreto', 'Banco Secreto', '0400999888777', $7)
         RETURNING id, numero`,
        [proyecto, `PRU${proyecto}-${String((n += 1)).padStart(3, '0')}`, proveedor, admin.id,
          estado, monto, crypto.randomBytes(5).toString('hex').toUpperCase()],
      )
    ).rows[0];

  // Proyecto 1: tres pendientes, dos aprobadas sin pagar, una pagada.
  // Proyecto 2: una pendiente grande que el ingeniero no puede ver.
  const p1 = [
    await crear(1, 'pendiente', 100, 'Cementos del Istmo'),
    await crear(1, 'pendiente', 200.5, 'Ferreteria Norte'),
    await crear(1, 'pendiente', 300, 'Ferreteria Norte'),
    await crear(1, 'aprobada', 1000, 'Acero Panama'),
    await crear(1, 'aprobada', 2000, 'Acero Panama'),
    await crear(1, 'pagada', 5000, 'Alquileres Rio'),
  ];
  const ajena = await crear(2, 'pendiente', 99999, 'Proveedor Ajeno');
  await query(
    `INSERT INTO solicitud_pago_items (solicitud_pago_id, cantidad, unidad, descripcion, precio_unitario, precio_total, orden)
     VALUES ($1, 10, 'saco', 'Cemento gris tipo I', 10, 100, 1)`,
    [p1[0].id],
  );
  // La segunda ya la firmo el firmante: ahora le toca al admin.
  await query(
    `INSERT INTO solicitud_aprobaciones (solicitud_pago_id, user_id, orden, accion)
     VALUES ($1, $2, 1, 'aprobado')`,
    [p1[1].id, firmante.id],
  );

  // ── quien ve que ────────────────────────────────────────────────────────
  const delAdmin = await buscar(admin, { estados: ['pendiente'] });
  exigir(
    delAdmin.ok && delAdmin.c.total.cantidad === 4 && delAdmin.c.total.monto === 'B/. 100,599.50',
    'el admin ve las pendientes de todos los proyectos, contadas y sumadas por la base',
  );
  exigir(
    delAdmin.ok && (delAdmin.c.por_proyecto?.length ?? 0) === 2,
    'y repartidas por proyecto',
  );

  const delIngeniero = await buscar(ingeniero, { estados: ['pendiente', 'aprobada'] });
  exigir(
    delIngeniero.ok &&
      delIngeniero.c.total.cantidad === 5 &&
      delIngeniero.c.total.monto === 'B/. 3,600.50' &&
      !delIngeniero.c.solicitudes.some((s) => s.numero === ajena.numero),
    'el ingeniero solo ve las de su proyecto: la del proyecto 2 no aparece ni suma',
  );
  const porEstado = delIngeniero.ok
    ? Object.fromEntries(delIngeniero.c.por_estado.map((e) => [e.estado, e.cantidad]))
    : {};
  exigir(
    porEstado.pendiente === 3 && porEstado.aprobada === 2,
    'las cifras salen separadas: esperando aprobacion y aprobadas sin pagar',
  );

  const pocas = await buscar(ingeniero, { cuantas_mostrar: 2 });
  exigir(
    pocas.ok && pocas.c.solicitudes.length === 2 && pocas.c.total.cantidad === 6,
    'el total cuenta todas aunque se muestren dos',
  );

  const ajenoPedido = await buscar(ingeniero, { proyecto_ids: [2] });
  exigir(!ajenoPedido.ok, 'si pide un proyecto que no es suyo, no recibe nada de el');

  const nada = await buscar(sinPermiso, {});
  exigir(!nada.ok, 'quien no tiene permiso de ver solicitudes no ve ninguna');

  // ── una por una ─────────────────────────────────────────────────────────
  const suya = await verSolicitud(ingeniero, p1[0].numero.toLowerCase());
  const texto = JSON.stringify(suya);
  exigir(
    suya.ok && texto.includes('Cemento gris tipo I') && texto.includes(firmante.nombre),
    'una solicitud suya sale con sus lineas y a quien le toca firmar',
  );
  exigir(
    !/Secreto|0400999888777/.test(texto),
    'sin beneficiario, banco ni numero de cuenta',
  );

  const deOtro = await verSolicitud(ingeniero, ajena.numero);
  const noExiste = await verSolicitud(ingeniero, 'PRU1-999');
  exigir(
    !deOtro.ok && !noExiste.ok && !JSON.stringify(deOtro).includes('Ajeno'),
    'una solicitud ajena se contesta igual que una que no existe',
  );

  // ── a quien le toca ─────────────────────────────────────────────────────
  const delFirmante = await buscar(firmante, { esperando_mi_aprobacion: true });
  const delAdminMias = await buscar(admin, { esperando_mi_aprobacion: true });
  exigir(
    delFirmante.ok === false,
    'el firmante sin permiso de ver solicitudes tampoco ve las suyas por aqui',
  );
  exigir(
    delAdminMias.ok &&
      delAdminMias.c.total.cantidad === 1 &&
      delAdminMias.c.solicitudes[0]?.numero === p1[1].numero,
    'al admin solo le toca la que ya firmo el primero de la cadena',
  );

  // ── por WhatsApp de verdad ──────────────────────────────────────────────
  await query('UPDATE users SET whatsapp = $1 WHERE id = $2', [NUMERO, ingeniero.id]);
  const guion = [
    {
      content: [{ type: 'tool_use', id: 'tu_1', name: 'buscar_solicitudes', input: { estados: ['pendiente', 'aprobada'] } }],
      stop_reason: 'tool_use',
    },
    { content: [{ type: 'text', text: '3 esperan aprobación y 2 están aprobadas sin pagar.' }], stop_reason: 'end_turn' },
  ];
  await fetch(`${META}/_prueba/ia`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(guion),
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
            messages: [{ id: 'wamid.S1', from: NUMERO, type: 'text', text: { body: '¿Cuántas solicitudes tenemos pendientes?' } }],
          },
        }],
      }],
    }),
    'utf8',
  );
  await fetch(WEBHOOK, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Hub-Signature-256':
        'sha256=' + crypto.createHmac('sha256', SECRETOS_PRUEBA.appSecret).update(crudo).digest('hex'),
    },
    body: crudo,
  });

  let salio: { texto: string | null }[] = [];
  for (const hasta = Date.now() + 20000; Date.now() < hasta && salio.length === 0; ) {
    salio = (await (await fetch(`${META}/_prueba/enviados`)).json()) as never;
    if (salio.length === 0) await esperar(200);
  }
  exigir(Boolean(salio[0]?.texto?.includes('2 están aprobadas')), 'la respuesta sale por WhatsApp');

  const peticiones = (await (await fetch(`${META}/_prueba/ia/peticiones`)).json()) as {
    system?: { text: string }[];
    messages?: { content: unknown }[];
  }[];
  const contexto = (peticiones[0]?.system ?? []).map((s) => s.text).join('\n');
  exigir(
    contexto.includes('PRUEBAS1') && !contexto.includes('PRUEBAS2'),
    'el modelo recibe solo los proyectos cuyas solicitudes puede ver la persona',
  );
  const resultado = JSON.stringify(peticiones[1]?.messages?.at(-1)?.content ?? '');
  exigir(
    resultado.includes('B/. 3,600.50') && !resultado.includes('Secreto'),
    'la herramienta corre de verdad y el modelo recibe los totales, sin datos bancarios',
  );

  await pool.end();
  console.log(fallos === 0 ? '\nTodo bien' : `\n${fallos} fallo(s)`);
  process.exit(fallos === 0 ? 0 : 1);
};

main().catch(async (e) => {
  console.error(e);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
