// Prueba de humo: la compra por orden de compra, a credito, de punta a punta.
// cd andrei-backend && npm run pruebas -- ordenes
//
// Lo que se comprueba, y por que cada cosa importa:
//
//   * La orden LLEGA COMPLETA, en un solo paso (Ivan, 2026-10-02: las entregas
//     parciales se quitaron). Hasta que se marca como recibida no se debe nada;
//     al marcarla se debe entera —con su descuento— y corre el termino.
//   * 'recibida' se calcula de la recepcion, no se guarda.
//   * No se puede pedir dos veces la misma plata: el tope para activar un pago
//     es lo recibido menos lo que ya tiene una solicitud encima.
//   * Una orden ya enviada solo la edita un admin, con motivo; ya recibida no
//     se edita ni se da de baja: se debe completa.
//
// Usa el proyecto 3, que en la semilla no tiene aprobadores ni solicitudes.
import { API } from './pruebas/contexto.js';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { query, pool } from '../src/database/config.js';

const P = 3;
const TERMINO = 30;

const main = async () => {
  const admin = (
    await query<{ id: number; email: string; rol: string }>(
      "SELECT id, email, rol FROM users WHERE rol='admin' AND activo=true ORDER BY id LIMIT 1",
    )
  ).rows[0];
  const otros = (
    await query<{ id: number; email: string; rol: string }>(
      'SELECT id, email, rol FROM users WHERE activo = true AND id <> $1 ORDER BY id LIMIT 2',
      [admin.id],
    )
  ).rows;

  const firmar = (u: { id: number; email: string; rol: string }) =>
    jwt.sign({ userId: u.id, email: u.email, rol: u.rol }, process.env.JWT_SECRET!, {
      expiresIn: '10m',
    });
  const tokenAdmin = firmar(admin);

  const pedir = async (
    metodo: string,
    ruta: string,
    cuerpo?: unknown,
    token = tokenAdmin,
  ) => {
    const res = await fetch(`${API}${ruta}`, {
      method: metodo,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(cuerpo ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(cuerpo ? { body: JSON.stringify(cuerpo) } : {}),
    });
    return { estado: res.status, cuerpo: await res.json().catch(() => null) };
  };

  const bajarPdf = async (ordenId: number) => {
    const res = await fetch(`${API}/ordenes-compra/${ordenId}/pdf`, {
      headers: { Authorization: `Bearer ${tokenAdmin}` },
    });
    const cuerpo = Buffer.from(await res.arrayBuffer());
    return {
      estado: res.status,
      tipo: res.headers.get('content-type'),
      nombre: res.headers.get('content-disposition'),
      bytes: cuerpo.length,
      esPdf: cuerpo.subarray(0, 5).toString() === '%PDF-',
    };
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

  const previo = await query<{ oc: string; ap: string }>(
    `SELECT (SELECT count(*) FROM ordenes_compra WHERE proyecto_id = $1) oc,
            (SELECT count(*) FROM proyecto_ajustes_aprobacion WHERE proyecto_id = $1) ap`,
    [P],
  );
  if (previo.rows[0].oc !== '0' || previo.rows[0].ap !== '0') {
    console.log(`el proyecto ${P} ya tiene ordenes o aprobadores; la prueba no lo toca`);
    await pool.end();
    process.exit(1);
  }

  // La cadena del proyecto: dos firmas, en orden.
  for (const [i, u] of otros.entries()) {
    await query(
      'INSERT INTO proyecto_ajustes_aprobacion (proyecto_id, user_id, orden) VALUES ($1, $2, $3)',
      [P, u.id, i + 1],
    );
  }

  // Aprobar pide la contraseña de quien firma. La semilla no les pone ninguna a
  // proposito; aqui se les da una que solo vive lo que dura la prueba.
  const CLAVE = randomUUID();
  await query('UPDATE users SET password = $1 WHERE id = ANY($2::int[])', [
    await bcrypt.hash(CLAVE, 4),
    otros.map((u) => u.id),
  ]);
  const conClave = { password: CLAVE };

  const ORDEN_NUEVA = {
    proyecto_id: P,
    fecha: '2026-08-18',
    proveedor: 'Cemento de pruebas, S.A.',
    proveedor_ruc: '1-2-3 DV 45',
    termino_dias: TERMINO,
    entrega: 'sitio',
    condiciones: 'Descarga en el patio de obra.',
    items: [
      { cantidad: 100, unidad: 'saco', codigo: 'A1', descripcion: 'Cemento', precio_unitario: 10 },
      { cantidad: 20, unidad: 'm3', codigo: 'B2', descripcion: 'Arena', precio_unitario: 50 },
      { cantidad: 10, unidad: 'unidad', codigo: 'C3', descripcion: 'Aditivo', precio_unitario: 25 },
    ],
  };

  // ---------------------------------------------------------------- crear
  const alta = await pedir('POST', '/ordenes-compra', ORDEN_NUEVA);
  c(alta.estado === 201, `crear responde 201 (dio ${alta.estado})`);
  const id = alta.cuerpo?.data?.id as number;
  c(alta.cuerpo?.data?.numero === 'OC-PRU3-001', `numero OC-PRU3-001 (dio ${alta.cuerpo?.data?.numero})`);
  c(alta.cuerpo?.data?.estado === 'pendiente', 'nace esperando aprobacion');
  c(Number(alta.cuerpo?.data?.subtotal) === 2250, 'subtotal 2250');
  c(Number(alta.cuerpo?.data?.itbms) === 157.5, 'ITBMS 7% = 157.50');
  c(Number(alta.cuerpo?.data?.monto_total) === 2407.5, 'total 2407.50');

  const sinRenglones = await pedir('POST', '/ordenes-compra', { ...ORDEN_NUEVA, items: [] });
  c(sinRenglones.estado === 400, 'una orden sin renglones se rechaza');

  const ver = async () => (await pedir('GET', `/ordenes-compra/${id}`)).cuerpo?.data;

  const pdfBorrador = await bajarPdf(id);
  c(pdfBorrador.estado === 200 && pdfBorrador.esPdf, 'el papel se puede bajar desde el principio');

  // Nada se recibe antes de que la orden salga al proveedor.
  const prematura = await pedir('POST', `/ordenes-compra/${id}/recibir`, { fecha: '2026-08-20' });
  c(prematura.estado === 400, 'no se recibe una orden antes de enviarla');

  // ------------------------------------------------------------ aprobar
  const sinClave = await pedir('POST', `/ordenes-compra/${id}/aprobar`, {}, firmar(otros[0]));
  c(sinClave.estado === 400, 'aprobar sin contraseña se rechaza');
  const claveMala = await pedir(
    'POST',
    `/ordenes-compra/${id}/aprobar`,
    { password: 'no-es-esta' },
    firmar(otros[0]),
  );
  c(
    claveMala.estado === 403,
    `con la contraseña equivocada tambien, y con 403: un 401 sacaria a la persona del sistema (dio ${claveMala.estado})`,
  );
  c((await ver()).estado === 'pendiente', 'y la orden sigue esperando la firma');
  const fueraDeTurno = await pedir('POST', `/ordenes-compra/${id}/aprobar`, conClave, firmar(otros[1]));
  c(fueraDeTurno.estado === 403, 'el segundo aprobador no puede firmar primero');

  const firma1 = await pedir('POST', `/ordenes-compra/${id}/aprobar`, conClave, firmar(otros[0]));
  c(firma1.estado === 200, `la primera firma responde 200 (dio ${firma1.estado})`);
  c((await ver()).estado === 'pendiente', 'con una sola firma sigue pendiente');

  const firma2 = await pedir('POST', `/ordenes-compra/${id}/aprobar`, conClave, firmar(otros[1]));
  c(firma2.estado === 200, 'la segunda firma responde 200');
  let orden = await ver();
  c(orden.estado === 'por_enviar', `con las dos firmas queda por enviar (dio ${orden.estado})`);
  c(Number(orden.recibido) === 0 && Number(orden.por_pagar) === 0, 'aprobada no debe nada todavia');

  // -------------------------------------------------------- marcar enviada
  const enviada = await pedir('POST', `/ordenes-compra/${id}/marcar-enviada`);
  c(enviada.estado === 200, 'Martina la marca como enviada al proveedor');
  c((await pedir('POST', `/ordenes-compra/${id}/marcar-enviada`)).estado === 400,
    'no se marca dos veces');
  orden = await ver();
  c(orden.estado_calculado === 'enviada', 'sin recibir, el estado que se ve es enviada');
  c(Number(orden.por_pagar) === 0, 'y todavia no se debe nada');

  const pdfAprobado = await bajarPdf(id);
  c(pdfAprobado.estado === 200 && pdfAprobado.esPdf, 'el papel aprobado se baja igual');
  c(
    pdfAprobado.tipo === 'application/pdf' &&
      String(pdfAprobado.nombre).includes('OC-PRU3-001.pdf'),
    'con su nombre de archivo',
  );
  c(
    pdfAprobado.bytes > pdfBorrador.bytes + 500,
    `y pesa mas que el borrador porque trae el QR (${pdfBorrador.bytes} -> ${pdfAprobado.bytes})`,
  );

  // --------------------------------------------- editar ya enviada, sin recibir
  const sinMotivo = await pedir('PUT', `/ordenes-compra/${id}`, { termino_dias: 45 });
  c(sinMotivo.estado === 400, 'una orden enviada no se edita sin motivo');

  const noAdmin = await pedir(
    'PUT',
    `/ordenes-compra/${id}`,
    { termino_dias: 45, motivo: 'probando' },
    firmar(otros[0]),
  );
  c(noAdmin.estado === 403, 'y solo la edita un administrador');

  const edicion = await pedir('PUT', `/ordenes-compra/${id}`, {
    termino_dias: 45,
    motivo: 'Renegociado con el proveedor',
  });
  c(edicion.estado === 200, `editar con motivo responde 200 (dio ${edicion.estado})`);
  orden = await ver();
  c(orden.cambios?.length === 1, `queda una linea de cambios (dio ${orden.cambios?.length})`);
  c(
    orden.cambios?.[0]?.cambios?.[0]?.campo === 'Término de pago',
    'que dice cual campo cambio',
  );
  c(orden.cambios?.[0]?.motivo === 'Renegociado con el proveedor', 'con su motivo');

  // ----------------------------------------------------- marcar como recibida
  // La orden llega completa, en un solo paso (Ivan, 2026-10-02): desde ese dia
  // se debe entera y corre el termino de pago.
  const sinFecha = await pedir('POST', `/ordenes-compra/${id}/recibir`, {});
  c(sinFecha.estado === 400, 'recibirla pide la fecha en que llego');

  const recibida = await pedir('POST', `/ordenes-compra/${id}/recibir`, {
    fecha: '2026-09-01',
    nota: 'Llego en dos camiones',
  });
  c(recibida.estado === 201, `marcarla como recibida responde 201 (dio ${recibida.estado})`);
  c(
    Number(recibida.cuerpo?.data?.monto_total) === 2407.5,
    `se debe la orden completa, 2407.50 (dio ${recibida.cuerpo?.data?.monto_total})`,
  );
  c(
    String(recibida.cuerpo?.data?.vence).startsWith('2026-10-16'),
    `vence 45 dias despues de llegar, con el termino ya cambiado (dio ${recibida.cuerpo?.data?.vence})`,
  );
  c(
    (await pedir('POST', `/ordenes-compra/${id}/recibir`, { fecha: '2026-09-02' })).estado === 400,
    'no se recibe dos veces',
  );

  orden = await ver();
  c(orden.estado === 'enviada', 'en la base el estado guardado sigue siendo enviada');
  c(orden.estado_calculado === 'recibida', `y el que se ve es recibida (dio ${orden.estado_calculado})`);
  c(Number(orden.recibido) === 2407.5, 'recibido = el total de la orden');
  c(Number(orden.por_pagar) === 2407.5, 'y se debe completa');
  c(orden.entregas?.length === 1, 'queda una sola recepcion');
  c(String(orden.vence).startsWith('2026-10-16'), 'y la orden sabe cuando vence');

  const editarRecibida = await pedir('PUT', `/ordenes-compra/${id}`, {
    condiciones: 'Otra cosa',
    motivo: 'Probando',
  });
  c(editarRecibida.estado === 400, 'una orden recibida ya no se edita');
  c(
    (await pedir('POST', `/ordenes-compra/${id}/baja`, { motivo: 'Probando' })).estado === 400,
    'ni se da de baja: se debe completa',
  );

  // ------------------------------------------------------- activar el pago
  const recepcion = recibida.cuerpo.data.id as number;
  const pagoDeMas = await pedir('POST', `/ordenes-compra/${id}/activar-pago`, {
    entregas: [{ entrega_id: recepcion, monto: 3000 }],
  });
  c(pagoDeMas.estado === 400, 'no se activa un pago mayor que la orden');

  const pago1 = await pedir('POST', `/ordenes-compra/${id}/activar-pago`, {
    entregas: [{ entrega_id: recepcion, monto: 300 }],
  });
  c(pago1.estado === 201, `activar un pago parcial responde 201 (dio ${pago1.estado})`);
  const solicitudId = pago1.cuerpo?.data?.id as number;

  orden = await ver();
  c(
    Number(orden.disponible_para_activar) === 2107.5,
    `quedan 2107.50 por reclamar (dio ${orden.disponible_para_activar})`,
  );
  c(Number(orden.por_pagar) === 2407.5, 'pero la deuda con el proveedor sigue en 2407.50');

  const pidiendoDosVeces = await pedir('POST', `/ordenes-compra/${id}/activar-pago`, {
    entregas: [{ entrega_id: recepcion, monto: 2200 }],
  });
  c(pidiendoDosVeces.estado === 400, 'no se puede pedir dos veces la misma plata');

  // El pago se marca pagado como lo haria la pantalla de solicitudes.
  await query("UPDATE solicitudes_pago SET estado = 'pagada' WHERE id = $1", [solicitudId]);
  orden = await ver();
  c(Number(orden.pagado) === 300, `pagado 300.00 (dio ${orden.pagado})`);
  c(Number(orden.por_pagar) === 2107.5, `por pagar 2107.50 (dio ${orden.por_pagar})`);

  // Control de costos: lo recibido y sin pagar es COSTO, aunque la plata no haya
  // salido: 300 pagado + 2107.50 por pagar = 2407.50 de costo.
  const costos = await pedir('GET', '/costs/projects/' + P + '/resumen');
  c(costos.estado === 200, `el resumen de costos responde 200 (dio ${costos.estado})`);
  c(Number(costos.cuerpo?.data?.gastado) === 300, `pagado 300.00 (dio ${costos.cuerpo?.data?.gastado})`);
  c(
    Number(costos.cuerpo?.data?.porPagar) === 2107.5,
    `por pagar 2107.50 (dio ${costos.cuerpo?.data?.porPagar})`,
  );
  c(
    Number(costos.cuerpo?.data?.costoHastaHoy) === 2407.5,
    `y el costo hasta hoy es la orden recibida (dio ${costos.cuerpo?.data?.costoHastaHoy})`,
  );

  // Una solicitud rechazada suelta la plata que tenia reservada.
  const pago2 = await pedir('POST', `/ordenes-compra/${id}/activar-pago`, {
    entregas: [{ entrega_id: recepcion, monto: 2107.5 }],
  });
  c(pago2.estado === 201, 'se activa el resto');
  c(Number((await ver()).disponible_para_activar) === 0, 'y ya no queda nada por reclamar');
  await query("UPDATE solicitudes_pago SET estado = 'rechazada' WHERE id = $1", [
    pago2.cuerpo.data.id,
  ]);
  c(
    Number((await ver()).disponible_para_activar) === 2107.5,
    'al rechazarse la solicitud, sus 2107.50 vuelven a estar disponibles',
  );

  // ------------------------------------------------------------- rechazar
  const dos = await pedir('POST', '/ordenes-compra', ORDEN_NUEVA);
  c(dos.cuerpo?.data?.numero === 'OC-PRU3-002', 'la segunda orden es la 002');
  const sinComentario = await pedir(
    'POST',
    `/ordenes-compra/${dos.cuerpo.data.id}/rechazar`,
    {},
    firmar(otros[0]),
  );
  c(sinComentario.estado === 400, 'rechazar exige comentario');
  const rechazo = await pedir(
    'POST',
    `/ordenes-compra/${dos.cuerpo.data.id}/rechazar`,
    { comentario: 'El precio no es el acordado' },
    firmar(otros[0]),
  );
  c(rechazo.estado === 200, 'rechazar responde 200');
  c(
    (await pedir('GET', `/ordenes-compra/${dos.cuerpo.data.id}`)).cuerpo.data.estado === 'rechazada',
    'y la orden queda rechazada',
  );

  // --------------------------------------------------------- dar de baja
  // Solo antes de recibirla: enviada al proveedor, pero sin llegar.
  const tres = await pedir('POST', '/ordenes-compra', ORDEN_NUEVA);
  const id3 = tres.cuerpo.data.id as number;
  await pedir('POST', `/ordenes-compra/${id3}/aprobar`, conClave, firmar(otros[0]));
  await pedir('POST', `/ordenes-compra/${id3}/aprobar`, conClave, firmar(otros[1]));
  await pedir('POST', `/ordenes-compra/${id3}/marcar-enviada`);

  c((await pedir('POST', `/ordenes-compra/${id3}/baja`, {})).estado === 400,
    'dar de baja exige motivo');
  const baja = await pedir('POST', `/ordenes-compra/${id3}/baja`, {
    motivo: 'El proveedor no tenia el material',
  });
  c(baja.estado === 200, 'dar de baja responde 200');

  const tras = (await pedir('GET', `/ordenes-compra/${id3}`)).cuerpo.data;
  c(tras.estado === 'dada_de_baja', 'la orden queda dada de baja');
  c(Number(tras.por_pagar) === 0, `y no se debe nada (dio ${tras.por_pagar})`);
  c(
    (await pedir('POST', `/ordenes-compra/${id3}/recibir`, { fecha: '2026-09-30' })).estado === 400,
    'ya no se puede recibir',
  );

  // ------------------------------------------------------------- la lista
  const lista = await pedir('GET', '/ordenes-compra');
  c(lista.estado === 200, 'la lista responde 200');
  const filas = lista.cuerpo.data as { id: number; estado_calculado: string }[];
  c(filas.length === 3, `trae las tres ordenes (dio ${filas.length})`);
  c(
    filas.find((f) => f.id === id)?.estado_calculado === 'recibida',
    'con el estado calculado de cada una',
  );
  c(Number(lista.cuerpo.resumen.por_pagar) > 0, 'y un resumen con lo que se debe');

  // ------------------------------------------------- el orden de la lista
  // Igual que en las solicitudes: arriba la que espera TU firma, despues las
  // demas pendientes, luego por estado, y al fondo rechazadas y dadas de baja.
  // La 004 espera al primer aprobador; la 005 ya tiene su firma y espera al
  // segundo. Mirando como el primero, la 004 tiene que subir por encima de la
  // 005 aunque sea mas vieja.
  const cuatro = (await pedir('POST', '/ordenes-compra', ORDEN_NUEVA)).cuerpo.data.id as number;
  const cinco = (await pedir('POST', '/ordenes-compra', ORDEN_NUEVA)).cuerpo.data.id as number;
  await pedir('POST', `/ordenes-compra/${cinco}/aprobar`, conClave, firmar(otros[0]));
  await query(
    `INSERT INTO user_permissions (user_id, ordenes_ver, acceso_global) VALUES ($1, true, true)
     ON CONFLICT (user_id) DO UPDATE SET ordenes_ver = true, acceso_global = true`,
    [otros[0].id],
  );
  const ordenVista = ((await pedir('GET', '/ordenes-compra', undefined, firmar(otros[0]))).cuerpo
    .data as { id: number }[]).map((f) => f.id);
  c(
    JSON.stringify(ordenVista) === JSON.stringify([cuatro, cinco, id, dos.cuerpo.data.id, id3]),
    `mi turno, pendientes, recibida, rechazada, dada de baja (dio ${ordenVista})`,
  );

  // ------------------------------------------------- con descuento
  // Al recibirla se debe lo que dice la orden, con su descuento: no la suma de
  // los renglones a precio lleno.
  const conDescuento = await pedir('POST', '/ordenes-compra', { ...ORDEN_NUEVA, descuento: 250 });
  const idD = conDescuento.cuerpo.data.id as number;
  c(
    Number(conDescuento.cuerpo?.data?.monto_total) === 2140,
    `2250 - 250 de descuento + ITBMS = 2140.00 (dio ${conDescuento.cuerpo?.data?.monto_total})`,
  );
  await pedir('POST', `/ordenes-compra/${idD}/aprobar`, conClave, firmar(otros[0]));
  await pedir('POST', `/ordenes-compra/${idD}/aprobar`, conClave, firmar(otros[1]));
  await pedir('POST', `/ordenes-compra/${idD}/marcar-enviada`);
  const recibidaD = await pedir('POST', `/ordenes-compra/${idD}/recibir`, { fecha: '2026-09-05' });
  c(
    Number(recibidaD.cuerpo?.data?.monto_total) === 2140,
    `recibida, se deben los 2140.00 de la orden (dio ${recibidaD.cuerpo?.data?.monto_total})`,
  );
  c(
    Number((await pedir('GET', `/ordenes-compra/${idD}`)).cuerpo.data.por_pagar) === 2140,
    'y eso es lo que queda por pagar',
  );

  // --------------------------------------------------- la pagina del codigo
  const codigo = (
    await query<{ codigo_verificacion: string }>(
      'SELECT codigo_verificacion FROM ordenes_compra WHERE id = $1',
      [id],
    )
  ).rows[0].codigo_verificacion;

  // Sin token: la pagina es publica, la abre quien escanee el papel.
  const publica = await fetch(`${API}/verificar/${codigo}`);
  const vc = await publica.json();
  c(publica.status === 200, `verificar responde 200 sin sesion (dio ${publica.status})`);
  c(vc?.data?.tipo === 'orden_compra', 'y dice que el codigo es de una orden de compra');
  c(vc?.data?.numero === 'OC-PRU3-001', 'con su numero');
  c(vc?.data?.estado === 'recibida', `y el estado calculado (dio ${vc?.data?.estado})`);
  c(vc?.data?.aprobaciones?.length === 2, 'con los dos nombres que la aprobaron');
  c(vc?.data?.termino_dias === 45, 'y el termino que el proveedor tiene que poder confirmar');
  c(
    !('pagado' in (vc?.data ?? {})) && !('por_pagar' in (vc?.data ?? {})),
    'sin decirle a nadie cuanto se ha pagado ni cuanto se debe',
  );

  const inventado = await fetch(`${API}/verificar/ZZZZZZZZ`);
  c(inventado.status === 404, 'un codigo inventado da 404');

  // ------------------------------------------------------------ las llaves
  // Sin «ordenes_ver» la seccion no existe; con ella pero sin
  // «ordenes_entregas» se mira pero no se marca lo que llego; y ninguna de las
  // dos alcanza un proyecto al que la persona no tiene acceso.
  const sinLlaves = otros[0];
  await query(
    `INSERT INTO user_permissions (user_id, ordenes_ver, ordenes_entregas, acceso_global)
     VALUES ($1, false, false, false)
     ON CONFLICT (user_id) DO UPDATE SET ordenes_ver = false, ordenes_entregas = false,
                                         acceso_global = false`,
    [sinLlaves.id],
  );
  c(
    (await pedir('GET', '/ordenes-compra', undefined, firmar(sinLlaves))).estado === 403,
    'sin la llave de ver, la lista responde 403',
  );

  await query('UPDATE user_permissions SET ordenes_ver = true WHERE user_id = $1', [sinLlaves.id]);
  c(
    (await pedir('GET', '/ordenes-compra', undefined, firmar(sinLlaves))).estado === 200,
    'con la llave de ver, la lista abre',
  );
  c(
    (await pedir('POST', `/ordenes-compra/${cinco}/recibir`, { fecha: '2026-09-22' }, firmar(sinLlaves)))
      .estado === 403,
    'pero marcar una orden como recibida necesita su propia llave',
  );

  // Con las dos llaves pero sin acceso al proyecto, tampoco.
  await query(
    'UPDATE user_permissions SET ordenes_entregas = true WHERE user_id = $1',
    [sinLlaves.id],
  );
  await query('DELETE FROM user_project_access WHERE user_id = $1', [sinLlaves.id]);
  c(
    (await pedir('POST', '/ordenes-compra', ORDEN_NUEVA, firmar(sinLlaves))).estado === 403,
    'y las llaves no alcanzan un proyecto que no es suyo',
  );

  // ------------------------------------------------- lo que el PUT no toca
  // El SET se arma solo con lo que viene. Mandar una sola cosa no puede dejar
  // en blanco el resto —la regla del CLAUDE.md, que aqui se comprueba—. Sobre
  // la 004, todavia pendiente: la recibida ya no se edita.
  const verCuatro = async () => (await pedir('GET', `/ordenes-compra/${cuatro}`)).cuerpo?.data;
  const antes = await verCuatro();
  const soloCondiciones = await pedir('PUT', `/ordenes-compra/${cuatro}`, {
    condiciones: 'Nueva condicion',
  });
  c(soloCondiciones.estado === 200, 'editar un solo campo responde 200');
  const despues = await verCuatro();
  c(despues.condiciones === 'Nueva condicion', 'cambia lo que se mando');
  c(
    despues.proveedor === antes.proveedor &&
      despues.proveedor_ruc === antes.proveedor_ruc &&
      Number(despues.monto_total) === Number(antes.monto_total) &&
      despues.items.length === antes.items.length,
    'y NO borra el proveedor, el RUC, el monto ni los renglones',
  );

  // --------------------------------------------------------- la numeracion
  // Cada proyecto lleva su propia cuenta, con el prefijo que ya usa para sus
  // solicitudes de pago.
  const otroProyecto = { ...ORDEN_NUEVA, proyecto_id: 1 };
  await query(
    'INSERT INTO proyecto_ajustes_aprobacion (proyecto_id, user_id, orden) VALUES (1, $1, 1)',
    [otros[0].id],
  );
  const enOtro = await pedir('POST', '/ordenes-compra', otroProyecto);
  c(
    enOtro.cuerpo?.data?.numero === 'OC-PRU1-001',
    `otro proyecto empieza en su 001 (dio ${enOtro.cuerpo?.data?.numero})`,
  );

  await query("UPDATE proyectos SET sp_prefijo = NULL WHERE id = 2");
  await query(
    'INSERT INTO proyecto_ajustes_aprobacion (proyecto_id, user_id, orden) VALUES (2, $1, 1)',
    [otros[0].id],
  );
  const sinPrefijo = await pedir('POST', '/ordenes-compra', { ...ORDEN_NUEVA, proyecto_id: 2 });
  c(sinPrefijo.estado === 400, 'un proyecto sin prefijo no puede emitir ordenes');
  await query("UPDATE proyectos SET sp_prefijo = 'PRU2' WHERE id = 2");

  await query('DELETE FROM proyecto_ajustes_aprobacion WHERE proyecto_id = 2');
  const sinAprobadores = await pedir('POST', '/ordenes-compra', { ...ORDEN_NUEVA, proyecto_id: 2 });
  c(
    sinAprobadores.estado === 400,
    'y un proyecto sin aprobadores tampoco: la orden se quedaria trabada',
  );

  // ------------------------------------------------------------- adjuntos
  // La cotizacion va sobre la orden; el vale firmado, sobre su recepcion.
  const subir = async (nombre, descripcion, entregaId) => {
    const fd = new FormData();
    fd.append('archivo', new Blob([Buffer.from('%PDF-1.4 de mentira')], { type: 'application/pdf' }), nombre);
    fd.append('descripcion', descripcion);
    if (entregaId) fd.append('entrega_id', String(entregaId));
    const res = await fetch(`${API}/ordenes-compra/${id}/adjuntos`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      body: fd,
    });
    return { estado: res.status, cuerpo: await res.json().catch(() => null) };
  };

  const cotizacion = await subir('cotizacion.pdf', 'Cotizacion del proveedor');
  c(cotizacion.estado === 201, `subir la cotizacion responde 201 (dio ${cotizacion.estado})`);
  const vale = await subir('vale.pdf', 'Vale firmado en obra', recepcion);
  c(vale.estado === 201, 'subir el vale de la recepcion responde 201');

  const conAdjuntos = await ver();
  c(conAdjuntos.adjuntos.length === 1, 'la orden tiene su cotizacion');
  c(
    conAdjuntos.entregas.find((x) => x.id === recepcion)?.adjuntos?.length === 1,
    'y la recepcion, su vale',
  );

  // Abrirlos: sin estos enlaces los adjuntos se guardaban pero nadie podia
  // verlos (Ivan, 2026-10-02).
  const enlaces = await pedir('GET', `/ordenes-compra/${id}/adjuntos/urls`);
  c(
    enlaces.estado === 200 && enlaces.cuerpo?.adjuntos?.length === 2,
    `los dos adjuntos traen su enlace (dio ${enlaces.estado}, ${enlaces.cuerpo?.adjuntos?.length})`,
  );
  const abierto = await fetch(enlaces.cuerpo.adjuntos[0].url);
  c(
    abierto.ok && (await abierto.text()).startsWith('%PDF'),
    'y el enlace abre el archivo de verdad',
  );
  c(
    (await pedir('GET', `/ordenes-compra/${id}/adjuntos/urls`, undefined, firmar(sinLlaves)))
      .estado === 403,
    'quien no tiene acceso al proyecto no recibe enlaces',
  );
  c(
    (await pedir('DELETE', `/ordenes-compra/${id}/adjuntos/${cotizacion.cuerpo.data.id}`)).estado === 200,
    'y un adjunto se puede quitar',
  );

  // --------------------------------------------------------------- cerrar
  // Normalmente se cierra sola; a mano pide motivo si todavia queda algo.
  const cerrarSinMotivo = await pedir('POST', `/ordenes-compra/${id}/cerrar`, {});
  c(cerrarSinMotivo.estado === 400, 'no se cierra con saldo sin decir por que');
  const cerrar = await pedir('POST', `/ordenes-compra/${id}/cerrar`, {
    motivo: 'Quedaron centavos de redondeo',
  });
  c(cerrar.estado === 200, 'con motivo si se cierra');
  c((await ver()).estado === 'cerrada', 'y queda cerrada');

  // ------------------------------------------------------------- el rastro
  const rastro = await query<{ accion: string }>(
    "SELECT accion FROM audit_log WHERE entidad = 'orden_compra' ORDER BY id",
  );
  const acciones = new Set(rastro.rows.map((r) => r.accion));
  for (const a of ['crear', 'aprobar', 'rechazar', 'enviar', 'recibir', 'editar', 'dar_de_baja']) {
    c(acciones.has(a), `queda rastro de «${a}»`);
  }

  console.log(`${ok} pasaron, ${fallo} fallaron`);
  await pool.end();
  process.exit(fallo ? 1 : 0);
};

main();
