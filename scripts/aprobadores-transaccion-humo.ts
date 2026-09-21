// Prueba de humo: guardar los aprobadores de un proyecto es todo o nada, deja
// rastro, y solo devuelve a cero lo que esta dentro de la cadena.
// cd andrei-backend && npm run pruebas -- aprobadores
//
// PUT /api/approval-settings/project/:id hace varias cosas seguidas: devuelve a
// pendiente las solicitudes pendientes y aprobadas sin pagar del proyecto
// (borrando sus aprobaciones y revisiones), cambia los aprobadores y anota el
// cambio en audit_log. Estaba escrito con query('BEGIN') sobre el pool, que no
// abre ninguna transaccion: cada query toma la conexion que haya libre. Con el
// servidor ocupado, si el ultimo paso fallaba, el ROLLBACK caia en otra
// conexion y los primeros pasos se quedaban hechos — solicitudes sin sus
// aprobaciones y un proyecto sin aprobadores — y ademas el BEGIN dejaba una
// conexion con una transaccion abierta que el pool le prestaba despues a
// cualquier otra peticion.
//
// Con el servidor tranquilo el defecto no se ve: el pool devuelve siempre la
// misma conexion y el falso BEGIN funciona por casualidad. Por eso cada ronda
// manda el guardado que falla mientras otras peticiones ocupan conexiones.
//
// Ademas comprueba lo del 2026-09-21: el rastro del cambio se guarda junto con
// el cambio (y no queda si el cambio falla); guardar la misma lista no toca
// nada; y las pagadas con cualquiera de sus nombres, los borradores y las
// rechazadas no vuelven a pendiente.
//
// Usa el proyecto 2, que en la semilla no tiene solicitudes ni aprobadores.
import { API } from './pruebas/contexto.js';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { query, pool } from '../src/database/config.js';

const P = 2;
const RONDAS = 8;
const RUIDO = 16;

interface Rastro {
  user_id: number;
  detalles: {
    antes: { user_id: number; orden: number }[];
    despues: { user_id: number; orden: number }[];
    solicitudes_reiniciadas: {
      id: number;
      estado_antes: string;
      aprobaciones: { user_id: number; accion: string }[];
      revisiones: { user_id: number }[];
    }[];
  };
}

const main = async () => {
  const u = await query<{ id: number; email: string; rol: string }>(
    "SELECT id, email, rol FROM users WHERE rol='admin' AND activo=true ORDER BY id LIMIT 1");
  const admin = u.rows[0];
  const token = jwt.sign(
    { userId: admin.id, email: admin.email, rol: admin.rol },
    process.env.JWT_SECRET!, { expiresIn: '10m' });
  const otros = (await query<{ id: number }>(
    'SELECT id FROM users WHERE activo = true AND id <> $1 ORDER BY id LIMIT 4', [admin.id]))
    .rows.map((r) => r.id);

  const pedir = async (m: string, r: string, b?: unknown) => {
    const res = await fetch(`${API}${r}`, {
      method: m,
      headers: { Authorization: `Bearer ${token}`, ...(b ? { 'Content-Type': 'application/json' } : {}) },
      ...(b ? { body: JSON.stringify(b) } : {}),
    });
    return { estado: res.status, cuerpo: await res.json().catch(() => null) };
  };

  let ok = 0; let fallo = 0;
  const c = (cond: boolean, etq: string) => {
    if (cond) ok += 1; else { fallo += 1; console.log('FALLA ', etq); }
  };

  const previos = await query<{ sp: string; ap: string }>(
    `SELECT (SELECT count(*) FROM solicitudes_pago WHERE proyecto_id = $1) sp,
            (SELECT count(*) FROM proyecto_ajustes_aprobacion WHERE proyecto_id = $1) ap`, [P]);
  if (previos.rows[0].sp !== '0' || previos.rows[0].ap !== '0') {
    console.log(`el proyecto ${P} ya tiene solicitudes o aprobadores; la prueba no lo toca`);
    await pool.end();
    process.exit(1);
  }

  let n = 0;
  const crearSolicitud = async (estado: string) => (await query<{ id: number }>(
    `INSERT INTO solicitudes_pago
       (proyecto_id, numero, proveedor, preparado_por, solicitado_por, estado, codigo_verificacion)
     VALUES ($1, $2, 'Proveedor de prueba', $3, $3, $4, $5)
     RETURNING id`,
    [P, `PRUEBA-APROB-${Date.now()}-${(n += 1)}`, admin.id, estado,
      crypto.randomBytes(5).toString('hex').toUpperCase()])).rows[0].id;

  // Una solicitud a medio aprobar, con dos aprobadores configurados.
  const solicitud = await crearSolicitud('aprobada');
  const sembrar = async () => {
    await query('DELETE FROM proyecto_ajustes_aprobacion WHERE proyecto_id = $1', [P]);
    await query(
      `INSERT INTO proyecto_ajustes_aprobacion (proyecto_id, user_id, orden, activo)
       VALUES ($1, $2, 1, true), ($1, $3, 2, true)`, [P, otros[0], otros[1]]);
    await query("UPDATE solicitudes_pago SET estado = 'aprobada' WHERE id = $1", [solicitud]);
    await query('DELETE FROM solicitud_aprobaciones WHERE solicitud_pago_id = $1', [solicitud]);
    await query('DELETE FROM solicitud_revisiones WHERE solicitud_pago_id = $1', [solicitud]);
    await query(
      `INSERT INTO solicitud_aprobaciones (solicitud_pago_id, user_id, orden, accion)
       VALUES ($1, $2, 1, 'aprobado')`, [solicitud, otros[0]]);
    await query(
      'INSERT INTO solicitud_revisiones (solicitud_pago_id, user_id) VALUES ($1, $2)',
      [solicitud, otros[1]]);
  };

  // Las que un cambio de aprobadores no debe tocar, cada una con su firma.
  const protegidas: Record<string, number> = {};
  for (const estado of ['borrador', 'rechazada', 'pagada', 'facturada',
    'reembolsada', 'transferida', 'devolucion']) {
    const id = await crearSolicitud(estado);
    protegidas[estado] = id;
    await query(
      `INSERT INTO solicitud_aprobaciones (solicitud_pago_id, user_id, orden, accion, comentario)
       VALUES ($1, $2, 1, $3, $4)`,
      [id, otros[0], estado === 'rechazada' ? 'rechazado' : 'aprobado',
        estado === 'rechazada' ? 'Falta la cotizacion' : null]);
  }
  // Y una pendiente que nadie ha firmado: no pierde nada, asi que no se anota.
  const limpia = await crearSolicitud('pendiente');

  const estado = async (id = solicitud) => {
    const r = await query<{ estado: string; apr: string; rev: string; aprobadores: number[] | null }>(
      `SELECT s.estado,
              (SELECT count(*) FROM solicitud_aprobaciones WHERE solicitud_pago_id = s.id) apr,
              (SELECT count(*) FROM solicitud_revisiones WHERE solicitud_pago_id = s.id) rev,
              (SELECT array_agg(user_id ORDER BY orden) FROM proyecto_ajustes_aprobacion
                WHERE proyecto_id = s.proyecto_id) aprobadores
         FROM solicitudes_pago s WHERE s.id = $1`, [id]);
    return r.rows[0];
  };

  const rastros = async () => (await query<Rastro>(
    `SELECT user_id, detalles FROM audit_log
      WHERE accion = 'editar_aprobadores' AND entidad = 'proyecto' AND entidad_id = $1
      ORDER BY id`, [P])).rows;

  const transaccionesColgadas = async () => Number((await query<{ n: string }>(
    `SELECT count(*) n FROM pg_stat_activity
      WHERE datname = current_database() AND state LIKE 'idle in transaction%'
        AND pid <> pg_backend_pid()`)).rows[0].n);

  for (let ronda = 1; ronda <= RONDAS; ronda += 1) {
    await sembrar();

    // Otras peticiones ocupando conexiones mientras corre el guardado.
    let seguir = true;
    const ruido = Array.from({ length: RUIDO }, async () => {
      while (seguir) await pedir('GET', `/approval-settings/project/${P}`);
    });

    // El segundo aprobador no existe: el INSERT revienta contra la clave
    // foranea de users, DESPUES de devolver solicitudes a pendiente.
    const r = await pedir('PUT', `/approval-settings/project/${P}`, {
      approvers: [{ user_id: otros[2], orden: 1 }, { user_id: 999999999, orden: 2 }],
    });
    seguir = false;
    await Promise.all(ruido);

    c(r.estado >= 400, `ronda ${ronda}: el guardado con un aprobador inexistente falla (dio ${r.estado})`);
    const e = await estado();
    c(e.estado === 'aprobada',
      `ronda ${ronda}: la solicitud sigue aprobada, no se devolvio a pendiente (esta ${e.estado})`);
    c(e.apr === '1', `ronda ${ronda}: conserva su aprobacion (tiene ${e.apr})`);
    c(e.rev === '1', `ronda ${ronda}: conserva su revision (tiene ${e.rev})`);
    c(JSON.stringify(e.aprobadores) === JSON.stringify([otros[0], otros[1]]),
      `ronda ${ronda}: los aprobadores siguen siendo los de antes (son ${JSON.stringify(e.aprobadores)})`);

    await new Promise((ok2) => setTimeout(ok2, 300));
    const colgadas = await transaccionesColgadas();
    c(colgadas === 0, `ronda ${ronda}: no queda ninguna conexion con una transaccion abierta (hay ${colgadas})`);
  }
  c((await rastros()).length === 0, 'ningun guardado fallido dejo rastro');

  // Guardar la misma lista no es un cambio: no devuelve nada a cero ni anota.
  await sembrar();
  const igual = await pedir('PUT', `/approval-settings/project/${P}`, {
    approvers: [{ user_id: otros[0], orden: 1 }, { user_id: otros[1], orden: 2 }],
  });
  c(igual.estado === 200, `guardar la misma lista responde 200 (dio ${igual.estado})`);
  const eIgual = await estado();
  c(eIgual.estado === 'aprobada' && eIgual.apr === '1' && eIgual.rev === '1',
    `guardar la misma lista no toca la solicitud (esta ${eIgual.estado}, ${eIgual.apr} aprob., ${eIgual.rev} rev.)`);
  c((await rastros()).length === 0, 'guardar la misma lista no deja rastro');

  // El guardado bueno devuelve a pendiente, cambia los aprobadores y anota.
  const bueno = await pedir('PUT', `/approval-settings/project/${P}`, {
    approvers: [{ user_id: otros[2], orden: 1 }, { user_id: otros[3], orden: 2 }],
  });
  c(bueno.estado === 200, `el guardado bueno responde 200 (dio ${bueno.estado})`);
  c((bueno.cuerpo?.approvers ?? []).length === 2, 'y devuelve la lista nueva');
  const e = await estado();
  c(e.estado === 'pendiente', `la solicitud sin terminar vuelve a pendiente (esta ${e.estado})`);
  c(e.apr === '0' && e.rev === '0', 'sin sus aprobaciones ni revisiones');
  c(JSON.stringify(e.aprobadores) === JSON.stringify([otros[2], otros[3]]),
    `con los aprobadores nuevos (son ${JSON.stringify(e.aprobadores)})`);

  for (const [est, id] of Object.entries(protegidas)) {
    const p = await estado(id);
    c(p.estado === est && p.apr === '1',
      `una ${est} no se toca (esta ${p.estado}, ${p.apr} aprob.)`);
  }

  const rs = await rastros();
  c(rs.length === 1, `el cambio deja un rastro (hay ${rs.length})`);
  const d = rs[0]?.detalles;
  c(rs[0]?.user_id === admin.id, 'con quien lo hizo');
  c(JSON.stringify(d?.antes.map((a) => a.user_id)) === JSON.stringify([otros[0], otros[1]]),
    'con la lista de antes');
  c(JSON.stringify(d?.despues.map((a) => a.user_id)) === JSON.stringify([otros[2], otros[3]]),
    'y la de despues');
  const reiniciadas = d?.solicitudes_reiniciadas ?? [];
  c(reiniciadas.length === 1 && reiniciadas[0].id === solicitud,
    `anota solo la solicitud que perdio algo (anoto ${JSON.stringify(reiniciadas.map((s) => s.id))}, limpia=${limpia})`);
  const s = reiniciadas[0];
  c(s?.estado_antes === 'aprobada', 'con el estado que tenia');
  c(s?.aprobaciones.length === 1 && s.aprobaciones[0].user_id === otros[0],
    'con la firma que perdio');
  c(s?.revisiones.length === 1 && s.revisiones[0].user_id === otros[1],
    'y la revision que perdio');

  // Cambiar solo el orden SI es un cambio: el orden decide quien firma despues.
  const orden = await pedir('PUT', `/approval-settings/project/${P}`, {
    approvers: [{ user_id: otros[3], orden: 1 }, { user_id: otros[2], orden: 2 }],
  });
  c(orden.estado === 200, `cambiar solo el orden responde 200 (dio ${orden.estado})`);
  c((await rastros()).length === 2, 'y cuenta como cambio: deja su rastro');

  console.log(`${ok} pasaron, ${fallo} fallaron`);
  await pool.end();
  process.exit(fallo ? 1 : 0);
};
main();
