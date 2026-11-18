// Prueba de humo: eliminar una caja menuda abierta por error.
// cd andrei-backend && npm run pruebas -- caja-eliminar
//
// Ivan, 2026-11-18: «debemos poder borrar una caja que es abierta por error» y
// «si se remueve la caja, ya se va todo lo que conlleva». Se exige:
// - la caja se va con sus gastos, su apertura, sus aumentos y sus reembolsos
//   sin pagar; nada se borra de verdad (activo = false) y queda en auditoría;
// - solo mientras no ha salido dinero: con la apertura, un aumento o un
//   reembolso ya pagados, la lista dice por qué y el servidor se niega (409);
// - solo administración y gerencia: un usuario con permiso de caja menuda no
//   puede (403);
// - la apertura o un aumento no se elimina solo desde las solicitudes (400, y
//   el detalle no ofrece eliminarla); una solicitud normal sí, como antes.
import { API } from './pruebas/contexto.js';
import jwt from 'jsonwebtoken';
import { query, pool } from '../src/database/config.js';

interface Usuario {
  id: number;
  email: string;
  rol: string;
}

const main = async () => {
  const uno = async (sql: string, p: unknown[] = []) => (await query<Usuario>(sql, p)).rows[0];
  const admin = await uno("SELECT id, email, rol FROM users WHERE rol='admin' AND activo=true ORDER BY id LIMIT 1");
  const coadmin = await uno(
    "INSERT INTO users (nombre, email, rol, activo) VALUES ('Gerencia de pruebas', 'gerencia@pruebas.local', 'co-admin', true) RETURNING id, email, rol",
  );
  const empleado = await uno("SELECT id, email, rol FROM users WHERE email = 'aprobador1@pruebas.local'");
  await query(
    `INSERT INTO user_permissions (user_id, caja_menuda) VALUES ($1, true)
     ON CONFLICT (user_id) DO UPDATE SET caja_menuda = true`,
    [empleado.id],
  );
  await query('INSERT INTO user_project_access (user_id, proyecto_id) VALUES ($1, 1) ON CONFLICT DO NOTHING', [empleado.id]);

  const token = (u: Usuario) => jwt.sign({ userId: u.id, email: u.email, rol: u.rol }, process.env.JWT_SECRET!, { expiresIn: '10m' });
  const pedir = async (metodo: string, ruta: string, cuerpo?: unknown, quien: Usuario = admin) => {
    const res = await fetch(`${API}${ruta}`, {
      method: metodo,
      headers: { Authorization: `Bearer ${token(quien)}`, 'Content-Type': 'application/json' },
      body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
    });
    return { estado: res.status, json: (await res.json()) as Record<string, unknown> };
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

  // Una caja creada como en la pantalla: nace con su solicitud de apertura.
  const crearCaja = async (nombre: string) => {
    const r = await pedir('POST', '/cajas-menudas', { proyecto_id: 1, responsable_id: admin.id, nombre, monto_asignado: 1000 });
    return r.json.data as { id: number; solicitud_apertura_id: number };
  };
  const estado = (id: number, e: string) => query('UPDATE solicitudes_pago SET estado = $2 WHERE id = $1', [id, e]);
  const gastar = (caja: number, descripcion: string, monto: number) =>
    query(
      `INSERT INTO cajas_menudas_gastos (caja_menuda_id, fecha, proveedor, descripcion, monto, monto_total, registrado_por)
       VALUES ($1, '2026-09-07', 'Super Centro Palenque', $2, $3, $3, $4)`,
      [caja, descripcion, monto, admin.id],
    );
  const aumentar = async (caja: number) =>
    (await pedir('PUT', `/cajas-menudas/${caja}/monto`, { monto_asignado: 1500 })).json.data as { solicitud_id: number };
  const reembolsar = async (caja: number) =>
    (await pedir('POST', `/cajas-menudas/${caja}/reembolso`, {})).json.data as { solicitud_id: number };
  const activa = async (tabla: 'cajas_menudas' | 'solicitudes_pago', id: number) =>
    (await query<{ activo: boolean }>(`SELECT activo FROM ${tabla} WHERE id = $1`, [id])).rows[0].activo;
  const motivos = async () => {
    const r = await pedir('GET', '/cajas-menudas/proyecto/1');
    return new Map(((r.json.data as { id: number; motivo_no_eliminar: string | null }[]) ?? []).map((x) => [x.id, x.motivo_no_eliminar]));
  };

  // ── La caja abierta por error: apertura aprobada sin transferir, un aumento,
  //    dos gastos en un reembolso sin pagar.
  const error = await crearCaja('Caja abierta por error');
  await estado(error.solicitud_apertura_id, 'aprobada');
  const aumento = await aumentar(error.id);
  await estado(aumento.solicitud_id, 'aprobada');
  await gastar(error.id, 'Diésel', 39.99);
  await gastar(error.id, 'Agua', 9.28);
  const reembolso = await reembolsar(error.id);
  c(!!aumento?.solicitud_id && !!reembolso?.solicitud_id, 'la caja de prueba tiene aumento y reembolso');

  // ── Las que ya movieron dinero, una por cada razón.
  const pagada = await crearCaja('Apertura ya pagada');
  await estado(pagada.solicitud_apertura_id, 'transferida');
  const conAumento = await crearCaja('Aumento ya pagado');
  await estado(conAumento.solicitud_apertura_id, 'aprobada');
  await estado((await aumentar(conAumento.id)).solicitud_id, 'transferida');
  const conReembolso = await crearCaja('Reembolso ya pagado');
  await estado(conReembolso.solicitud_apertura_id, 'aprobada');
  await gastar(conReembolso.id, 'Tornillos', 5);
  await estado((await reembolsar(conReembolso.id)).solicitud_id, 'reembolsada');

  const m = await motivos();
  c(m.get(error.id) === null, `la abierta por error se puede eliminar (dio ${m.get(error.id)})`);
  c(m.get(pagada.id) === 'La apertura ya fue transferida', `apertura pagada: la lista dice por qué (dio ${m.get(pagada.id)})`);
  c(m.get(conAumento.id) === 'Un aumento ya fue transferido', `aumento pagado (dio ${m.get(conAumento.id)})`);
  c(m.get(conReembolso.id) === 'Ya se pagó un reembolso', `reembolso pagado (dio ${m.get(conReembolso.id)})`);

  // ── Lo que muestra la confirmación.
  const vista = await pedir('GET', `/cajas-menudas/${error.id}/eliminacion`);
  const v = vista.json.data as { motivo: string | null; gastos: number; solicitudes: { id: number; es_apertura: boolean }[] };
  c(
    vista.estado === 200 && v.motivo === null && v.gastos === 2 && v.solicitudes.length === 3 &&
      v.solicitudes[0].id === error.solicitud_apertura_id && v.solicitudes[0].es_apertura,
    `la confirmación sabe lo que se va: 2 gastos y 3 solicitudes, la apertura primero (dio ${vista.estado} ${JSON.stringify(v)})`,
  );

  // ── La apertura y el aumento no se eliminan solos.
  for (const [id, etq] of [[error.solicitud_apertura_id, 'la apertura'], [aumento.solicitud_id, 'el aumento']] as const) {
    const borrar = await pedir('DELETE', `/solicitudes-pago/${id}`);
    c(borrar.estado === 400 && (await activa('solicitudes_pago', id)), `${etq} no se elimina sola: 400 (dio ${borrar.estado})`);
    const detalle = await pedir('GET', `/solicitudes-pago/${id}`);
    c(detalle.json.puede_eliminar === false, `y su detalle no lo ofrece (dio ${detalle.json.puede_eliminar})`);
  }

  // ── Un usuario con permiso de caja menuda no puede.
  const vistaEmpleado = await pedir('GET', `/cajas-menudas/${error.id}/eliminacion`, undefined, empleado);
  c(vistaEmpleado.estado === 403, `un usuario no ve la confirmación: 403 (dio ${vistaEmpleado.estado})`);
  const borraEmpleado = await pedir('DELETE', `/cajas-menudas/${error.id}`, undefined, empleado);
  c(borraEmpleado.estado === 403 && (await activa('cajas_menudas', error.id)), `ni elimina: 403 (dio ${borraEmpleado.estado})`);

  // ── Con dinero ya entregado, el servidor se niega aunque la pidan directo.
  for (const caja of [pagada, conAumento, conReembolso]) {
    const r = await pedir('DELETE', `/cajas-menudas/${caja.id}`);
    c(
      r.estado === 409 && (await activa('cajas_menudas', caja.id)) && (await activa('solicitudes_pago', caja.solicitud_apertura_id)),
      `con dinero entregado no se elimina: 409 y todo sigue (dio ${r.estado} ${r.json.error})`,
    );
  }

  // ── Gerencia la elimina.
  const borrar = await pedir('DELETE', `/cajas-menudas/${error.id}`, undefined, coadmin);
  c(borrar.estado === 200, `gerencia elimina la caja: 200 (dio ${borrar.estado} ${JSON.stringify(borrar.json)})`);
  c(!(await activa('cajas_menudas', error.id)), 'la caja queda quitada, no borrada');
  for (const [id, etq] of [
    [error.solicitud_apertura_id, 'la apertura'],
    [aumento.solicitud_id, 'el aumento'],
    [reembolso.solicitud_id, 'el reembolso'],
  ] as const) {
    c(!(await activa('solicitudes_pago', id)), `${etq} se fue con ella`);
    const detalle = await pedir('GET', `/solicitudes-pago/${id}`);
    c(detalle.estado === 404, `${etq} ya no se abre: 404 (dio ${detalle.estado})`);
  }
  const gastos = (await query<{ n: string }>('SELECT count(*) AS n FROM cajas_menudas_gastos WHERE caja_menuda_id = $1', [error.id])).rows[0];
  c(Number(gastos.n) === 2, `sus gastos quedan guardados con ella (dio ${gastos.n})`);
  const enLista = await motivos();
  c(!enLista.has(error.id) && enLista.has(pagada.id), 'ya no sale en la lista; las otras sí');
  const auditoria = (await query<{ entidad: string; entidad_id: number; user_id: number }>(
    "SELECT entidad, entidad_id, user_id FROM audit_log WHERE accion = 'eliminar' AND entidad IN ('caja_menuda', 'solicitud_pago') ORDER BY id",
  )).rows;
  c(
    auditoria.length === 4 && auditoria.every((a) => a.user_id === coadmin.id) &&
      auditoria.some((a) => a.entidad === 'caja_menuda' && a.entidad_id === error.id),
    `queda en auditoría: la caja y sus 3 solicitudes, a nombre de gerencia (dio ${JSON.stringify(auditoria)})`,
  );
  const otraVez = await pedir('DELETE', `/cajas-menudas/${error.id}`);
  c(otraVez.estado === 404, `eliminarla otra vez: 404 (dio ${otraVez.estado})`);

  // ── Una solicitud normal se sigue eliminando como antes.
  const normal = (await query<{ id: number }>(
    `INSERT INTO solicitudes_pago (proyecto_id, numero, fecha, proveedor, preparado_por, solicitado_por, subtotal, descuentos, impuestos, monto_total, estado, tipo, codigo_verificacion)
     VALUES (1, 'PRU1-900', CURRENT_DATE, 'Ferretería', $1, $1, 10, 0, 0, 10, 'pendiente', 'regular', 'PRUEBA90') RETURNING id`,
    [admin.id],
  )).rows[0].id;
  const borrarNormal = await pedir('DELETE', `/solicitudes-pago/${normal}`);
  c(borrarNormal.estado === 200 && !(await activa('solicitudes_pago', normal)), `una solicitud normal se elimina: 200 (dio ${borrarNormal.estado})`);

  console.log(`${ok} pasaron, ${fallo} fallaron`);
  await pool.end();
  // Sin process.exit: ver aprobar-clave-humo.ts (Node en Windows revienta si se
  // corta con las conexiones cerrándose).
  process.exitCode = fallo ? 1 : 0;
};

main();
