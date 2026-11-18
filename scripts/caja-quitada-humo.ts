// Prueba de humo: una caja menuda quitada no existe para nadie (migración 189).
// cd andrei-backend && npm run pruebas -- caja-quitada
//
// Ivan, 2026-11-18: «hay que eliminar esa N.9, parece un error». Quitar no es
// borrar: la caja queda con activo = false y sus gastos se guardan. Se exige:
// - no sale en la lista general ni en la del proyecto; la que sigue activa, sí;
// - no se abre: su detalle responde 404;
// - no recibe gastos, cambios, cierre, aumento ni reembolso (404), y no se
//   escribe nada;
// - sus gastos siguen guardados;
// - un id que no es número sigue respondiendo 400, como antes.
import { API } from './pruebas/contexto.js';
import jwt from 'jsonwebtoken';
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
  const token = jwt.sign({ userId: admin.id, email: admin.email, rol: admin.rol }, process.env.JWT_SECRET!, { expiresIn: '10m' });
  const pedir = async (metodo: string, ruta: string, cuerpo?: unknown) => {
    const res = await fetch(`${API}${ruta}`, {
      method: metodo,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
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

  const caja = async (nombre: string) =>
    (await query<{ id: number }>(
      `INSERT INTO cajas_menudas (proyecto_id, responsable_id, nombre, monto_asignado, creado_por)
       VALUES (1, $1, $2, 1000, $1) RETURNING id`,
      [admin.id, nombre],
    )).rows[0].id;
  const activa = await caja('Caja que sigue');
  const quitada = await caja('Caja registrada por error');
  await query(
    `INSERT INTO cajas_menudas_gastos (caja_menuda_id, fecha, proveedor, descripcion, monto, monto_total, registrado_por)
     VALUES ($1, '2026-09-07', 'Super Centro Palenque', 'Diésel', 39.99, 39.99, $2)`,
    [quitada, admin.id],
  );
  await query('UPDATE cajas_menudas SET activo = false WHERE id = $1', [quitada]);

  const ids = (r: { json: Record<string, unknown> }) => ((r.json.data as { id: number }[]) ?? []).map((x) => x.id);
  const lista = await pedir('GET', '/cajas-menudas');
  c(lista.estado === 200 && ids(lista).includes(activa) && !ids(lista).includes(quitada), `la lista general trae la activa y no la quitada (dio ${lista.estado} ${ids(lista)})`);
  const delProyecto = await pedir('GET', '/cajas-menudas/proyecto/1');
  c(delProyecto.estado === 200 && ids(delProyecto).includes(activa) && !ids(delProyecto).includes(quitada), `la del proyecto, igual (dio ${delProyecto.estado} ${ids(delProyecto)})`);

  const detalleActiva = await pedir('GET', `/cajas-menudas/${activa}`);
  c(detalleActiva.estado === 200, `la activa se abre (dio ${detalleActiva.estado})`);
  const detalle = await pedir('GET', `/cajas-menudas/${quitada}`);
  c(detalle.estado === 404, `la quitada no se abre: 404 (dio ${detalle.estado})`);

  const gasto = { fecha: '2026-09-08', proveedor: 'Ferretería', descripcion: 'Tornillos', monto: 5, itbms: 0, monto_total: 5 };
  const nuevoGasto = await pedir('POST', `/cajas-menudas/${quitada}/gastos`, gasto);
  c(nuevoGasto.estado === 404, `no recibe gastos: 404 (dio ${nuevoGasto.estado})`);
  const listaGastos = await pedir('GET', `/cajas-menudas/${quitada}/gastos`);
  c(listaGastos.estado === 404, `ni muestra los suyos: 404 (dio ${listaGastos.estado})`);
  const cerrar = await pedir('PUT', `/cajas-menudas/${quitada}`, { estado: 'cerrada' });
  c(cerrar.estado === 404, `no se cierra ni se edita: 404 (dio ${cerrar.estado})`);
  const aumento = await pedir('PUT', `/cajas-menudas/${quitada}/monto`, { monto_asignado: 1500 });
  c(aumento.estado === 404, `no cambia de monto: 404 (dio ${aumento.estado})`);
  const reembolso = await pedir('POST', `/cajas-menudas/${quitada}/reembolso`, {});
  c(reembolso.estado === 404, `no pide reembolso: 404 (dio ${reembolso.estado})`);

  const queda = (await query<{ estado: string; monto_asignado: string; activo: boolean }>(
    'SELECT estado, monto_asignado, activo FROM cajas_menudas WHERE id = $1', [quitada],
  )).rows[0];
  c(queda.estado === 'abierta' && Number(queda.monto_asignado) === 1000 && queda.activo === false, `la quitada se queda como estaba (dio ${JSON.stringify(queda)})`);
  const gastos = (await query<{ descripcion: string }>(
    'SELECT descripcion FROM cajas_menudas_gastos WHERE caja_menuda_id = $1', [quitada],
  )).rows;
  c(gastos.length === 1 && gastos[0].descripcion === 'Diésel', `su gasto sigue guardado y no entró otro (dio ${gastos.map((g) => g.descripcion)})`);
  const solicitudes = (await query<{ n: string }>(
    "SELECT count(*) AS n FROM solicitudes_pago WHERE observaciones ILIKE '%Caja registrada por error%'",
  )).rows[0];
  c(Number(solicitudes.n) === 0, `no nació ninguna solicitud para ella (dio ${solicitudes.n})`);

  const malId = await pedir('GET', '/cajas-menudas/abc');
  c(malId.estado === 400, `un id que no es número: 400 (dio ${malId.estado})`);

  console.log(`${ok} pasaron, ${fallo} fallaron`);
  await pool.end();
  // Sin process.exit: ver aprobar-clave-humo.ts (Node en Windows revienta si se
  // corta con las conexiones cerrándose).
  process.exitCode = fallo ? 1 : 0;
};

main();
