// Prueba de humo: el avance físico sale de las cuentas (migración 186).
// cd andrei-backend && npm run pruebas -- avance
//
// Ivan, 2026-10-01: el avance físico es lo que hay en cuentas, presentadas o no,
// aprobadas o no, pagadas o no; las que siguen en borrador cuentan, pero la
// pantalla avisa que incluye avance todavía no presentado. Se exige:
// - cuentas a mano: el acumulado es la suma en orden, las borradas no cuentan,
//   y lo de las cuentas en borrador sale aparte con sus números;
// - cuentas con desglose: el avance de cada una es el de su cuadro, a precisión
//   completa, aunque un precio cambie entre una foto y la siguiente;
// - el Resumen del proyecto, la lista de Cuentas, el detalle de una cuenta y
//   el resumen general de Cuentas dicen el mismo número;
// - un proyecto sin cuentas no tiene avance.
import { API } from './pruebas/contexto.js';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
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
  const firmar = (u: Usuario) =>
    jwt.sign({ userId: u.id, email: u.email, rol: u.rol }, process.env.JWT_SECRET!, { expiresIn: '10m' });
  const pedir = async (ruta: string) => {
    const res = await fetch(`${API}${ruta}`, { headers: { Authorization: `Bearer ${firmar(admin)}` } });
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
  const cerca = (a: unknown, b: number) => typeof a === 'number' && Math.abs(a - b) < 1e-9;

  const cuenta = async (proyecto: number, numero: number, estado: string, avance: number | null, extra: { desglose?: number; activo?: boolean } = {}) =>
    (await query<{ id: number }>(
      `INSERT INTO cuentas (proyecto_id, numero, monto_total, estado, avance_porcentaje, desglose_id, activo, creado_por)
       VALUES ($1, $2, 1000, $3, $4, $5, $6, $7) RETURNING id`,
      [proyecto, numero, estado, avance, extra.desglose ?? null, extra.activo ?? true, admin.id],
    )).rows[0].id;

  // --- Proyecto 1: cuentas a mano
  await cuenta(1, 1, 'pagada', 20);
  const c2 = await cuenta(1, 2, 'enviada_institucion', 15.5);
  await cuenta(1, 3, 'borrador', 10.25);
  await cuenta(1, 4, 'borrador', null);
  await cuenta(1, 9, 'pagada', 99, { activo: false });

  const p1 = (await pedir('/projects/1')).json.proyecto as Record<string, unknown>;
  c(cerca(p1.avance_fisico, 45.75), `a mano: acumulado 45.75 (dio ${p1.avance_fisico})`);
  c(cerca(p1.avance_presentado, 35.5), `lo presentado: 35.50 (dio ${p1.avance_presentado})`);
  c(cerca(p1.avance_sin_presentar, 10.25), `lo que está en borrador: 10.25 (dio ${p1.avance_sin_presentar})`);
  c(p1.avance_cuenta_numero === 3, `hasta la última cuenta que aporta, la 3 (dio ${p1.avance_cuenta_numero})`);
  c(JSON.stringify(p1.avance_cuentas_sin_presentar) === '[3]', `las de borrador que aportan: [3] (dio ${JSON.stringify(p1.avance_cuentas_sin_presentar)})`);

  const lista1 = ((await pedir('/cuentas?proyecto_id=1')).json.data as Record<string, unknown>[]) ?? [];
  const n2 = lista1.find((x) => x.numero === 2);
  c(cerca(n2?.avance_periodo, 15.5) && cerca(n2?.avance_acumulado, 35.5), 'la lista de Cuentas trae el periodo y el acumulado de cada una');
  const det2 = (await pedir(`/cuentas/${c2}`)).json.data as Record<string, unknown>;
  c(cerca(det2?.avance_acumulado, 35.5), `el detalle de la cuenta 2: 35.50 hasta ella (dio ${det2?.avance_acumulado})`);
  const resumen = ((await pedir('/cuentas/resumen')).json.data as Record<string, unknown>[]) ?? [];
  const r1 = resumen.find((x) => x.proyecto_id === 1);
  c(cerca(r1?.avance_acumulado, 45.75), `el resumen general de Cuentas: 45.75 (dio ${r1?.avance_acumulado})`);
  c(cerca(r1?.avance_previo, 35.5), `y hasta la cuenta anterior a la que se prepara: 35.50 (dio ${r1?.avance_previo})`);
  const pend = (r1?.pendientes as Record<string, unknown>[] | undefined)?.find((x) => x.numero === 2);
  c(cerca(pend?.avance_previo, 20), `y la pendiente 2 arranca donde terminó la 1: 20.00 (dio ${pend?.avance_previo})`);

  // --- Proyecto 2: cuentas con desglose; el precio de B cambia de 200 a 300
  const desglose = (await query<{ id: number }>(
    "INSERT INTO desgloses (proyecto_id, nombre, tipo) VALUES (2, 'Desglose de pruebas', 'cuentas') RETURNING id",
  )).rows[0].id;
  const [A, B, G] = [randomUUID(), randomUUID(), randomUUID()];
  const linea = (cuentaId: number, uid: string, tipo: string, presupuesto: number | null, precio: number | null, ejecutada: number, orden: number) =>
    query(
      `INSERT INTO cuenta_lineas (cuenta_id, row_uid, tipo, item, descripcion, cantidad_presupuesto, precio_unitario, cantidad_ejecutada, orden)
       VALUES ($1, $2, $3, $4, 'Fila de prueba', $5, $6, $7, $8)`,
      [cuentaId, uid, tipo, String(orden), presupuesto, precio, ejecutada, orden],
    );
  const d1 = await cuenta(2, 1, 'enviada_institucion', 30, { desglose });
  await linea(d1, G, 'grupo', null, null, 0, 1);
  await linea(d1, A, 'item', 10, 100, 4, 2);
  await linea(d1, B, 'item', 5, 200, 1, 3);
  const d2 = await cuenta(2, 2, 'borrador', 32, { desglose });
  await linea(d2, G, 'grupo', null, null, 0, 1);
  await linea(d2, A, 'item', 10, 100, 2, 2);
  await linea(d2, B, 'item', 5, 300, 2, 3);
  // Cuenta 1: (4·100 + 1·200) / (10·100 + 5·200) = 600 / 2000 = 30 %.
  // Cuenta 2, periodo: (2·100 + 2·300) / (10·100 + 5·300) = 800 / 2500 = 32 %.
  // Cuenta 2, acumulado: ((4+2)·100 + (1+2)·300) / 2500 = 1500 / 2500 = 60 %.
  const lista2 = ((await pedir('/cuentas?proyecto_id=2')).json.data as Record<string, unknown>[]) ?? [];
  const l1 = lista2.find((x) => x.numero === 1);
  const l2 = lista2.find((x) => x.numero === 2);
  c(cerca(l1?.avance_periodo, 30) && cerca(l1?.avance_acumulado, 30), `desglose, cuenta 1: 30 % (dio ${l1?.avance_periodo}, ${l1?.avance_acumulado})`);
  c(cerca(l2?.avance_periodo, 32), `cuenta 2, su periodo con su foto: 32 % (dio ${l2?.avance_periodo})`);
  c(cerca(l2?.avance_acumulado, 60), `cuenta 2, acumulado por cantidades a sus precios: 60 % (dio ${l2?.avance_acumulado})`);
  const detD2 = (await pedir(`/cuentas/${d2}`)).json.data as { avance_desglose?: { acumulado: number; periodo: number } };
  c(cerca(detD2?.avance_desglose?.acumulado, 60) && cerca(detD2?.avance_desglose?.periodo, 32), 'el cuadro de la cuenta 2 dice lo mismo');
  const p2 = (await pedir('/projects/2')).json.proyecto as Record<string, unknown>;
  c(cerca(p2.avance_fisico, 60) && cerca(p2.avance_sin_presentar, 32) && cerca(p2.avance_presentado, 28), `el Resumen del proyecto 2: 60, de ellos 32 sin presentar (dio ${p2.avance_fisico}, ${p2.avance_sin_presentar}, ${p2.avance_presentado})`);

  // Precisión completa: un tercio no se queda en 33.33.
  await query('UPDATE cuenta_lineas SET cantidad_ejecutada = 0 WHERE cuenta_id = $1', [d2]);
  await query('UPDATE cuenta_lineas SET cantidad_ejecutada = 2 WHERE cuenta_id = $1 AND row_uid = $2', [d2, B]);
  await query('UPDATE cuenta_lineas SET precio_unitario = 200 WHERE cuenta_id = $1 AND row_uid = $2', [d2, B]);
  await query('UPDATE cuenta_lineas SET cantidad_presupuesto = 4 WHERE cuenta_id = $1 AND row_uid = $2', [d2, A]);
  // presupuesto 4·100 + 5·200 = 1400; periodo 2·200 = 400 → 28.571428…
  const p2b = (await pedir('/projects/2')).json.proyecto as Record<string, unknown>;
  c(cerca(p2b.avance_sin_presentar, (400 / 1400) * 100), `a precisión completa (dio ${p2b.avance_sin_presentar})`);

  // --- Proyecto 3: sin cuentas
  const p3 = (await pedir('/projects/3')).json.proyecto as Record<string, unknown>;
  c(p3.avance_fisico === null && p3.avance_cuenta_numero === null, 'un proyecto sin cuentas no tiene avance');

  console.log(`${ok} pasaron, ${fallo} fallaron`);
  await pool.end();
  // Sin process.exit: ver aprobar-clave-humo.ts (Node en Windows revienta si se
  // corta con las conexiones cerrándose).
  process.exitCode = fallo ? 1 : 0;
};

main();
