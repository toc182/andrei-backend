// Prueba de humo: corregir y anular pagos (tema 19, paso 5; migración 191).
// cd andrei-backend && npm run pruebas -- pagos-correccion
//
// Ivan, 2026-11-18: un pago mal registrado lo corrige o lo anula un admin, con
// un motivo, y queda en el historial. Va por la misma «Corregir solicitud» de
// siempre (POST /:id/corregir), que ahora trae los pagos uno por uno. Se exige:
// - corregir el monto o la fecha de un pago cambia lo pagado y el saldo, y el
//   estado sigue al dinero (abonada, pagada, facturada);
// - anular un pago lo deja en la base (activo = false, quién, cuándo, motivo)
//   y deja de contar; anulados todos, la solicitud vuelve a «Por pagar», con
//   su factura si la tenía, y se puede volver a pagar;
// - corregir el total de una pagada completa mueve el ÚLTIMO pago por la
//   diferencia y sigue pagada, como hoy; si no alcanza, no se escribe nada;
// - lo pagado nunca pasa del total; con el reembolso a Pinellas registrado no
//   puede quedar saldo;
// - reemplazar el comprobante toca solo los archivos de ese pago;
// - cada corrección deja su línea en el historial, con el cambio de estado;
// - solo un admin corrige; sin motivo, con un pago ajeno o con la ventana de
//   antes (fecha_pago / archivos_comprobante) no se escribe nada.
import { API } from './pruebas/contexto.js';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { query, pool } from '../src/database/config.js';
import { deleteFile } from '../src/services/storage.js';

interface Usuario {
  id: number;
  email: string;
  rol: string;
}

interface PagoFila {
  id: number;
  fecha_pago: string;
  monto: string;
  activo: boolean;
  anulado_por: number | null;
  anulado_at: string | null;
  motivo_anulacion: string | null;
}

interface Cambio {
  campo: string;
  anterior?: string;
  nuevo?: string;
  descripcion?: string;
  pago_id?: number;
  cambios?: { campo: string; anterior: string; nuevo: string }[];
}

const main = async () => {
  const admin = (
    await query<Usuario>("SELECT id, email, rol FROM users WHERE rol='admin' AND activo=true ORDER BY id LIMIT 1")
  ).rows[0];
  // Gerencia (co-admin) ve todas las solicitudes, pero corregir es solo del admin.
  const otro = (
    await query<Usuario>(
      `INSERT INTO users (nombre, email, rol, activo)
       VALUES ('Gerencia de pruebas', 'gerencia-correccion@pruebas.local', 'co-admin', true)
       RETURNING id, email, rol`,
    )
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

  const pedir = async (metodo: string, ruta: string, quien: Usuario = admin) => {
    const res = await fetch(`${API}${ruta}`, {
      method: metodo,
      headers: { Authorization: `Bearer ${token(quien)}` },
    });
    return { estado: res.status, json: (await res.json()) as Record<string, unknown> };
  };

  const pdf = (nombre: string) => new Blob([`%PDF-1.4 ${nombre}`], { type: 'application/pdf' });

  const pagar = async (id: number, monto?: string, fecha = '2026-11-18') => {
    const forma = new FormData();
    forma.append('fecha_pago', fecha);
    if (monto !== undefined) forma.append('monto', monto);
    forma.append('archivos', pdf('transferencia'), 'transferencia.pdf');
    const res = await fetch(`${API}/solicitudes-pago/${id}/registrar-pago`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token(admin)}` },
      body: forma,
    });
    return { estado: res.status, json: (await res.json()) as Record<string, unknown> };
  };

  const facturar = async (id: number) => {
    const forma = new FormData();
    forma.append('fecha_factura', '2026-11-19');
    forma.append('tipo', 'factura');
    forma.append('numero_factura', 'F-009');
    forma.append('archivos', pdf('factura'), 'factura.pdf');
    const res = await fetch(`${API}/solicitudes-pago/${id}/registrar-factura`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token(admin)}` },
      body: forma,
    });
    return res.status;
  };

  /**
   * POST /corregir como lo manda la ventana «Corregir solicitud»: parte de lo
   * que trae el detalle (renglones, updated_at) y le cambia solo lo pedido.
   */
  const corregir = async (
    id: number,
    o: {
      motivo?: string;
      pagos?: Record<string, unknown>[];
      total?: number;
      archivos?: Record<string, string[]>;
      extra?: Record<string, string>;
      updatedAt?: string;
      quien?: Usuario;
    } = {},
  ) => {
    const det = await pedir('GET', `/solicitudes-pago/${id}`);
    const sol = det.json.solicitud as { updated_at: string };
    const items = det.json.items as { id: number; descripcion: string; cantidad: string; unidad: string; precio_unitario: string }[];
    const forma = new FormData();
    if (o.motivo !== '') forma.append('motivo', o.motivo ?? 'Martina escribió mal el pago');
    forma.append('updated_at', o.updatedAt ?? sol.updated_at);
    forma.append(
      'items',
      JSON.stringify(
        items.map((it) => ({
          id: it.id,
          descripcion: it.descripcion,
          cantidad: Number(it.cantidad),
          unidad: it.unidad,
          precio_unitario: o.total ?? Number(it.precio_unitario),
        })),
      ),
    );
    forma.append('ajustes', '[]');
    if (o.pagos) forma.append('pagos', JSON.stringify(o.pagos));
    for (const [campo, nombres] of Object.entries(o.archivos ?? {})) {
      for (const n of nombres) forma.append(campo, pdf(n), n);
    }
    for (const [k, v] of Object.entries(o.extra ?? {})) forma.append(k, v);
    const res = await fetch(`${API}/solicitudes-pago/${id}/corregir`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token(o.quien ?? admin)}` },
      body: forma,
    });
    return { estado: res.status, json: (await res.json()) as Record<string, unknown> };
  };

  const creadas: number[] = [];
  const crear = async (numero: string, total: number) => {
    const id = (
      await query<{ id: number }>(
        `INSERT INTO solicitudes_pago (proyecto_id, numero, fecha, proveedor, preparado_por, solicitado_por,
            subtotal, descuentos, impuestos, monto_total, estado, beneficiario, banco, tipo_cuenta, numero_cuenta,
            urgente, codigo_verificacion, pinellas_paga, tipo, activo)
         VALUES (1, $1, '2026-11-10', 'John Harold Carruido', $2, $2, $3, 0, 0, $3, 'aprobada',
                 'John Harold Carruido', 'CREDICORP BANK', 'corriente', '0000000000', false, $4, false, 'regular', true)
         RETURNING id`,
        [numero, admin.id, total, randomUUID().slice(0, 10).toUpperCase()],
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
      await query<{ estado: string; total: string; pagado: string; saldo: string; pagos: number }>(
        `SELECT sp.estado, sp.monto_total::text AS total, v.pagado::text, v.saldo::text, v.pagos
           FROM solicitudes_pago sp JOIN solicitud_pago_saldo v ON v.solicitud_pago_id = sp.id WHERE sp.id = $1`,
        [id],
      )
    ).rows[0];
  const pagosDe = async (id: number) =>
    (
      await query<PagoFila>(
        `SELECT id, to_char(fecha_pago, 'YYYY-MM-DD') AS fecha_pago, monto::text, activo, anulado_por,
                anulado_at::text, motivo_anulacion
           FROM comprobantes_pago WHERE solicitud_pago_id = $1 ORDER BY id`,
        [id],
      )
    ).rows;
  const ultimaCorreccion = async (id: number) =>
    (
      await query<{ motivo: string; cambios: Cambio[] }>(
        'SELECT motivo, cambios FROM correcciones_solicitud WHERE solicitud_pago_id = $1 ORDER BY id DESC LIMIT 1',
        [id],
      )
    ).rows[0];
  const correcciones = async (id: number) =>
    Number(
      (await query<{ n: string }>('SELECT count(*) AS n FROM correcciones_solicitud WHERE solicitud_pago_id = $1', [id]))
        .rows[0].n,
    );
  const archivosDe = async (pagoId: number) =>
    (
      await query<{ nombre_original: string }>(
        `SELECT nombre_original FROM solicitud_pago_adjuntos
          WHERE comprobante_pago_id = $1 AND tipo_adjunto = 'comprobante' ORDER BY id`,
        [pagoId],
      )
    ).rows.map((r) => r.nombre_original);

  try {
    // ---- STAISA-155: abonada con 1,293.75 de 2,587.50
    const s155 = await crear('PRU1-PC155', 2587.5);
    await pagar(s155, '1293.75');
    const [p155] = await pagosDe(s155);

    // Corregir el monto del pago
    let r = await corregir(s155, { pagos: [{ id: p155.id, monto: '1000.00' }] });
    let s = await leer(s155);
    c(r.estado === 200 && s.estado === 'abonada' && s.pagado === '1000.00' && s.saldo === '1587.50',
      `corregir el monto a 1,000: abonada, saldo 1,587.50 (dio ${r.estado} ${JSON.stringify(r.json)} ${JSON.stringify(s)})`);
    c(r.json.estado === 'abonada' && r.json.pagado === '1000.00' && r.json.saldo === '1587.50',
      `la respuesta trae estado, pagado y saldo (dio ${JSON.stringify(r.json)})`);
    let corr = await ultimaCorreccion(s155);
    const cambioMonto = corr?.cambios.find((x) => x.campo === 'pago' && x.pago_id === p155.id);
    c(corr?.motivo === 'Martina escribió mal el pago' &&
      cambioMonto?.descripcion === 'Pago del 18/nov/2026' &&
      cambioMonto?.cambios?.some((x) => x.campo === 'monto' && x.anterior === '1293.75' && x.nuevo === '1000.00') === true,
      `el historial dice «Pago del 18/nov/2026 — monto 1293.75 → 1000.00» con el motivo (dio ${JSON.stringify(corr)})`);

    // Corregir la fecha del pago
    r = await corregir(s155, { pagos: [{ id: p155.id, fecha_pago: '2026-11-17' }] });
    let pagos = await pagosDe(s155);
    corr = await ultimaCorreccion(s155);
    c(r.estado === 200 && pagos[0].fecha_pago === '2026-11-17' && pagos[0].monto === '1000.00',
      `corregir la fecha la cambia y no toca el monto (dio ${r.estado} ${JSON.stringify(pagos)})`);
    c(corr.cambios.some((x) => x.campo === 'pago' &&
      x.cambios?.some((y) => y.campo === 'fecha_pago' && y.anterior === '2026-11-18' && y.nuevo === '2026-11-17')),
      `el historial anota la fecha de antes y la nueva (dio ${JSON.stringify(corr.cambios)})`);

    // Lo que no se acepta: nada se escribe
    const antes = await correcciones(s155);
    r = await corregir(s155, { pagos: [{ id: p155.id, monto: '2600.00' }] });
    c(r.estado === 400, `un pago que pasa del total: 400 (dio ${r.estado})`);
    r = await corregir(s155, { pagos: [{ id: p155.id, monto: '0' }] });
    c(r.estado === 400, `un monto en cero: 400 (dio ${r.estado})`);
    r = await corregir(s155, { pagos: [{ id: p155.id, monto: 'mil' }] });
    c(r.estado === 400, `un monto que no es número: 400 (dio ${r.estado})`);
    r = await corregir(s155, { pagos: [{ id: p155.id, fecha_pago: '2026-02-30' }] });
    c(r.estado === 400, `una fecha imposible: 400 (dio ${r.estado})`);
    r = await corregir(s155, { motivo: '', pagos: [{ id: p155.id, monto: '900.00' }] });
    c(r.estado === 400, `sin motivo: 400 (dio ${r.estado})`);
    r = await corregir(s155, { quien: otro, pagos: [{ id: p155.id, monto: '900.00' }] });
    c(r.estado === 403, `Gerencia (co-admin) no corrige: 403 (dio ${r.estado})`);
    r = await corregir(s155, { extra: { fecha_pago: '2026-11-16' } });
    c(r.estado === 400, `la ventana de antes (fecha_pago suelta) no escribe: 400 (dio ${r.estado})`);
    r = await corregir(s155, { archivos: { archivos_comprobante: ['viejo.pdf'] } });
    c(r.estado === 400, `la ventana de antes (archivos_comprobante) no escribe: 400 (dio ${r.estado})`);
    r = await corregir(s155, { pagos: [{ id: p155.id, anular: true, monto: '900.00' }] });
    c(r.estado === 400, `anular y corregir el mismo pago a la vez: 400 (dio ${r.estado})`);
    r = await corregir(s155, { pagos: [{ id: p155.id, monto: '900.00' }], updatedAt: '2026-01-01T00:00:00.000Z' });
    c(r.estado === 409, `con la ventana vieja (otro cambió la solicitud): 409 (dio ${r.estado})`);
    s = await leer(s155);
    c(s.pagado === '1000.00' && (await correcciones(s155)) === antes,
      `nada de lo rechazado escribió (dio ${JSON.stringify(s)}, ${await correcciones(s155)} correcciones)`);

    // Un pago de OTRA solicitud no se toca desde esta
    const ajena = await crear('PRU1-PCAJENA', 500);
    await pagar(ajena, '100');
    const [pAjeno] = await pagosDe(ajena);
    r = await corregir(s155, { pagos: [{ id: pAjeno.id, monto: '50.00' }] });
    c(r.estado === 400 && (await pagosDe(ajena))[0].monto === '100.00',
      `un pago de otra solicitud: 400 y no se toca (dio ${r.estado})`);

    // Reemplazar el comprobante de un pago toca solo los archivos de ese pago
    await pagar(s155, '500', '2026-11-19');
    pagos = await pagosDe(s155);
    const [primero, segundo] = pagos;
    r = await corregir(s155, { archivos: { [`archivos_pago_${segundo.id}`]: ['transferencia-buena.pdf'] } });
    c(r.estado === 200 &&
      JSON.stringify(await archivosDe(segundo.id)) === JSON.stringify(['transferencia-buena.pdf']) &&
      JSON.stringify(await archivosDe(primero.id)) === JSON.stringify(['transferencia.pdf']),
      `el comprobante nuevo queda en su pago y el otro pago no cambia (dio ${r.estado} ${JSON.stringify(r.json)})`);
    corr = await ultimaCorreccion(s155);
    c(corr.cambios.some((x) => x.campo === 'comprobante' && x.pago_id === segundo.id && x.nuevo === 'transferencia-buena.pdf'),
      `el historial dice de qué pago es el comprobante nuevo (dio ${JSON.stringify(corr.cambios)})`);

    // Anular un pago: queda en la base y deja de contar
    r = await corregir(s155, { motivo: 'El banco rechazó la transferencia', pagos: [{ id: segundo.id, anular: true }] });
    pagos = await pagosDe(s155);
    s = await leer(s155);
    const anulado = pagos.find((p) => p.id === segundo.id)!;
    c(r.estado === 200 && s.pagado === '1000.00' && s.pagos === 1 && s.estado === 'abonada',
      `anular el pago de 500: vuelve a 1,000 pagado (dio ${r.estado} ${JSON.stringify(s)})`);
    c(!anulado.activo && anulado.anulado_por === admin.id && !!anulado.anulado_at &&
      anulado.motivo_anulacion === 'El banco rechazó la transferencia' && anulado.monto === '500.00',
      `el pago anulado sigue en la base con quién, cuándo y por qué (dio ${JSON.stringify(anulado)})`);
    c((await archivosDe(segundo.id)).length === 1, 'el comprobante del pago anulado no se pierde');
    corr = await ultimaCorreccion(s155);
    c(corr.cambios.some((x) => x.campo === 'pago_anulado' && x.pago_id === segundo.id &&
      x.descripcion === 'Pago del 19/nov/2026 por B/. 500.00'),
      `el historial dice qué pago se anuló (dio ${JSON.stringify(corr.cambios)})`);
    r = await corregir(s155, { pagos: [{ id: segundo.id, monto: '400.00' }] });
    c(r.estado === 400, `un pago anulado ya no se corrige: 400 (dio ${r.estado})`);
    r = await corregir(s155, { pagos: [{ id: segundo.id, anular: true }] });
    c(r.estado === 400, `ni se anula dos veces: 400 (dio ${r.estado})`);
    r = await corregir(s155, { archivos: { [`archivos_pago_${segundo.id}`]: ['otro.pdf'] } });
    c(r.estado === 400, `ni se le cambia el comprobante: 400 (dio ${r.estado})`);

    // El detalle trae los pagos, también el anulado, con sus archivos
    const det = await pedir('GET', `/solicitudes-pago/${s155}`);
    const lista = det.json.pagos as { id: number; monto: string; activo: boolean; motivo_anulacion: string | null; adjuntos: unknown[] }[];
    c(Array.isArray(lista) && lista.length === 2 &&
      lista.some((p) => p.id === primero.id && p.activo && p.monto === '1000.00' && p.adjuntos.length === 1) &&
      lista.some((p) => p.id === segundo.id && !p.activo && p.motivo_anulacion === 'El banco rechazó la transferencia'),
      `el detalle trae los dos pagos, el anulado marcado (dio ${JSON.stringify(lista)})`);

    // Anulados todos: vuelve a «Por pagar», sale de Control de Costos, y se puede volver a pagar
    r = await corregir(s155, { pagos: [{ id: primero.id, anular: true }] });
    s = await leer(s155);
    c(r.estado === 200 && s.estado === 'aprobada' && s.pagado === '0.00' && s.pagos === 0,
      `anulados todos, vuelve a «Por pagar» (dio ${r.estado} ${JSON.stringify(s)})`);
    corr = await ultimaCorreccion(s155);
    c(corr.cambios.some((x) => x.campo === 'estado' && x.anterior === 'Abonada' && x.nuevo === 'Por pagar'),
      `el historial anota «Abonada → Por pagar» (dio ${JSON.stringify(corr.cambios)})`);
    const enCostos = await query('SELECT 1 FROM solicitud_pago_gasto WHERE solicitud_pago_id = $1', [s155]);
    c(enCostos.rows.length === 0, 'sin pagos, ya no cuenta como gasto en Control de Costos');
    r = await corregir(s155, { pagos: [{ id: primero.id, monto: '10.00' }] });
    c(r.estado === 400, `una solicitud por pagar no se corrige por aquí: 400 (dio ${r.estado})`);
    const otraVez = await pagar(s155, '1293.75');
    s = await leer(s155);
    c(otraVez.estado === 200 && s.estado === 'abonada' && s.pagado === '1293.75',
      `y se vuelve a pagar como cualquiera (dio ${otraVez.estado} ${JSON.stringify(s)})`);

    // ---- pagada de una vez: corregir el total mueve el pago y sigue pagada
    const mil = await crear('PRU1-PC1000', 1000);
    await pagar(mil);
    const [pMil] = await pagosDe(mil);
    r = await corregir(mil, { total: 1100 });
    s = await leer(mil);
    c(r.estado === 200 && s.estado === 'pagada' && s.total === '1100.00' && s.pagado === '1100.00',
      `total a 1,100: el pago pasa a 1,100 y sigue pagada (dio ${r.estado} ${JSON.stringify(s)})`);
    corr = await ultimaCorreccion(mil);
    c(corr.cambios.some((x) => x.campo === 'monto_total') &&
      corr.cambios.some((x) => x.campo === 'pago' && x.pago_id === pMil.id &&
        x.cambios?.some((y) => y.campo === 'monto' && y.anterior === '1000.00' && y.nuevo === '1100.00')) &&
      !corr.cambios.some((x) => x.campo === 'estado'),
      `el historial dice el total y el pago movido, sin cambio de estado (dio ${JSON.stringify(corr.cambios)})`);
    r = await corregir(mil, { total: 900 });
    s = await leer(mil);
    c(r.estado === 200 && s.estado === 'pagada' && s.pagado === '900.00',
      `total a 900: el pago baja a 900 y sigue pagada (dio ${r.estado} ${JSON.stringify(s)})`);

    // ---- pagada en dos pagos: se mueve el ÚLTIMO
    const dos = await crear('PRU1-PCDOS', 1000);
    await pagar(dos, '600', '2026-11-20');
    await pagar(dos, '400', '2026-11-10');
    const [p600, p400] = await pagosDe(dos);
    r = await corregir(dos, { total: 950 });
    pagos = await pagosDe(dos);
    s = await leer(dos);
    c(r.estado === 200 && s.estado === 'pagada' &&
      pagos.find((p) => p.id === p600.id)?.monto === '550.00' && pagos.find((p) => p.id === p400.id)?.monto === '400.00',
      `total a 950: baja el último pago por fecha (el del 20/nov), sigue pagada (dio ${r.estado} ${JSON.stringify(pagos)})`);
    const antesDos = await correcciones(dos);
    r = await corregir(dos, { total: 300 });
    s = await leer(dos);
    c(r.estado === 400 && s.total === '950.00' && s.pagado === '950.00' && (await correcciones(dos)) === antesDos,
      `total a 300 no alcanza ni para el primer pago: 400 y no cambia nada (dio ${r.estado} ${JSON.stringify(r.json)})`);
    // El admin corrige el total y los pagos a la vez: manda lo que escribió
    r = await corregir(dos, { total: 1000, pagos: [{ id: p600.id, anular: true }] });
    s = await leer(dos);
    c(r.estado === 200 && s.estado === 'abonada' && s.total === '1000.00' && s.pagado === '400.00',
      `total a 1,000 y anular el de 550 en la misma: abonada con 400 (dio ${r.estado} ${JSON.stringify(s)})`);
    corr = await ultimaCorreccion(dos);
    c(corr.cambios.some((x) => x.campo === 'estado' && x.anterior === 'Pagada' && x.nuevo === 'Abonada'),
      `el historial anota «Pagada → Abonada» (dio ${JSON.stringify(corr.cambios)})`);

    // ---- abonada: bajar el total a lo pagado la deja pagada; por debajo, no
    const abo = await crear('PRU1-PCABO', 1000);
    await pagar(abo, '300');
    r = await corregir(abo, { total: 200 });
    s = await leer(abo);
    c(r.estado === 400 && s.total === '1000.00', `un total menor que lo pagado: 400 (dio ${r.estado} ${JSON.stringify(s)})`);
    r = await corregir(abo, { total: 300 });
    s = await leer(abo);
    c(r.estado === 200 && s.estado === 'pagada' && s.saldo === '0.00',
      `total igual a lo pagado: queda pagada (dio ${r.estado} ${JSON.stringify(s)})`);

    // ---- facturada: anular su pago la deja «Por pagar» CON su factura; al pagarla, facturada otra vez
    const fac = await crear('PRU1-PCFAC', 700);
    await pagar(fac);
    c((await facturar(fac)) === 200 && (await leer(fac)).estado === 'facturada', 'la facturada de la prueba está lista');
    const [pFac] = await pagosDe(fac);
    r = await corregir(fac, { pagos: [{ id: pFac.id, anular: true }] });
    s = await leer(fac);
    const detFac = await pedir('GET', `/solicitudes-pago/${fac}`);
    c(r.estado === 200 && s.estado === 'aprobada' && (detFac.json.factura as { numero_factura?: string } | null)?.numero_factura === 'F-009',
      `anulado su pago, vuelve a «Por pagar» y el detalle sigue mostrando la factura (dio ${r.estado} ${s.estado} ${JSON.stringify(detFac.json.factura)})`);
    const repago = await pagar(fac);
    c(repago.estado === 200 && repago.json.estado === 'facturada',
      `pagada otra vez, queda facturada (dio ${repago.estado} ${repago.json.estado})`);

    // ---- con el reembolso a Pinellas registrado no puede quedar saldo
    const pin = await crear('PRU1-PCPIN', 400);
    await query('UPDATE solicitudes_pago SET pinellas_paga = true WHERE id = $1', [pin]);
    await pagar(pin);
    await query(
      `INSERT INTO reembolsos_pinellas (solicitud_pago_id, comprobante_nombre, fecha_reembolso, registrado_por)
       VALUES ($1, 'reembolso.pdf', '2026-11-19', $2)`,
      [pin, admin.id],
    );
    const [pPin] = await pagosDe(pin);
    r = await corregir(pin, { pagos: [{ id: pPin.id, anular: true }] });
    s = await leer(pin);
    c(r.estado === 400 && s.estado === 'pagada', `con el reembolso a Pinellas no se anula su pago: 400 (dio ${r.estado} ${s.estado})`);
    r = await corregir(pin, { total: 450 });
    s = await leer(pin);
    c(r.estado === 200 && s.estado === 'pagada' && s.pagado === '450.00',
      `pero corregir su total mueve el pago y sigue pagada (dio ${r.estado} ${JSON.stringify(s)})`);

    // ---- la auditoría
    const auditoria = await query(
      "SELECT 1 FROM audit_log WHERE entidad = 'solicitud_pago' AND entidad_id = $1 AND accion = 'correccion'",
      [s155],
    );
    c(auditoria.rows.length >= 4, `cada corrección queda en la auditoría (hay ${auditoria.rows.length})`);
  } finally {
    // Los comprobantes van a solicitudes-pago/<id>/, fuera de los prefijos que
    // barre el corredor: se borran aquí, solo los de esta prueba. Los PDF
    // archivados van bajo PRUEBAS1/, que el corredor sí barre.
    const archivos = await query<{ r2_key: string }>(
      'SELECT r2_key FROM solicitud_pago_adjuntos WHERE solicitud_pago_id = ANY($1::int[])',
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
  process.exitCode = fallo ? 1 : 0;
};

main();
