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
// - «las que le faltan a Lili», «a Sergey»: el aprobador dicho a su manera lo
//   encuentra el sistema, y la cuenta por aprobador la hace la base;
// - la lista trae TODAS las que calzan (no 25), en el orden pedido: «las mas
//   grandes» son de verdad las mas grandes;
// - el detalle de una sale tambien pidiendola solo por su numero («la 1»);
// - la tabla en Excel o PDF: filas, subtotales y total de la base, con el
//   filtro dicho arriba, sin datos bancarios; por WhatsApp como archivo, y por
//   correo SOLO a la direccion que la persona tiene en el sistema;
// - y por WhatsApp de verdad: el modelo recibe la lista de proyectos que la
//   persona puede ver, llama a la herramienta y su respuesta sale.
import { API } from './pruebas/contexto.js';
import { SECRETOS_PRUEBA } from './pruebas/entorno.js';
import crypto from 'crypto';
import { query, pool } from '../src/database/config.js';
import { buscarSolicitudes, verSolicitud } from '../src/services/whatsapp/solicitudes.js';
import { ejecutarHerramienta, type Usuario } from '../src/services/whatsapp/herramientas.js';
import { conversacionViva } from '../src/services/whatsapp/conversacion.js';
import { armarTabla, tablaEnExcel, tablaEnPdf } from '../src/services/whatsapp/tablaSolicitudes.js';
import ExcelJS from 'exceljs';

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
  pendientes_por_quien_firma_ahora?: { le_toca_a: string; cantidad: number }[];
  por_estado: { estado: string; cantidad: number; monto: string }[];
  por_proyecto?: { proyecto: string; cantidad: number }[];
  solicitudes: { numero: string; monto: string; le_toca_aprobar_a?: string }[];
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

  // ── por aprobador, dicho a su manera ─────────────────────────────────────
  // Con nombres de verdad: «Lili» y «Sergey» tienen que dar con ellos.
  await query("UPDATE users SET nombre = 'Lilia Gonzalez' WHERE id = $1", [firmante.id]);
  await query("UPDATE users SET nombre = 'Sergei Plotnikoff' WHERE id = $1", [admin.id]);
  const deLili = await buscar(ingeniero, { le_toca_a: 'Lili' });
  exigir(
    deLili.ok && deLili.c.total.cantidad === 2 &&
      deLili.c.solicitudes.every((x) => x.le_toca_aprobar_a === 'Lilia Gonzalez'),
    '«las que le faltan a Lili»: las dos que le toca firmar ahora a Lilia',
  );
  const deSergey = await buscar(ingeniero, { le_toca_a: 'Sergey' });
  exigir(
    deSergey.ok && deSergey.c.total.cantidad === 1 && deSergey.c.solicitudes[0]?.numero === p1[1].numero,
    '«Sergey» es Sergei: la que ya firmó Lilia y ahora le toca a él',
  );
  const sinFirmaDeSergey = await buscar(ingeniero, { falta_firma_de: 'sergei' });
  exigir(
    sinFirmaDeSergey.ok && sinFirmaDeSergey.c.total.cantidad === 3,
    'las que Sergei todavía no ha firmado, le toque ya o después: las tres pendientes',
  );
  const nadie = await buscar(ingeniero, { le_toca_a: 'Pedro' });
  exigir(!nadie.ok, 'un nombre que no es de ningún aprobador se rechaza para que el modelo pregunte');
  const pendientes = await buscar(ingeniero, { estados: ['pendiente'] });
  const porQuien = Object.fromEntries(
    (pendientes.ok ? pendientes.c.pendientes_por_quien_firma_ahora ?? [] : [])
      .map((x) => [x.le_toca_a, x.cantidad]),
  );
  exigir(
    JSON.stringify(porQuien) === JSON.stringify({ 'Lilia Gonzalez': 2, 'Sergei Plotnikoff': 1 }),
    'la base cuenta cuántas le tocan a cada aprobador',
    porQuien,
  );

  // ── todas, y en el orden pedido ─────────────────────────────────────────
  // Treinta pagadas más: con el tope de antes (25) no se habrían visto todas.
  for (let i = 1; i <= 30; i += 1) {
    await query(
      `INSERT INTO solicitudes_pago
         (proyecto_id, numero, fecha, proveedor, preparado_por, solicitado_por, estado,
          monto_total, subtotal, codigo_verificacion)
       VALUES (1, $1, '2026-08-01', 'Proveedor viejo', $2, $2, 'pagada', $3, $3, $4)`,
      [`PRU1-${100 + i}`, admin.id, i * 10, crypto.randomBytes(5).toString('hex').toUpperCase()],
    );
  }
  const todas = await buscar(ingeniero, {});
  exigir(
    todas.ok && todas.c.total.cantidad === 36 && todas.c.solicitudes.length === 36,
    'la lista trae todas las que calzan (36), no las 25 más recientes',
    todas.ok ? [todas.c.total.cantidad, todas.c.solicitudes.length] : todas,
  );
  const grandes = await buscar(ingeniero, { orden: 'monto_mayor' });
  exigir(
    grandes.ok && grandes.c.solicitudes[0]?.monto === 'B/. 5,000.00' &&
      grandes.c.solicitudes[1]?.monto === 'B/. 2,000.00',
    '«las más grandes»: el orden lo pone la base',
    grandes.ok ? grandes.c.solicitudes.slice(0, 3).map((x) => x.monto) : grandes,
  );

  // ── el detalle, pidiéndola solo por su número ───────────────────────────
  const laUno = await verSolicitud(ingeniero, '1');
  exigir(
    laUno.ok && JSON.stringify(laUno.contenido).includes(p1[0].numero),
    '«la 1» es la PRU1-001: el detalle sale aunque falte el prefijo',
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

  // ── la tabla ────────────────────────────────────────────────────────────
  const armada = await armarTabla(ingeniero, {
    filtros: { estados: ['pendiente'] },
    columnas: ['numero', 'proveedor', 'le_toca_a'],
    agrupar_por: 'aprobador',
    titulo: 'Pendientes',
  });
  const tabla = armada.ok ? armada.tabla : null;
  exigir(
    tabla !== null && tabla.total.cantidad === 3 && tabla.total.monto === 600.5 &&
      tabla.filtro.includes('esperando aprobación'),
    'la tabla trae las tres pendientes de su obra, el total de la base y el filtro dicho',
    tabla && { total: tabla.total, filtro: tabla.filtro },
  );
  const subtotales = Object.fromEntries((tabla?.grupos ?? []).map((g) => [g.nombre, [g.cantidad, g.subtotal]]));
  exigir(
    JSON.stringify(subtotales) === JSON.stringify({ 'Lilia Gonzalez': [2, 400], 'Sergei Plotnikoff': [1, 200.5] }),
    'agrupada por aprobador, con el subtotal de cada uno sacado de la base',
    subtotales,
  );

  if (tabla) {
    const libro = new ExcelJS.Workbook();
    await libro.xlsx.load(await tablaEnExcel(tabla));
    const celdas: unknown[] = [];
    libro.getWorksheet('Solicitudes')!.eachRow((fila) => fila.eachCell((c) => celdas.push(c.value)));
    const texto = JSON.stringify(celdas);
    exigir(
      texto.includes('Pendientes') && texto.includes('Monto') && celdas.includes(600.5) &&
        texto.includes('Subtotal Lilia Gonzalez (2)'),
      'el Excel lleva el título, las columnas, los subtotales y el total como número',
    );
    exigir(!/Secreto|0400999888777/.test(texto), 'el Excel no lleva datos bancarios');
    const pdf = await tablaEnPdf(tabla);
    exigir(pdf.subarray(0, 4).toString() === '%PDF' && pdf.length > 1000, 'el PDF sale armado');
  }

  // Por la herramienta, como la usa el asistente.
  const conversacion = await conversacionViva(NUMERO, ingeniero.id);
  const ctx = { usuario: ingeniero, conversacion, fotos: 0 };
  const antesDeTabla = ((await (await fetch(`${META}/_prueba/enviados`)).json()) as unknown[]).length;
  const porWhatsapp = await ejecutarHerramienta(
    'mandar_tabla',
    { estados: ['pendiente', 'aprobada'], formato: 'excel' },
    ctx,
    { listas: null },
  );
  const tras = (await (await fetch(`${META}/_prueba/enviados`)).json()) as {
    tipo: string; archivo?: { nombre: string; bytes: number };
  }[];
  exigir(
    porWhatsapp.ok && tras.length === antesDeTabla + 1 && tras.at(-1)?.tipo === 'document' &&
      Boolean(tras.at(-1)?.archivo?.nombre.endsWith('.xlsx')),
    'por WhatsApp sale como archivo de Excel',
    { resultado: porWhatsapp.contenido, ultimo: tras.at(-1) },
  );
  const porCorreo = await ejecutarHerramienta(
    'mandar_tabla',
    { estados: ['pendiente'], formato: 'pdf', enviar_por: 'correo', correo: 'alguien@otra-empresa.com' },
    ctx,
    { listas: null },
  );
  exigir(
    porCorreo.ok && JSON.stringify(porCorreo.contenido).includes('aprobador1@pruebas.local') &&
      !JSON.stringify(porCorreo.contenido).includes('otra-empresa'),
    'por correo va SOLO a su dirección del sistema, aunque le dicten otra',
    porCorreo.contenido,
  );
  const tablaAjena = await ejecutarHerramienta(
    'mandar_tabla',
    { proyecto_ids: [2], formato: 'pdf' },
    ctx,
    { listas: null },
  );
  exigir(!tablaAjena.ok, 'una tabla de una obra que no es suya no se arma');

  await pool.end();
  console.log(fallos === 0 ? '\nTodo bien' : `\n${fallos} fallo(s)`);
  process.exit(fallos === 0 ? 0 : 1);
};

main().catch(async (e) => {
  console.error(e);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
