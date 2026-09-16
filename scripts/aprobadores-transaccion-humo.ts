// Prueba de humo: guardar los aprobadores de un proyecto es todo o nada.
// cd andrei-backend && npx tsx --env-file=.env scripts/aprobadores-transaccion-humo.ts
//
// PUT /api/approval-settings/project/:id hace tres cosas seguidas: devuelve a
// pendiente las solicitudes sin terminar del proyecto (borrando sus
// aprobaciones y revisiones), borra los aprobadores y escribe los nuevos. Estaba
// escrito con query('BEGIN') sobre el pool, que no abre ninguna transaccion:
// cada query toma la conexion que haya libre. Con el servidor ocupado, si el
// ultimo paso fallaba, el ROLLBACK caia en otra conexion y los dos primeros
// pasos se quedaban hechos — solicitudes sin sus aprobaciones y un proyecto sin
// aprobadores — y ademas el BEGIN dejaba una conexion con una transaccion
// abierta que el pool le prestaba despues a cualquier otra peticion.
//
// Con el servidor tranquilo el defecto no se ve: el pool devuelve siempre la
// misma conexion y el falso BEGIN funciona por casualidad. Por eso cada ronda
// manda el guardado que falla mientras otras peticiones ocupan conexiones.
//
// Usa el proyecto 2, que no tiene solicitudes ni aprobadores, y lo deja como
// estaba en un finally.
import { API } from './pruebas/contexto.js';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { query, pool } from '../src/database/config.js';

const P = 2;
const RONDAS = 8;
const RUIDO = 16;

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

  let solicitud: number | undefined;

  // Una solicitud a medio aprobar, con dos aprobadores configurados.
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

  const estado = async () => {
    const r = await query<{ estado: string; apr: string; rev: string; aprobadores: number[] | null }>(
      `SELECT s.estado,
              (SELECT count(*) FROM solicitud_aprobaciones WHERE solicitud_pago_id = s.id) apr,
              (SELECT count(*) FROM solicitud_revisiones WHERE solicitud_pago_id = s.id) rev,
              (SELECT array_agg(user_id ORDER BY orden) FROM proyecto_ajustes_aprobacion
                WHERE proyecto_id = s.proyecto_id) aprobadores
         FROM solicitudes_pago s WHERE s.id = $1`, [solicitud]);
    return r.rows[0];
  };

  const transaccionesColgadas = async () => Number((await query<{ n: string }>(
    `SELECT count(*) n FROM pg_stat_activity
      WHERE datname = current_database() AND state LIKE 'idle in transaction%'
        AND pid <> pg_backend_pid()`)).rows[0].n);

  solicitud = (await query<{ id: number }>(
    `INSERT INTO solicitudes_pago
       (proyecto_id, numero, proveedor, preparado_por, solicitado_por, estado, codigo_verificacion)
     VALUES ($1, $2, 'Proveedor de prueba', $3, $3, 'aprobada', $4)
     RETURNING id`,
    [P, `PRUEBA-APROB-${Date.now()}`, admin.id, crypto.randomBytes(5).toString('hex').toUpperCase()])).rows[0].id;

  for (let ronda = 1; ronda <= RONDAS; ronda += 1) {
    await sembrar();

    // Otras peticiones ocupando conexiones mientras corre el guardado.
    let seguir = true;
    const ruido = Array.from({ length: RUIDO }, async () => {
      while (seguir) await pedir('GET', `/approval-settings/project/${P}`);
    });

    // El segundo aprobador no existe: el INSERT del ultimo paso revienta
    // contra la clave foranea de users, DESPUES de los dos primeros pasos.
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

  // Y el guardado bueno hace lo mismo que hacia: devuelve a pendiente y
  // cambia los aprobadores.
  await sembrar();
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

  console.log(`${ok} pasaron, ${fallo} fallaron`);
  await pool.end();
  process.exit(fallo ? 1 : 0);
};
main();
