// Prueba de humo: pagos parciales (tema 19, migración 191).
// cd andrei-backend && npm run pruebas -- pagos-parciales
//
// Ivan, 2026-11-17/18: una solicitud regular se puede pagar en partes. Cada pago
// lleva su monto y su comprobante. Se exige:
// - un pago parcial deja la solicitud «abonada», con lo pagado y el saldo bien;
// - un monto mayor que el saldo, raro, en cero o sin comprobante no escribe nada;
// - el pago total (sin monto) paga el saldo y la deja pagada; los centavos
//   cuadran (33.33 + 33.33 + 33.34 = 100.00);
// - la factura se registra una vez mientras está abonada y la etiqueta sigue
//   «abonada»; el pago que salda la pasa a facturada, aunque los dos lleguen a
//   la vez; una pagada con su factura queda facturada, como siempre;
// - dos pagos al mismo tiempo no pasan del saldo: uno entra y el otro no;
// - una de caja menuda se paga completa, como siempre;
// - quien no tiene «registrar pago» no paga; una abonada no se borra ni se
//   marca «Pinellas paga»;
// - el reembolso a Pinellas y la devolución del proveedor siguen como siempre,
//   solo con la solicitud pagada completa: una abonada no los recibe.
import { API } from './pruebas/contexto.js';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import zlib from 'zlib';
import { query, pool } from '../src/database/config.js';
import { deleteFile, downloadFile } from '../src/services/storage.js';

/**
 * El texto de un PDF hecho con PDFKit, una línea por renglón: descomprime cada
 * stream y junta lo que dicen sus TJ. PDFKit escribe Helvetica en WinAnsi, así
 * que cada byte es su letra; 0x97 es la raya «—».
 */
function textoDelPdf(pdf: Buffer): string {
  const bin = pdf.toString('latin1');
  const lineas: string[] = [];
  for (const m of bin.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    let contenido: string;
    try {
      contenido = zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1');
    } catch {
      continue;
    }
    for (const tj of contenido.matchAll(/\[([^\]]*)\]\s*TJ/g)) {
      lineas.push(
        [...tj[1].matchAll(/<([0-9a-fA-F]+)>/g)]
          .map((h) => Buffer.from(h[1], 'hex').toString('latin1'))
          .join(''),
      );
    }
  }
  return lineas.join('\n').replace(/\x97/g, '—');
}

interface Usuario {
  id: number;
  email: string;
  rol: string;
}

const main = async () => {
  const admin = (
    await query<Usuario>("SELECT id, email, rol FROM users WHERE rol='admin' AND activo=true ORDER BY id LIMIT 1")
  ).rows[0];
  const sinPermiso = (
    await query<Usuario>("SELECT id, email, rol FROM users WHERE email = 'aprobador1@pruebas.local'")
  ).rows[0];
  const token = (u: Usuario) =>
    jwt.sign({ userId: u.id, email: u.email, rol: u.rol }, process.env.JWT_SECRET!, { expiresIn: '10m' });

  let ok = 0;
  let fallo = 0;
  const c = (cond: boolean, etq: string) => {
    if (cond) ok += 1;
    else {
      fallo += 1;
      console.log('FALLA ', etq);
    }
  };

  const pedir = async (metodo: string, ruta: string, quien: Usuario = admin, cuerpo?: unknown) => {
    const res = await fetch(`${API}${ruta}`, {
      method: metodo,
      headers: { Authorization: `Bearer ${token(quien)}`, 'Content-Type': 'application/json' },
      body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
    });
    return { estado: res.status, json: (await res.json()) as Record<string, unknown> };
  };

  /** POST /registrar-pago como lo manda la pantalla: multipart con fecha, monto y comprobante. */
  const pagar = async (
    id: number,
    campos: { monto?: string; fecha?: string; sinArchivo?: boolean },
    quien: Usuario = admin,
  ) => {
    const forma = new FormData();
    if (campos.fecha !== '') forma.append('fecha_pago', campos.fecha ?? '2026-11-18');
    if (campos.monto !== undefined) forma.append('monto', campos.monto);
    if (!campos.sinArchivo) {
      forma.append('archivos', new Blob(['%PDF-1.4 comprobante'], { type: 'application/pdf' }), 'transferencia.pdf');
    }
    const res = await fetch(`${API}/solicitudes-pago/${id}/registrar-pago`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token(quien)}` },
      body: forma,
    });
    return { estado: res.status, json: (await res.json()) as Record<string, unknown> };
  };

  /** POST /registrar-factura como lo manda la pantalla. */
  const facturar = async (id: number, quien: Usuario = admin) => {
    const forma = new FormData();
    forma.append('fecha_factura', '2026-11-19');
    forma.append('tipo', 'factura');
    forma.append('numero_factura', 'F-001');
    forma.append('archivos', new Blob(['%PDF-1.4 factura'], { type: 'application/pdf' }), 'factura.pdf');
    const res = await fetch(`${API}/solicitudes-pago/${id}/registrar-factura`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token(quien)}` },
      body: forma,
    });
    return { estado: res.status, json: (await res.json()) as Record<string, unknown> };
  };

  /** POST /reembolso (Pinellas paga) como lo manda la pantalla. */
  const reembolsar = async (id: number) => {
    const forma = new FormData();
    forma.append('fecha_reembolso', '2026-11-26');
    forma.append('comprobante', new Blob(['%PDF-1.4 reembolso'], { type: 'application/pdf' }), 'reembolso.pdf');
    const res = await fetch(`${API}/solicitudes-pago/${id}/reembolso`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token(admin)}` },
      body: forma,
    });
    return { estado: res.status, json: (await res.json()) as Record<string, unknown> };
  };

  /** POST /devolucion (el proveedor devolvió la plata) como lo manda la pantalla. */
  const devolver = async (id: number) => {
    const forma = new FormData();
    forma.append('fecha_devolucion', '2026-11-26');
    forma.append('motivo', 'El proveedor no tenía el material');
    forma.append('comprobante', new Blob(['%PDF-1.4 devolucion'], { type: 'application/pdf' }), 'devolucion.pdf');
    const res = await fetch(`${API}/solicitudes-pago/${id}/devolucion`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token(admin)}` },
      body: forma,
    });
    return { estado: res.status, json: (await res.json()) as Record<string, unknown> };
  };

  const creadas: number[] = [];
  const crear = async (numero: string, total: number, tipo = 'regular') => {
    const id = (
      await query<{ id: number }>(
        `INSERT INTO solicitudes_pago (proyecto_id, numero, fecha, proveedor, preparado_por, solicitado_por,
            subtotal, descuentos, impuestos, monto_total, estado, beneficiario, banco, tipo_cuenta, numero_cuenta,
            urgente, codigo_verificacion, pinellas_paga, tipo, activo)
         VALUES (1, $1, '2026-11-10', 'John Harold Carruido', $2, $2, $3, 0, 0, $3, 'aprobada',
                 'John Harold Carruido', 'CREDICORP BANK', 'corriente', '0000000000', false, $4, false, $5, true)
         RETURNING id`,
        [numero, admin.id, total, randomUUID().slice(0, 10).toUpperCase(), tipo],
      )
    ).rows[0].id;
    await query(
      `INSERT INTO solicitud_pago_items (solicitud_pago_id, cantidad, unidad, descripcion, precio_unitario, precio_total, orden)
       VALUES ($1, 1, 'global', 'Cuenta No. 3', $2, $2, 0)`,
      [id, total],
    );
    creadas.push(id);
    return id;
  };
  const leer = async (id: number) =>
    (
      await query<{ estado: string; pagado: string; saldo: string; pagos: number }>(
        `SELECT sp.estado, v.pagado::text, v.saldo::text, v.pagos
           FROM solicitudes_pago sp JOIN solicitud_pago_saldo v ON v.solicitud_pago_id = sp.id WHERE sp.id = $1`,
        [id],
      )
    ).rows[0];

  try {
    // ---- STAISA-155: 2,587.50 en dos pagos
    const s155 = await crear('PRU1-PP155', 2587.5);

    const primero = await pagar(s155, { monto: '1293.75' });
    c(primero.estado === 200, `el primer pago parcial entra (dio ${primero.estado} ${JSON.stringify(primero.json)})`);
    c(primero.json.estado === 'abonada' && primero.json.pagado === '1293.75' && primero.json.saldo === '1293.75',
      `la respuesta dice abonada, pagado 1293.75, saldo 1293.75 (dio ${JSON.stringify(primero.json)})`);
    let s = await leer(s155);
    c(s.estado === 'abonada' && s.pagado === '1293.75' && s.saldo === '1293.75' && s.pagos === 1,
      `queda abonada con 1,293.75 pagado (dio ${JSON.stringify(s)})`);
    const archivo = (
      await query<{ n: string }>(
        `SELECT count(*) AS n FROM solicitud_pago_adjuntos a JOIN comprobantes_pago cp ON cp.id = a.comprobante_pago_id
          WHERE a.solicitud_pago_id = $1 AND a.tipo_adjunto = 'comprobante' AND cp.monto = 1293.75`,
        [s155],
      )
    ).rows[0];
    c(Number(archivo.n) === 1, `el comprobante quedó con su pago (dio ${archivo.n})`);
    const rastro = await query(
      "SELECT detalles FROM audit_log WHERE accion = 'registrar_pago_parcial' AND entidad = 'solicitud_pago' AND entidad_id = $1",
      [s155],
    );
    c(rastro.rows.length === 1, `el pago parcial deja rastro (quedaron ${rastro.rows.length})`);

    // El PDF de la abonada lo dice, con lo pagado, el total y el saldo
    const pdfRes = await fetch(`${API}/solicitudes-pago/${s155}/pdf`, {
      headers: { Authorization: `Bearer ${token(admin)}` },
    });
    const pdfAbonada = textoDelPdf(Buffer.from(await pdfRes.arrayBuffer()));
    c(pdfRes.status === 200 &&
      pdfAbonada.includes('Solicitud abonada — pagado B/. 1,293.75 de B/. 2,587.50, saldo B/. 1,293.75') &&
      pdfAbonada.includes('Fecha de pago: 18/nov/2026  —  B/. 1,293.75') &&
      pdfAbonada.includes('Pagado: B/. 1,293.75 de B/. 2,587.50  —  Saldo: B/. 1,293.75'),
      `el PDF dice «abonada» con pagado, total y saldo, y el pago en su línea (dio ${pdfRes.status}: ${pdfAbonada.split('\n').filter((l) => /abonada|Pagado|Fecha de pago/.test(l)).join(' | ')})`);

    const detalle = await pedir('GET', `/solicitudes-pago/${s155}`);
    const sol = detalle.json.solicitud as { pagado?: string; saldo?: string };
    c(detalle.estado === 200 && sol?.pagado === '1293.75' && sol?.saldo === '1293.75',
      `el detalle trae pagado y saldo (dio ${detalle.estado} ${sol?.pagado} ${sol?.saldo})`);

    // Lo que no debe escribir nada.
    const pasa = await pagar(s155, { monto: '1293.76' });
    c(pasa.estado === 400 && String(pasa.json.message).includes('1,293.75'),
      `un centavo más que el saldo no entra y dice el saldo (dio ${pasa.estado} ${pasa.json.message})`);
    for (const malo of ['abc', '0', '0.00', '-5', '12.345', '1,000']) {
      const r = await pagar(s155, { monto: malo });
      c(r.estado === 400, `el monto «${malo}» no entra (dio ${r.estado})`);
    }
    const sinArchivo = await pagar(s155, { monto: '10', sinArchivo: true });
    c(sinArchivo.estado === 400, `sin comprobante no entra (dio ${sinArchivo.estado})`);
    const sinFecha = await pagar(s155, { monto: '10', fecha: '' });
    c(sinFecha.estado === 400, `sin fecha no entra (dio ${sinFecha.estado})`);
    // Ve la solicitud (el proyecto y «Ver solicitudes de pago»), pero no tiene
    // «Registrar pagos y facturas».
    await query('INSERT INTO user_project_access (user_id, proyecto_id) VALUES ($1, 1) ON CONFLICT DO NOTHING', [sinPermiso.id]);
    await query(
      `INSERT INTO user_permissions (user_id, solicitudes_ver, registrar_pago) VALUES ($1, true, false)
       ON CONFLICT (user_id) DO UPDATE SET solicitudes_ver = true, registrar_pago = false`,
      [sinPermiso.id],
    );
    const ve = await pedir('GET', `/solicitudes-pago/${s155}`, sinPermiso);
    c(ve.estado === 200, `esa persona sí ve la solicitud (dio ${ve.estado})`);
    const ajeno = await pagar(s155, { monto: '10' }, sinPermiso);
    c(ajeno.estado === 403, `quien no tiene «registrar pago» no paga (dio ${ajeno.estado})`);
    s = await leer(s155);
    c(s.pagos === 1 && s.pagado === '1293.75', `nada de eso escribió un pago (dio ${JSON.stringify(s)})`);

    const borrar = await pedir('DELETE', `/solicitudes-pago/${s155}`);
    c(borrar.estado === 400, `una abonada no se borra, ni el admin (dio ${borrar.estado})`);
    const pinellas = await pedir('PATCH', `/solicitudes-pago/${s155}/pinellas-paga`, admin, { pinellas_paga: true });
    c(pinellas.estado === 400, `una abonada no se marca «Pinellas paga» (dio ${pinellas.estado})`);

    const segundo = await pagar(s155, { fecha: '2026-11-25' });
    c(segundo.estado === 200 && segundo.json.estado === 'pagada',
      `el pago total paga el saldo y la deja pagada (dio ${segundo.estado} ${JSON.stringify(segundo.json)})`);
    s = await leer(s155);
    c(s.estado === 'pagada' && s.pagado === '2587.50' && s.saldo === '0.00' && s.pagos === 2,
      `pagada con 2,587.50 en dos pagos (dio ${JSON.stringify(s)})`);
    // La copia archivada al saldar se arma DENTRO del pago: ya dice pagada y
    // trae el último pago, que aún no estaba guardado cuando se armó.
    const archivada = textoDelPdf(await downloadFile('PRUEBAS1/solicitudes/PRU1-PP155.pdf'));
    c(archivada.includes('Solicitud aprobada y pagada — pendiente registro de factura') &&
      archivada.includes('Fecha de pago: 18/nov/2026  —  B/. 1,293.75') &&
      archivada.includes('Fecha de pago: 25/nov/2026  —  B/. 1,293.75') &&
      !archivada.includes('Saldo:'),
      `el PDF archivado dice pagada y trae los dos pagos (dio: ${archivada.split('\n').filter((l) => /Solicitud|Fecha de pago|Saldo/.test(l)).join(' | ')})`);
    const otraVez = await pagar(s155, {});
    c(otraVez.estado === 400, `una pagada no se paga otra vez (dio ${otraVez.estado})`);

    // ---- centavos: 33.33 + 33.33 + el resto = 100.00, pagada
    const cien = await crear('PRU1-PP100', 100);
    await pagar(cien, { monto: '33.33' });
    await pagar(cien, { monto: '33.33' });
    const resto = await pagar(cien, { monto: '33.34' });
    s = await leer(cien);
    c(resto.estado === 200 && s.estado === 'pagada' && s.saldo === '0.00',
      `33.33 + 33.33 + 33.34 la deja pagada, saldo 0.00 (dio ${resto.estado} ${JSON.stringify(s)})`);

    // Una pagada que recibe su factura queda facturada, como siempre.
    const facturaDePagada = await facturar(s155);
    s = await leer(s155);
    c(facturaDePagada.estado === 200 && s.estado === 'facturada',
      `una pagada con su factura queda facturada, como siempre (dio ${facturaDePagada.estado} ${s.estado})`);

    // ---- la factura a mitad de los pagos: sigue abonada; el último pago la deja facturada
    const conFactura = await crear('PRU1-PPFAC', 500);
    const sinPagos = await facturar(conFactura);
    c(sinPagos.estado === 400, `sin ningún pago no se registra factura (dio ${sinPagos.estado})`);
    await pagar(conFactura, { monto: '200' });
    const ajenoFactura = await facturar(conFactura, sinPermiso);
    c(ajenoFactura.estado === 403, `quien no tiene «registrar pago» no registra la factura (dio ${ajenoFactura.estado})`);
    const facturaAbonada = await facturar(conFactura);
    s = await leer(conFactura);
    c(facturaAbonada.estado === 200 && facturaAbonada.json.estado === 'abonada' && s.estado === 'abonada',
      `una abonada recibe la factura y sigue abonada (dio ${facturaAbonada.estado} ${JSON.stringify(facturaAbonada.json)} ${s.estado})`);
    const detalleFactura = await pedir('GET', `/solicitudes-pago/${conFactura}`);
    const fac = detalleFactura.json.factura as { numero_factura?: string; adjuntos?: unknown[] } | null;
    c(fac?.numero_factura === 'F-001' && fac?.adjuntos?.length === 1,
      `el detalle de la abonada muestra su factura con el archivo (dio ${JSON.stringify(fac)})`);
    const facturaOtraVez = await facturar(conFactura);
    c(facturaOtraVez.estado === 400, `una abonada no recibe una segunda factura (dio ${facturaOtraVez.estado})`);
    const ultimo = await pagar(conFactura, {});
    c(ultimo.estado === 200 && ultimo.json.estado === 'facturada',
      `con la factura ya registrada, el último pago la deja facturada (dio ${ultimo.estado} ${ultimo.json.estado})`);

    // ---- la factura y el último pago al mismo tiempo: termina facturada, llegue primero el que llegue
    const cruce = await crear('PRU1-PPCRUCE', 300);
    await pagar(cruce, { monto: '100' });
    const [f, p] = await Promise.all([facturar(cruce), pagar(cruce, {})]);
    s = await leer(cruce);
    c(f.estado === 200 && p.estado === 200 && s.estado === 'facturada' && s.saldo === '0.00',
      `factura y último pago a la vez la dejan facturada (dieron ${f.estado} ${p.estado}, quedó ${JSON.stringify(s)})`);

    // ---- dos pagos al mismo tiempo: 600 + 600 sobre 1,000 — uno entra, el otro no
    const mil = await crear('PRU1-PP1000', 1000);
    const [a, b] = await Promise.all([pagar(mil, { monto: '600' }), pagar(mil, { monto: '600' })]);
    const estados = [a.estado, b.estado].sort();
    s = await leer(mil);
    c(estados[0] === 200 && estados[1] === 400 && s.pagado === '600.00' && s.pagos === 1,
      `al mismo tiempo, uno entra y el otro no (dieron ${estados}, quedó ${JSON.stringify(s)})`);

    // ---- reembolso a Pinellas y devolución del proveedor: como siempre, solo pagada completa
    const pin = await crear('PRU1-PPPIN', 600);
    await query('UPDATE solicitudes_pago SET pinellas_paga = true WHERE id = $1', [pin]);
    await pagar(pin, { monto: '200' });
    const reembolsoAbonada = await reembolsar(pin);
    c(reembolsoAbonada.estado === 400,
      `una abonada no recibe el reembolso a Pinellas (dio ${reembolsoAbonada.estado} ${JSON.stringify(reembolsoAbonada.json)})`);
    await pagar(pin, {});
    const reembolsoPagada = await reembolsar(pin);
    const reembolsos = await query('SELECT 1 FROM reembolsos_pinellas WHERE solicitud_pago_id = $1', [pin]);
    c(reembolsoPagada.estado === 200 && reembolsos.rows.length === 1,
      `pagada completa, el reembolso a Pinellas entra como siempre (dio ${reembolsoPagada.estado} ${JSON.stringify(reembolsoPagada.json)})`);

    const dev = await crear('PRU1-PPDEV', 300);
    await pagar(dev, { monto: '100' });
    const devolucionAbonada = await devolver(dev);
    s = await leer(dev);
    c(devolucionAbonada.estado === 400 && s.estado === 'abonada',
      `una abonada no registra devolución del proveedor (dio ${devolucionAbonada.estado} ${s.estado})`);
    await pagar(dev, {});
    const devolucionPagada = await devolver(dev);
    s = await leer(dev);
    const enCostos = await query('SELECT 1 FROM solicitud_pago_gasto WHERE solicitud_pago_id = $1', [dev]);
    c(devolucionPagada.estado === 200 && s.estado === 'devolucion' && enCostos.rows.length === 0,
      `pagada completa, la devolución entra como siempre y deja de contar como gasto (dio ${devolucionPagada.estado} ${s.estado})`);

    // ---- caja menuda: se paga completa, como siempre
    const caja = await crear('PRU1-PPCAJA', 80, 'reembolso');
    const cajaParcial = await pagar(caja, { monto: '40' });
    c(cajaParcial.estado === 400, `un reembolso de caja menuda no se paga en partes (dio ${cajaParcial.estado})`);
    const cajaTotal = await pagar(caja, {});
    s = await leer(caja);
    c(cajaTotal.estado === 200 && s.estado === 'reembolsada' && s.saldo === '0.00',
      `y completo queda reembolsado, como siempre (dio ${cajaTotal.estado} ${JSON.stringify(s)})`);
  } finally {
    // Los comprobantes van a solicitudes-pago/<id>/comprobantes/, fuera de los
    // prefijos que barre el corredor (ese prefijo lo usa también la copia
    // local): se borran aquí, uno por uno, solo los de esta prueba. Igual los
    // del reembolso a Pinellas (reembolsos/<id>/) y la devolución (devoluciones/<id>/).
    const archivos = await query<{ r2_key: string }>(
      `SELECT r2_key FROM solicitud_pago_adjuntos WHERE solicitud_pago_id = ANY($1::int[])
       UNION ALL SELECT comprobante_url FROM reembolsos_pinellas WHERE solicitud_pago_id = ANY($1::int[]) AND comprobante_url IS NOT NULL
       UNION ALL SELECT comprobante_url FROM devoluciones_solicitud WHERE solicitud_pago_id = ANY($1::int[])`,
      [creadas],
    );
    for (const { r2_key } of archivos.rows) {
      try {
        await deleteFile(r2_key);
      } catch (e) {
        console.log('no se pudo borrar', r2_key, (e as Error).message);
      }
    }
  }

  console.log(`${ok} pasaron, ${fallo} fallaron`);
  await pool.end();
  // Sin process.exit: ver aprobar-clave-humo.ts.
  process.exitCode = fallo ? 1 : 0;
};

main();
