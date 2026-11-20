// Prueba de humo: lo que cuenta como gasto con pagos parciales (tema 19, paso 4).
// cd andrei-backend && npm run pruebas -- pagos-parciales-gasto
//
// Ivan, 2026-11-18: Control de Costos (y por extensión las órdenes de compra y
// el reporte semanal) cuentan SOLO lo pagado. Se exige, con una solicitud de
// 2,000.00 abonada con 500.00 el 10/nov y 300.00 el 17/nov:
// - Control de Costos: gastado, la categoría y la fila del pago dicen 800.00;
//   la curva tiene 500 el 10/nov y 300 el 17/nov; la fila trae el total 2,000;
// - el reparto en partidas se hace sobre el total (2,000) y cada partida cuenta
//   en proporción a lo pagado (1,500 → 600, 500 → 200);
// - la orden de compra con su factura de 2,000: pagado 800, sigue «recibida», y
//   Control de Costos la tiene por pagar en 1,200;
// - el reporte semanal: 500 en la semana del 9/nov, 300 en la del 16/nov;
// - quien tiene «Ver control de costos» abre la abonada;
// - pagado el resto, todo queda exacto: 2,000, las partidas enteras, la orden
//   cerrada y nada por pagar.
import { API } from './pruebas/contexto.js';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { query, pool } from '../src/database/config.js';
import { deleteFile } from '../src/services/storage.js';
import { datosDeLaSemana } from '../src/services/reporteSemanalDatos.js';
import { cargarContexto } from '../src/services/asistentePagos/contexto.js';

interface Usuario {
  id: number;
  email: string;
  rol: string;
}

interface Resumen {
  gastado: number;
  porPagar: number;
  categorias: { id: number; monto: number; solicitudes: number }[];
  serie: { fecha: string; monto: number }[];
  solicitudes: { id: number; monto: number; total: number; fecha: string; partidas: unknown[] }[];
  comparativo: { filas: { rowUid: string; gastado: number }[]; sinPartida: { monto: number } };
}

const main = async () => {
  const admin = (
    await query<Usuario>("SELECT id, email, rol FROM users WHERE rol='admin' AND activo=true ORDER BY id LIMIT 1")
  ).rows[0];
  const soloCostos = (
    await query<Usuario>("SELECT id, email, rol FROM users WHERE email = 'aprobador2@pruebas.local'")
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
  const igual = (a: number | undefined, b: number) => a !== undefined && Math.abs(a - b) < 0.005;

  const pedir = async (metodo: string, ruta: string, quien: Usuario = admin, cuerpo?: unknown) => {
    const res = await fetch(`${API}${ruta}`, {
      method: metodo,
      headers: { Authorization: `Bearer ${token(quien)}`, 'Content-Type': 'application/json' },
      body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
    });
    return { estado: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  const pagar = async (id: number, fecha: string, monto?: string) => {
    const forma = new FormData();
    forma.append('fecha_pago', fecha);
    if (monto !== undefined) forma.append('monto', monto);
    forma.append('archivos', new Blob(['%PDF-1.4 comprobante'], { type: 'application/pdf' }), 'transferencia.pdf');
    const res = await fetch(`${API}/solicitudes-pago/${id}/registrar-pago`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token(admin)}` },
      body: forma,
    });
    return { estado: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  const resumen = async () => (await pedir('GET', '/costs/projects/1/resumen')).json.data as Resumen;
  const enFecha = (r: Resumen, f: string) => r.serie.find((s) => s.fecha === f)?.monto ?? 0;

  let sid = 0;
  // Las filas del presupuesto se llaman por su uuid.
  const filaA = randomUUID();
  const filaB = randomUUID();
  try {
    // Lo que el proyecto ya tenía antes de esta prueba: todo se mide en diferencia.
    const antes = await resumen();

    const categoria = (
      await query<{ id: number }>(
        "INSERT INTO categorias_gastos (codigo, nombre, orden) VALUES ('PPG', 'Pruebas pagos parciales', 999) RETURNING id",
      )
    ).rows[0].id;
    const presupuesto = (
      await query<{ id: number }>(
        `INSERT INTO presupuestos (proyecto_id, nombre, activo, es_principal, origen)
         VALUES (1, 'Presupuesto pruebas', true, true, 'cero') RETURNING id`,
      )
    ).rows[0].id;
    await query(
      `INSERT INTO presupuesto_renglones (presupuesto_id, seccion, tipo, codigo, descripcion, unidad, cantidad, costo_unitario, orden, row_uid)
       VALUES ($1, 'items', 'item', '1.1', 'Tubería', 'ml', 100, 30, 1, $2),
              ($1, 'items', 'item', '1.2', 'Válvulas', 'u', 10, 100, 2, $3)`,
      [presupuesto, filaA, filaB],
    );

    sid = (
      await query<{ id: number }>(
        `INSERT INTO solicitudes_pago (proyecto_id, numero, fecha, proveedor, preparado_por, solicitado_por,
            subtotal, descuentos, impuestos, monto_total, estado, beneficiario, banco, tipo_cuenta, numero_cuenta,
            urgente, codigo_verificacion, pinellas_paga, tipo, activo, categoria_id)
         VALUES (1, 'PRU1-PPG1', '2026-11-03', 'Ferretería Pruebas', $1, $1, 2000, 0, 0, 2000, 'aprobada',
                 'Ferretería Pruebas', 'BANCO GENERAL', 'corriente', '0000000000', false, $2, false, 'regular', true, $3)
         RETURNING id`,
        [admin.id, randomUUID().slice(0, 10).toUpperCase(), categoria],
      )
    ).rows[0].id;
    await query(
      `INSERT INTO solicitud_pago_items (solicitud_pago_id, cantidad, unidad, descripcion, precio_unitario, precio_total, orden)
       VALUES ($1, 1, 'global', 'Tubería y válvulas', 2000, 2000, 0)`,
      [sid],
    );
    // La orden de compra que esta solicitud paga: una factura de 2,000 ya recibida.
    const orden = (
      await query<{ id: number }>(
        `INSERT INTO ordenes_compra (proyecto_id, numero, proveedor, subtotal, monto_total, estado, codigo_verificacion,
            creado_por, completa_at, completa_por)
         VALUES (1, 'OC-PRU1-PPG', 'Ferretería Pruebas', 2000, 2000, 'enviada', $2, $1, now(), $1) RETURNING id`,
        [admin.id, randomUUID().slice(0, 10).toUpperCase()],
      )
    ).rows[0].id;
    const entrega = (
      await query<{ id: number }>(
        `INSERT INTO orden_compra_entregas (orden_compra_id, fecha, vence, subtotal, monto_total, registrada_por, numero_factura)
         VALUES ($1, '2026-11-02', '2026-12-02', 2000, 2000, $2, 'F-77') RETURNING id`,
        [orden, admin.id],
      )
    ).rows[0].id;
    await query('INSERT INTO solicitud_pago_entregas (solicitud_pago_id, entrega_id, monto) VALUES ($1, $2, 2000)', [sid, entrega]);
    const conLaOrden = await resumen();

    // ---- dos pagos parciales, en dos semanas
    const p1 = await pagar(sid, '2026-11-10', '500');
    const p2 = await pagar(sid, '2026-11-17', '300');
    c(p1.estado === 200 && p2.estado === 200 && p2.json.estado === 'abonada',
      `500 y 300 la dejan abonada (dieron ${p1.estado} ${p2.estado} ${p2.json.estado})`);

    let r = await resumen();
    c(igual(r.gastado - antes.gastado, 800), `Control de Costos: gastado sube 800 (subió ${r.gastado - antes.gastado})`);
    c(igual(enFecha(r, '2026-11-10') - enFecha(antes, '2026-11-10'), 500) &&
      igual(enFecha(r, '2026-11-17') - enFecha(antes, '2026-11-17'), 300),
      `la curva: 500 el 10/nov y 300 el 17/nov (${JSON.stringify(r.serie.filter((s) => s.fecha >= '2026-11-10'))})`);
    const cat = r.categorias.find((x) => x.id === categoria);
    c(igual(cat?.monto, 800) && cat?.solicitudes === 1, `la categoría suma 800 en 1 solicitud (${JSON.stringify(cat)})`);
    let fila = r.solicitudes.find((s) => s.id === sid);
    c(igual(fila?.monto, 800) && igual(fila?.total, 2000) && fila?.fecha === '2026-11-17',
      `la fila del pago: 800 pagado de 2,000, al 17/nov (${JSON.stringify(fila)})`);
    c(igual(r.porPagar - antes.porPagar, 1200) && igual(conLaOrden.porPagar - antes.porPagar, 2000),
      `por pagar de la orden: 2,000 antes de pagar, 1,200 después (${conLaOrden.porPagar - antes.porPagar} → ${r.porPagar - antes.porPagar})`);

    // ---- partidas: el reparto es sobre el total; cuenta en proporción
    const repartoPagado = await pedir('PUT', `/costs/projects/1/pagos/${sid}/partidas`, admin, {
      partidas: [{ rowUid: filaA, monto: 800 }],
    });
    c(repartoPagado.estado === 400, `repartir solo lo pagado (800) no cuadra con el total (dio ${repartoPagado.estado})`);
    const reparto = await pedir('PUT', `/costs/projects/1/pagos/${sid}/partidas`, admin, {
      partidas: [{ rowUid: filaA, monto: 1500 }, { rowUid: filaB, monto: 500 }],
    });
    c(reparto.estado === 200, `una abonada se reparte sobre su total (dio ${reparto.estado} ${JSON.stringify(reparto.json)})`);
    r = await resumen();
    const a = r.comparativo.filas.find((f) => f.rowUid === filaA);
    const b = r.comparativo.filas.find((f) => f.rowUid === filaB);
    c(igual(a?.gastado, 600) && igual(b?.gastado, 200),
      `cada partida cuenta en proporción: 600 y 200 (${a?.gastado} ${b?.gastado})`);
    c(igual(r.comparativo.sinPartida.monto, antes.comparativo.sinPartida.monto),
      `y nada queda «sin partida» por la abonada (${r.comparativo.sinPartida.monto})`);

    // ---- la orden de compra
    let oc = (await pedir('GET', `/ordenes-compra/${orden}`)).json.data as {
      estado_calculado: string; pagado: string; entregas: { id: number; pagado: string }[];
    };
    c(igual(Number(oc.pagado), 800) && oc.estado_calculado === 'recibida' && igual(Number(oc.entregas[0]?.pagado), 800),
      `la orden: pagado 800, sigue recibida (${oc.pagado} ${oc.estado_calculado} ${oc.entregas[0]?.pagado})`);

    // ---- el reporte semanal: cada pago en su semana
    const semana1 = await datosDeLaSemana(1, '2026-11-10');
    const semana2 = await datosDeLaSemana(1, '2026-11-17');
    const enSemana = (d: Awaited<ReturnType<typeof datosDeLaSemana>>) =>
      d.pagos.filas.find((f) => f.categoria === 'Pruebas pagos parciales');
    c(igual(enSemana(semana1)?.monto, 500) && enSemana(semana1)?.solicitudes === 1 &&
      igual(enSemana(semana2)?.monto, 300) && enSemana(semana2)?.solicitudes === 1,
      `el semanal: 500 la semana del 9/nov y 300 la del 16/nov (${JSON.stringify(enSemana(semana1))} ${JSON.stringify(enSemana(semana2))})`);

    // ---- el asistente de pagos la ve, con su total para repartir
    const ctx = await cargarContexto(1);
    const delAsistente = ctx?.pagos.find((p) => p.id === sid);
    c(igual(delAsistente?.monto, 2000), `el asistente de pagos la ve con su total, 2,000 (${delAsistente?.monto})`);

    // ---- quien tiene «Ver control de costos» abre la abonada
    await query('INSERT INTO user_project_access (user_id, proyecto_id) VALUES ($1, 1) ON CONFLICT DO NOTHING', [soloCostos.id]);
    await query(
      `INSERT INTO user_permissions (user_id, costos_ver, solicitudes_ver, registrar_pago) VALUES ($1, true, false, false)
       ON CONFLICT (user_id) DO UPDATE SET costos_ver = true, solicitudes_ver = false, registrar_pago = false`,
      [soloCostos.id],
    );
    const ve = await pedir('GET', `/solicitudes-pago/${sid}`, soloCostos);
    c(ve.estado === 200, `«Ver control de costos» abre la abonada desde Control de Costos (dio ${ve.estado})`);

    // ---- el resto: todo exacto
    const p3 = await pagar(sid, '2026-11-24');
    c(p3.estado === 200 && p3.json.estado === 'pagada', `el resto la deja pagada (dio ${p3.estado} ${p3.json.estado})`);
    r = await resumen();
    fila = r.solicitudes.find((s) => s.id === sid);
    const a2 = r.comparativo.filas.find((f) => f.rowUid === filaA);
    const b2 = r.comparativo.filas.find((f) => f.rowUid === filaB);
    c(r.gastado - antes.gastado === 2000 && fila?.monto === 2000 && a2?.gastado === 1500 && b2?.gastado === 500,
      `pagada: 2,000 y las partidas enteras, exactas (${r.gastado - antes.gastado} ${fila?.monto} ${a2?.gastado} ${b2?.gastado})`);
    c(r.porPagar === antes.porPagar, `nada por pagar de la orden (${r.porPagar - antes.porPagar})`);
    oc = (await pedir('GET', `/ordenes-compra/${orden}`)).json.data as typeof oc;
    c(Number(oc.pagado) === 2000 && oc.estado_calculado === 'cerrada', `la orden queda cerrada (${oc.pagado} ${oc.estado_calculado})`);
  } finally {
    // Los comprobantes van a solicitudes-pago/<id>/comprobantes/, fuera de lo que
    // barre el corredor: se borran aquí, solo los de esta prueba.
    if (sid) {
      const archivos = await query<{ r2_key: string }>(
        'SELECT r2_key FROM solicitud_pago_adjuntos WHERE solicitud_pago_id = $1',
        [sid],
      );
      for (const { r2_key } of archivos.rows) {
        try {
          await deleteFile(r2_key);
        } catch (e) {
          console.log('no se pudo borrar', r2_key, (e as Error).message);
        }
      }
    }
  }

  console.log(`${ok} pasaron, ${fallo} fallaron`);
  await pool.end();
  // Sin process.exit: ver aprobar-clave-humo.ts.
  process.exitCode = fallo ? 1 : 0;
};

main();
