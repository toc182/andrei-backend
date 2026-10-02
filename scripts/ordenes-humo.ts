// Prueba de humo: la compra por orden de compra, a credito, de punta a punta.
// cd andrei-backend && npm run pruebas -- ordenes
//
// Lo que se comprueba, y por que cada cosa importa:
//
//   * Se paga LO QUE SE VA RECIBIENDO. Una orden recien enviada no debe nada,
//     aunque tenga monto. La deuda la hacen las entregas.
//   * Cada entrega congela su vencimiento (su fecha + el termino de ese
//     momento). Si despues un admin cambia el termino, la entrega vieja NO se
//     mueve: el proveedor ya quedo en una fecha.
//   * 'entrega_parcial' y 'recibida' se calculan de las entregas, no se
//     guardan. La prueba mira que el calculo siga a las entregas.
//   * No se puede pedir dos veces la misma plata: el tope para activar un pago
//     es lo recibido menos lo que ya tiene una solicitud encima.
//   * Una orden ya enviada solo la edita un admin, con motivo, y nunca por
//     debajo de lo ya recibido.
//   * Una orden DADA DE BAJA sigue debiendo lo que llego, y ese pago se puede
//     activar: si no, la deuda no tendria salida.
//
// Usa el proyecto 3, que en la semilla no tiene aprobadores ni solicitudes.
import { API } from './pruebas/contexto.js';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { query, pool } from '../src/database/config.js';

const P = 3;
const TERMINO = 30;

interface Renglon {
  id: number;
  descripcion: string;
  cantidad: string;
  recibido_cantidad: string;
}

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

  // Nada de entregas antes de que la orden salga al proveedor.
  const prematura = await pedir('POST', `/ordenes-compra/${id}/entregas`, {
    fecha: '2026-08-20',
    items: [{ item_id: 1, cantidad: 1 }],
  });
  c(prematura.estado === 400, 'no se registra una entrega antes de enviar la orden');

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
  c(
    Number(orden.falta_por_retirar) === 2407.5,
    `y todo sigue por retirar (dio ${orden.falta_por_retirar})`,
  );

  // -------------------------------------------------------- marcar enviada
  const enviada = await pedir('POST', `/ordenes-compra/${id}/marcar-enviada`);
  c(enviada.estado === 200, 'Martina la marca como enviada');
  c((await pedir('POST', `/ordenes-compra/${id}/marcar-enviada`)).estado === 400,
    'no se marca dos veces');
  orden = await ver();
  c(orden.estado_calculado === 'enviada', 'sin entregas, el estado que se ve es enviada');

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

  const renglones = orden.items as Renglon[];
  const cemento = renglones.find((r) => r.descripcion === 'Cemento')!;
  const arena = renglones.find((r) => r.descripcion === 'Arena')!;
  const aditivo = renglones.find((r) => r.descripcion === 'Aditivo')!;

  // ----------------------------------------------------------- entrega 1
  const deMas = await pedir('POST', `/ordenes-compra/${id}/entregas`, {
    fecha: '2026-09-01',
    items: [{ item_id: cemento.id, cantidad: 500 }],
  });
  c(deMas.estado === 400, 'no se puede recibir mas de lo pedido');

  const e1 = await pedir('POST', `/ordenes-compra/${id}/entregas`, {
    fecha: '2026-09-01',
    nota: 'Llego en dos camiones',
    items: [{ item_id: cemento.id, cantidad: 60 }, { item_id: arena.id, cantidad: 0 }],
  });
  c(e1.estado === 201, `la primera entrega responde 201 (dio ${e1.estado})`);
  c(Number(e1.cuerpo?.data?.monto_total) === 642, `entrega de 642.00 (dio ${e1.cuerpo?.data?.monto_total})`);
  c(
    String(e1.cuerpo?.data?.vence).startsWith('2026-10-01'),
    `vence 30 dias despues de la entrega (dio ${e1.cuerpo?.data?.vence})`,
  );

  orden = await ver();
  c(orden.estado === 'enviada', 'en la base el estado guardado sigue siendo enviada');
  c(orden.estado_calculado === 'entrega_parcial', `y el que se ve es entrega_parcial (dio ${orden.estado_calculado})`);
  c(Number(orden.recibido) === 642, 'recibido 642.00');
  c(Number(orden.por_pagar) === 642, 'y se deben esos 642.00');
  c(Number(orden.falta_por_retirar) === 1765.5, 'faltan 1765.50 por retirar');
  c(
    Number((orden.items as Renglon[]).find((r) => r.id === cemento.id)!.recibido_cantidad) === 60,
    'el renglon sabe que llegaron 60',
  );

  // ------------------------------------------------------- activar el pago
  const pagoDeMas = await pedir('POST', `/ordenes-compra/${id}/activar-pago`, {
    entregas: [{ entrega_id: e1.cuerpo.data.id, monto: 1000 }],
  });
  c(pagoDeMas.estado === 400, 'no se activa un pago mayor que lo recibido');

  const pago1 = await pedir('POST', `/ordenes-compra/${id}/activar-pago`, {
    entregas: [{ entrega_id: e1.cuerpo.data.id, monto: 300 }],
  });
  c(pago1.estado === 201, `activar un pago parcial responde 201 (dio ${pago1.estado})`);
  const solicitudId = pago1.cuerpo?.data?.id as number;

  orden = await ver();
  c(Number(orden.disponible_para_activar) === 342, `quedan 342.00 por reclamar (dio ${orden.disponible_para_activar})`);
  c(Number(orden.por_pagar) === 642, 'pero la deuda con el proveedor sigue en 642.00');

  const pidiendoDosVeces = await pedir('POST', `/ordenes-compra/${id}/activar-pago`, {
    entregas: [{ entrega_id: e1.cuerpo.data.id, monto: 400 }],
  });
  c(pidiendoDosVeces.estado === 400, 'no se puede pedir dos veces la misma plata');

  // El pago se marca pagado como lo haria la pantalla de solicitudes.
  await query("UPDATE solicitudes_pago SET estado = 'pagada' WHERE id = $1", [solicitudId]);
  orden = await ver();
  c(Number(orden.pagado) === 300, `pagado 300.00 (dio ${orden.pagado})`);
  c(Number(orden.por_pagar) === 342, `por pagar 342.00 (dio ${orden.por_pagar})`);

  // Control de costos: lo recibido y sin pagar es COSTO, aunque la plata no haya
  // salido. Aqui el proyecto lleva 642.00 recibidos, de los que 300.00 ya se
  // pagaron: 300 pagado + 342 por pagar = 642 de costo.
  const costos = await pedir('GET', '/costs/projects/' + P + '/resumen');
  c(costos.estado === 200, `el resumen de costos responde 200 (dio ${costos.estado})`);
  c(Number(costos.cuerpo?.data?.gastado) === 300, `pagado 300.00 (dio ${costos.cuerpo?.data?.gastado})`);
  c(
    Number(costos.cuerpo?.data?.porPagar) === 342,
    `por pagar 342.00 (dio ${costos.cuerpo?.data?.porPagar})`,
  );
  c(
    Number(costos.cuerpo?.data?.costoHastaHoy) === 642,
    `y el costo hasta hoy son los 642.00 que llegaron (dio ${costos.cuerpo?.data?.costoHastaHoy})`,
  );

  // Una solicitud rechazada suelta la plata que tenia reservada.
  const pago2 = await pedir('POST', `/ordenes-compra/${id}/activar-pago`, {
    entregas: [{ entrega_id: e1.cuerpo.data.id, monto: 342 }],
  });
  c(pago2.estado === 201, 'se activa el resto de la entrega');
  c(Number((await ver()).disponible_para_activar) === 0, 'y ya no queda nada por reclamar');
  await query("UPDATE solicitudes_pago SET estado = 'rechazada' WHERE id = $1", [
    pago2.cuerpo.data.id,
  ]);
  c(
    Number((await ver()).disponible_para_activar) === 342,
    'al rechazarse la solicitud, sus 342.00 vuelven a estar disponibles',
  );

  // ----------------------------------------------------------- entrega 2
  const e2 = await pedir('POST', `/ordenes-compra/${id}/entregas`, {
    fecha: '2026-09-20',
    items: [
      { item_id: cemento.id, cantidad: 40 },
      { item_id: arena.id, cantidad: 20 },
      { item_id: aditivo.id, cantidad: 10 },
    ],
  });
  c(e2.estado === 201, 'la segunda entrega responde 201');
  c(Number(e2.cuerpo?.data?.monto_total) === 1765.5, `entrega de 1765.50 (dio ${e2.cuerpo?.data?.monto_total})`);
  orden = await ver();
  c(orden.estado_calculado === 'recibida', `con todo adentro el estado que se ve es recibida (dio ${orden.estado_calculado})`);
  c(Number(orden.recibido) === 2407.5, 'recibido = el total de la orden');
  c(Number(orden.falta_por_retirar) === 0, 'y no falta nada por retirar');

  const yaNoQueda = await pedir('POST', `/ordenes-compra/${id}/entregas`, {
    fecha: '2026-09-25',
    items: [{ item_id: cemento.id, cantidad: 1 }],
  });
  c(yaNoQueda.estado === 400, 'no se recibe nada mas de un renglon completo');

  // --------------------------------------------------- editar ya enviada
  const sinMotivo = await pedir('PUT', `/ordenes-compra/${id}`, { termino_dias: 45 });
  c(sinMotivo.estado === 400, 'una orden enviada no se edita sin motivo');

  const noAdmin = await pedir(
    'PUT',
    `/ordenes-compra/${id}`,
    { termino_dias: 45, motivo: 'probando' },
    firmar(otros[0]),
  );
  c(noAdmin.estado === 403, 'y solo la edita un administrador');

  const bajando = await pedir('PUT', `/ordenes-compra/${id}`, {
    motivo: 'bajando de mas',
    items: [
      { id: cemento.id, cantidad: 50, unidad: 'saco', descripcion: 'Cemento', precio_unitario: 10 },
      { id: arena.id, cantidad: 20, unidad: 'm3', descripcion: 'Arena', precio_unitario: 50 },
      { id: aditivo.id, cantidad: 10, unidad: 'unidad', descripcion: 'Aditivo', precio_unitario: 25 },
    ],
  });
  c(bajando.estado === 400, 'no se baja un renglon por debajo de lo ya recibido');

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
  c(
    String(orden.entregas[0].vence).startsWith('2026-10-01'),
    'y la entrega vieja NO cambia de vencimiento',
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
  const tres = await pedir('POST', '/ordenes-compra', ORDEN_NUEVA);
  const id3 = tres.cuerpo.data.id as number;
  await pedir('POST', `/ordenes-compra/${id3}/aprobar`, conClave, firmar(otros[0]));
  await pedir('POST', `/ordenes-compra/${id3}/aprobar`, conClave, firmar(otros[1]));
  await pedir('POST', `/ordenes-compra/${id3}/marcar-enviada`);
  const renglones3 = ((await pedir('GET', `/ordenes-compra/${id3}`)).cuerpo.data.items) as Renglon[];
  const e3 = await pedir('POST', `/ordenes-compra/${id3}/entregas`, {
    fecha: '2026-09-10',
    items: [{ item_id: renglones3[0].id, cantidad: 10 }],
  });
  c(e3.estado === 201, 'la orden que se va a dar de baja recibio algo');

  c((await pedir('POST', `/ordenes-compra/${id3}/baja`, {})).estado === 400,
    'dar de baja exige motivo');
  const baja = await pedir('POST', `/ordenes-compra/${id3}/baja`, {
    motivo: 'El proveedor no volvio a despachar',
  });
  c(baja.estado === 200, 'dar de baja responde 200');

  const tras = (await pedir('GET', `/ordenes-compra/${id3}`)).cuerpo.data;
  c(tras.estado === 'dada_de_baja', 'la orden queda dada de baja');
  c(Number(tras.por_pagar) === 107, `y lo que llego se sigue debiendo (dio ${tras.por_pagar})`);
  c(
    (await pedir('POST', `/ordenes-compra/${id3}/entregas`, {
      fecha: '2026-09-30',
      items: [{ item_id: renglones3[0].id, cantidad: 1 }],
    })).estado === 400,
    'no admite mas entregas',
  );
  const pagoTrasBaja = await pedir('POST', `/ordenes-compra/${id3}/activar-pago`, {
    entregas: [{ entrega_id: e3.cuerpo.data.id, monto: 107 }],
  });
  c(pagoTrasBaja.estado === 201, 'pero SI se puede pagar lo que llego antes de la baja');

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
  // «ordenes_entregas» se mira pero no se registra lo que llego; y ninguna de
  // las dos alcanza un proyecto al que la persona no tiene acceso.
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
    (await pedir('POST', `/ordenes-compra/${id}/entregas`, {
      fecha: '2026-09-22',
      items: [{ item_id: cemento.id, cantidad: 1 }],
    }, firmar(sinLlaves))).estado === 403,
    'pero registrar una entrega necesita su propia llave',
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
  // en blanco el resto —la regla del CLAUDE.md, que aqui se comprueba.
  const antes = await ver();
  const soloCondiciones = await pedir('PUT', `/ordenes-compra/${id}`, {
    condiciones: 'Nueva condicion',
    motivo: 'Probando que no borre lo demas',
  });
  c(soloCondiciones.estado === 200, 'editar un solo campo responde 200');
  const despues = await ver();
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
  // La cotizacion va sobre la orden; el vale de entrega, sobre SU entrega.
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
  const vale = await subir('vale.pdf', 'Vale firmado en obra', e1.cuerpo.data.id);
  c(vale.estado === 201, 'subir el vale de una entrega responde 201');

  const conAdjuntos = await ver();
  c(conAdjuntos.adjuntos.length === 1, 'la orden tiene su cotizacion');
  c(
    conAdjuntos.entregas.find((x) => x.id === e1.cuerpo.data.id)?.adjuntos?.length === 1,
    'y la entrega, su vale',
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
  for (const a of ['crear', 'aprobar', 'rechazar', 'enviar', 'entrega', 'editar', 'dar_de_baja']) {
    c(acciones.has(a), `queda rastro de «${a}»`);
  }

  console.log(`${ok} pasaron, ${fallo} fallaron`);
  await pool.end();
  process.exit(fallo ? 1 : 0);
};

main();
