// Prueba de humo: rechazar la apertura de una caja menuda, y bajar su monto
// antes de que la apertura se transfiera.
// cd andrei-backend && npm run pruebas -- caja-apertura-rechazo
//
// Ivan, 2026-11-19: «si se rechaza un opening request, entonces la caja menuda
// se debe cancelar totalmente. no se puede usar. si hay ya gastos registrados,
// no se debe poder rechazar». Se exige:
// - con gastos, la apertura no se rechaza (409) y nada cambia; el detalle de la
//   solicitud lo dice antes de intentarlo;
// - sin gastos, se rechaza y la caja queda cancelada: monto 0, no admite nada
//   (409 en todo lo que escribe), se sigue viendo y se puede eliminar;
// - bajar el monto con la apertura pendiente o aprobada la reemplaza por una
//   solicitud nueva por el monto nuevo, que empieza de cero su aprobación;
//   con la apertura ya transferida, bajar el monto es como siempre;
// - rechazar un aumento devuelve la caja al monto anterior, como siempre.
import { API } from './pruebas/contexto.js';
import jwt from 'jsonwebtoken';
import { query, pool } from '../src/database/config.js';

interface Usuario {
  id: number;
  email: string;
  rol: string;
}

const main = async () => {
  const admin = (await query<Usuario>(
    "SELECT id, email, rol FROM users WHERE rol='admin' AND activo=true ORDER BY id LIMIT 1",
  )).rows[0];
  // El que rechaza tiene que ser el siguiente aprobador del proyecto.
  await query('DELETE FROM proyecto_ajustes_aprobacion WHERE proyecto_id = 1');
  await query('INSERT INTO proyecto_ajustes_aprobacion (proyecto_id, user_id, orden) VALUES (1, $1, 1)', [admin.id]);

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

  const crearCaja = async (nombre: string, monto = 1000) => {
    const r = await pedir('POST', '/cajas-menudas', { proyecto_id: 1, responsable_id: admin.id, nombre, monto_asignado: monto });
    return r.json.data as { id: number; solicitud_apertura_id: number };
  };
  const gastar = (caja: number, descripcion: string, monto: number) =>
    query(
      `INSERT INTO cajas_menudas_gastos (caja_menuda_id, fecha, proveedor, descripcion, monto, monto_total, registrado_por)
       VALUES ($1, '2026-11-03', 'Super Centro Palenque', $2, $3, $3, $4)`,
      [caja, descripcion, monto, admin.id],
    );
  const laCaja = async (id: number) =>
    (await query<{ estado: string; monto_asignado: string; solicitud_apertura_id: number }>(
      'SELECT estado, monto_asignado, solicitud_apertura_id FROM cajas_menudas WHERE id = $1',
      [id],
    )).rows[0];
  const laSolicitud = async (id: number) =>
    (await query<{ estado: string; activo: boolean; monto_total: string; numero: string; tipo: string }>(
      'SELECT estado, activo, monto_total, numero, tipo FROM solicitudes_pago WHERE id = $1',
      [id],
    )).rows[0];
  const rechazar = (id: number) => pedir('POST', `/solicitudes-pago/${id}/rechazar`, { comentario: 'Se abrió por error' });
  const bajar = (caja: number, monto: number) => pedir('PUT', `/cajas-menudas/${caja}/monto`, { monto_asignado: monto });

  // ── 1. Con gastos, la apertura no se rechaza.
  const conGastos = await crearCaja('Caja Menuda N. 9');
  await gastar(conGastos.id, 'Diésel', 139.99);
  await gastar(conGastos.id, 'Agua', 49.28);
  const detalle = await pedir('GET', `/solicitudes-pago/${conGastos.solicitud_apertura_id}`);
  const aviso = (detalle.json.solicitud as { caja_apertura: { id: number; nombre: string; gastos: number } | null }).caja_apertura;
  c(
    aviso?.id === conGastos.id && aviso.nombre === 'Caja Menuda N. 9' && aviso.gastos === 2,
    `el detalle de la apertura avisa la caja y sus 2 gastos (dio ${JSON.stringify(aviso)})`,
  );
  const r1 = await rechazar(conGastos.solicitud_apertura_id);
  c(
    r1.estado === 409 && String(r1.json.message).includes('ya tiene 2 gastos registrados'),
    `rechazarla con gastos: 409 con el motivo (dio ${r1.estado} ${r1.json.message})`,
  );
  const tras1 = await laCaja(conGastos.id);
  const rechazos1 = (await query("SELECT 1 FROM solicitud_aprobaciones WHERE solicitud_pago_id = $1 AND accion = 'rechazado'", [conGastos.solicitud_apertura_id])).rows.length;
  c(
    (await laSolicitud(conGastos.solicitud_apertura_id)).estado === 'pendiente' && rechazos1 === 0 &&
      tras1.estado === 'abierta' && Number(tras1.monto_asignado) === 1000,
    `y nada cambia: solicitud pendiente sin rechazo, caja abierta con 1000 (dio ${JSON.stringify(tras1)}, ${rechazos1} rechazos)`,
  );

  // ── 2. Bajar el monto con la apertura pendiente la reemplaza.
  const vieja = await laSolicitud(conGastos.solicitud_apertura_id);
  const r2 = await bajar(conGastos.id, 500);
  const d2 = r2.json.data as { solicitud_id: number; solicitud_numero: string; solicitud_reemplazada: string };
  c(r2.estado === 200 && d2?.solicitud_reemplazada === vieja.numero, `bajar a 500: 200 y dice cuál reemplazó (dio ${r2.estado} ${JSON.stringify(r2.json)})`);
  const tras2 = await laCaja(conGastos.id);
  const nueva = await laSolicitud(d2.solicitud_id);
  c(
    tras2.solicitud_apertura_id === d2.solicitud_id && Number(tras2.monto_asignado) === 500 && tras2.estado === 'abierta',
    `la caja queda en 500 con la apertura nueva (dio ${JSON.stringify(tras2)})`,
  );
  c(
    nueva.tipo === 'apertura' && nueva.estado === 'pendiente' && Number(nueva.monto_total) === 500 && nueva.numero === d2.solicitud_numero,
    `la apertura nueva: pendiente por 500 (dio ${JSON.stringify(nueva)})`,
  );
  const renglon = (await query<{ precio_total: string }>('SELECT precio_total FROM solicitud_pago_items WHERE solicitud_pago_id = $1', [d2.solicitud_id])).rows;
  c(renglon.length === 1 && Number(renglon[0].precio_total) === 500, 'con su renglón por 500');
  c(!(await laSolicitud(conGastos.solicitud_apertura_id)).activo, 'la apertura vieja se quitó');
  c((await pedir('GET', `/solicitudes-pago/${conGastos.solicitud_apertura_id}`)).estado === 404, 'y ya no se abre: 404');
  const historial2 = (await query('SELECT 1 FROM cajas_menudas_historial_monto WHERE caja_menuda_id = $1', [conGastos.id])).rows.length;
  c(historial2 === 0, `no hay devolución que anotar: sin historial (dio ${historial2})`);
  const lista2 = ((await pedir('GET', '/cajas-menudas/proyecto/1')).json.data as { id: number; historial_sin_comprobante: boolean }[]).find((x) => x.id === conGastos.id);
  c(lista2?.historial_sin_comprobante === false, 'la lista no la marca como devolución sin comprobante');
  const audit2 = (await query<{ entidad: string; accion: string }>(
    "SELECT entidad, accion FROM audit_log WHERE (entidad = 'solicitud_pago' AND entidad_id = $1) OR (entidad = 'caja_menuda' AND entidad_id = $2 AND accion = 'editar')",
    [conGastos.solicitud_apertura_id, conGastos.id],
  )).rows;
  c(audit2.length === 2, `queda en auditoría: la apertura quitada y el cambio de monto (dio ${JSON.stringify(audit2)})`);
  const r2b = await rechazar(d2.solicitud_id);
  c(r2b.estado === 409, `la apertura nueva tampoco se rechaza con gastos: 409 (dio ${r2b.estado})`);

  // ── 3. Con la apertura aprobada también se reemplaza, y la nueva empieza de cero.
  const aprobada = await crearCaja('Caja aprobada');
  await query("UPDATE solicitudes_pago SET estado = 'aprobada' WHERE id = $1", [aprobada.solicitud_apertura_id]);
  await query("INSERT INTO solicitud_aprobaciones (solicitud_pago_id, user_id, orden, accion) VALUES ($1, $2, 1, 'aprobado')", [aprobada.solicitud_apertura_id, admin.id]);
  const r3 = await bajar(aprobada.id, 400);
  const d3 = r3.json.data as { solicitud_id: number };
  const firmas = (await query('SELECT 1 FROM solicitud_aprobaciones WHERE solicitud_pago_id IN ($1, $2)', [aprobada.solicitud_apertura_id, d3?.solicitud_id])).rows.length;
  c(
    r3.estado === 200 && (await laSolicitud(d3.solicitud_id)).estado === 'pendiente' && firmas === 0 &&
      !(await laSolicitud(aprobada.solicitud_apertura_id)).activo,
    `aprobada sin transferir: se reemplaza por una pendiente sin firmas (dio ${r3.estado}, ${firmas} firmas)`,
  );

  // ── 4. Con la apertura transferida, bajar el monto es como siempre.
  const transferida = await crearCaja('Caja transferida');
  await query("UPDATE solicitudes_pago SET estado = 'transferida' WHERE id = $1", [transferida.solicitud_apertura_id]);
  const r4 = await bajar(transferida.id, 600);
  const tras4 = await laCaja(transferida.id);
  const historial4 = (await query('SELECT 1 FROM cajas_menudas_historial_monto WHERE caja_menuda_id = $1', [transferida.id])).rows.length;
  c(
    r4.estado === 200 && tras4.solicitud_apertura_id === transferida.solicitud_apertura_id && Number(tras4.monto_asignado) === 600 && historial4 === 1,
    `transferida: baja con su historial y la misma apertura (dio ${r4.estado}, historial ${historial4})`,
  );

  // ── 5. Subir el monto con la apertura pendiente sigue sin poderse.
  const pendiente = await crearCaja('Caja pendiente');
  const r5 = await pedir('PUT', `/cajas-menudas/${pendiente.id}/monto`, { monto_asignado: 1500 });
  c(r5.estado === 400 && Number((await laCaja(pendiente.id)).monto_asignado) === 1000, `subir con la apertura pendiente: 400 (dio ${r5.estado})`);

  // ── 6. Apertura aprobada y un aumento en curso: primero se rechaza el aumento.
  const conAumento = await crearCaja('Caja con aumento');
  await query("UPDATE solicitudes_pago SET estado = 'aprobada' WHERE id = $1", [conAumento.solicitud_apertura_id]);
  const subir6 = await pedir('PUT', `/cajas-menudas/${conAumento.id}/monto`, { monto_asignado: 1500 });
  const r6 = await bajar(conAumento.id, 500);
  c(
    subir6.estado === 200 && r6.estado === 400 && String(r6.json.error).includes('aumento') &&
      (await laSolicitud(conAumento.solicitud_apertura_id)).activo,
    `bajar con un aumento en curso: 400 y la apertura sigue (dio ${r6.estado} ${r6.json.error})`,
  );

  // ── 7. Rechazar un aumento devuelve la caja al monto anterior, como siempre.
  const aumento = (subir6.json.data as { solicitud_id: number }).solicitud_id;
  const r7 = await rechazar(aumento);
  const tras7 = await laCaja(conAumento.id);
  c(
    r7.estado === 200 && tras7.estado === 'abierta' && Number(tras7.monto_asignado) === 1000,
    `rechazar el aumento: 200, la caja vuelve a 1000 y sigue abierta (dio ${r7.estado} ${JSON.stringify(tras7)})`,
  );

  // ── 8. Sin gastos, la apertura se rechaza y la caja queda cancelada.
  const sinGastos = await crearCaja('Caja Menuda N. 10');
  const r8 = await rechazar(sinGastos.solicitud_apertura_id);
  const tras8 = await laCaja(sinGastos.id);
  c(r8.estado === 200 && (await laSolicitud(sinGastos.solicitud_apertura_id)).estado === 'rechazada', `sin gastos se rechaza: 200 (dio ${r8.estado} ${r8.json.message})`);
  c(tras8.estado === 'cancelada' && Number(tras8.monto_asignado) === 0, `la caja queda cancelada con 0 (dio ${JSON.stringify(tras8)})`);
  const audit8 = (await query<{ detalles: { comentario: string } }>(
    "SELECT detalles FROM audit_log WHERE entidad = 'caja_menuda' AND entidad_id = $1 AND accion = 'cancelar'",
    [sinGastos.id],
  )).rows;
  c(audit8.length === 1 && audit8[0].detalles.comentario === 'Se abrió por error', 'queda en auditoría con el motivo del rechazo');
  const enLista = ((await pedir('GET', '/cajas-menudas/proyecto/1')).json.data as { id: number; estado: string }[]).find((x) => x.id === sinGastos.id);
  c(enLista?.estado === 'cancelada', `sigue en la lista, como cancelada (dio ${enLista?.estado})`);
  c((await pedir('GET', `/cajas-menudas/${sinGastos.id}`)).estado === 200, 'y se sigue abriendo');

  // Ya no admite nada.
  const intentos: [string, string, unknown?][] = [
    ['POST', `/cajas-menudas/${sinGastos.id}/gastos`, { fecha: '2026-11-03', proveedor: 'X', descripcion: 'Y', monto: 5 }],
    ['PUT', `/cajas-menudas/${sinGastos.id}/monto`, { monto_asignado: 300 }],
    ['PUT', `/cajas-menudas/${sinGastos.id}`, { nombre: 'Otro nombre' }],
    ['PUT', `/cajas-menudas/${sinGastos.id}`, { estado: 'abierta' }],
    ['POST', `/cajas-menudas/${sinGastos.id}/reembolso`, {}],
    ['DELETE', `/cajas-menudas/${sinGastos.id}/gastos/1`],
  ];
  for (const [metodo, ruta, cuerpo] of intentos) {
    const r = await pedir(metodo, ruta, cuerpo);
    c(r.estado === 409, `cancelada, ${metodo} ${ruta.replace(/\/\d+/g, '/:id')}: 409 (dio ${r.estado} ${r.json.error})`);
  }
  const tras8b = await laCaja(sinGastos.id);
  c(tras8b.estado === 'cancelada' && Number(tras8b.monto_asignado) === 0, 'y sigue igual');

  // Se puede eliminar.
  const vista = await pedir('GET', `/cajas-menudas/${sinGastos.id}/eliminacion`);
  c((vista.json.data as { motivo: string | null })?.motivo === null, 'una caja cancelada se puede eliminar');
  const borrar = await pedir('DELETE', `/cajas-menudas/${sinGastos.id}`);
  c(borrar.estado === 200, `y se elimina: 200 (dio ${borrar.estado} ${borrar.json.error})`);

  // ── 9. Una solicitud normal no trae caja.
  const normal = (await query<{ id: number }>(
    `INSERT INTO solicitudes_pago (proyecto_id, numero, fecha, proveedor, preparado_por, solicitado_por, subtotal, descuentos, impuestos, monto_total, estado, tipo, codigo_verificacion)
     VALUES (1, 'PRU1-901', CURRENT_DATE, 'Ferretería', $1, $1, 10, 0, 0, 10, 'pendiente', 'regular', 'PRUEBA91') RETURNING id`,
    [admin.id],
  )).rows[0].id;
  const dNormal = await pedir('GET', `/solicitudes-pago/${normal}`);
  c((dNormal.json.solicitud as { caja_apertura: unknown }).caja_apertura === null, 'una solicitud normal no trae caja');
  const rNormal = await rechazar(normal);
  c(rNormal.estado === 200, `y se rechaza como siempre: 200 (dio ${rNormal.estado})`);

  console.log(`${ok} pasaron, ${fallo} fallaron`);
  await pool.end();
  // Sin process.exit: ver aprobar-clave-humo.ts (Node en Windows revienta si se
  // corta con las conexiones cerrándose).
  process.exitCode = fallo ? 1 : 0;
};

main();
