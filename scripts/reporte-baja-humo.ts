// Prueba de humo de la baja de un reporte, contra el servidor local.
// cd andrei-backend && npx tsx --env-file=.env scripts/reporte-baja-humo.ts
//
// Hasta el 2026-09-11 no habia forma de quitar un reporte, ni en pantalla ni
// en la API, y en produccion habia tres copias del mismo dia. Esto comprueba
// que la baja lo esconde de TODAS partes —lista, detalle, PDF y la cola de
// correo— sin destruir la fila ni los PDF archivados en R2.
//
// Borra de verdad, en un finally, el reporte que ella misma crea.
import jwt from 'jsonwebtoken';
import { query, pool } from '../src/database/config.js';
import { encolarEnvio, reservarPendientes } from '../src/services/reporteEnvio.js';

const API = 'http://localhost:5000/api';
const P = 1;

const main = async () => {
  const admin = await query<{ id: number; email: string; rol: string }>(
    "SELECT id, email, rol FROM users WHERE rol='admin' AND activo=true ORDER BY id LIMIT 1");
  const firmar = (u: { id: number; email: string; rol: string }) =>
    jwt.sign({ userId: u.id, email: u.email, rol: u.rol },
      process.env.JWT_SECRET!, { expiresIn: '10m' });
  const token = firmar(admin.rows[0]);

  const pedir = async (m: string, r: string, b?: unknown, t = token) => {
    const res = await fetch(`${API}${r}`, {
      method: m,
      headers: { Authorization: `Bearer ${t}`, ...(b ? { 'Content-Type': 'application/json' } : {}) },
      ...(b ? { body: JSON.stringify(b) } : {}),
    });
    return { estado: res.status, cuerpo: await res.json().catch(() => null) };
  };

  let ok = 0; let fallo = 0;
  const c = (cond: boolean, etq: string) => {
    if (cond) ok += 1; else { fallo += 1; console.log('FALLA ', etq); }
  };

  let id: number | null = null;

  const enLista = async () => {
    const l = await pedir('GET', `/proyecto-reportes/${P}`);
    return (l.cuerpo?.data ?? []).some((r: { id: number }) => r.id === id);
  };

  try {
    const creado = await pedir('POST', `/proyecto-reportes/${P}`, {
      fecha: '2026-09-11', clima: 'Nublado', que_se_hizo: 'Prueba de baja',
    });
    c(creado.estado === 201, `crea el reporte (dio ${creado.estado})`);
    id = creado.cuerpo.data.id as number;

    c(!(await enLista()), 'como borrador NO aparece en la lista');

    // Desde el estado borrador, un reporte recien creado NO existe para nadie
    // hasta que /emitir lo completa. Sin esta llamada, todo lo que venga
    // despues recibe 404, que es exactamente lo que se busca.
    c((await pedir('POST', `/proyecto-reportes/${P}/${id}/emitir`)).estado === 200,
      'emitir lo completa');

    c(await enLista(), 'aparece en la lista antes de darlo de baja');
    c((await pedir('GET', `/proyecto-reportes/${P}/${id}`)).estado === 200,
      'y su detalle se puede abrir');

    // Lo ponemos en cola para comprobar que la baja tambien lo saca de ahi.
    await encolarEnvio(id);
    const antes = await query<{ envio_proximo_intento: Date | null }>(
      'SELECT envio_proximo_intento FROM proyecto_reportes WHERE id = $1', [id]);
    c(antes.rows[0].envio_proximo_intento !== null, 'esta en la cola de correo');

    // ---- un usuario corriente NO puede ----
    const raso = await query<{ id: number; email: string; rol: string }>(
      "SELECT id, email, rol FROM users WHERE rol='usuario' AND activo=true ORDER BY id LIMIT 1");
    if (raso.rows.length > 0) {
      const negado = await pedir('DELETE', `/proyecto-reportes/${P}/${id}`, undefined,
        firmar(raso.rows[0]));
      c(negado.estado === 403, `un usuario corriente no puede dar de baja (dio ${negado.estado})`);
      c((await query<{ activo: boolean }>(
        'SELECT activo FROM proyecto_reportes WHERE id = $1', [id])).rows[0].activo === true,
        'y el reporte sigue activo tras el intento');
    } else {
      console.log('(sin usuarios de rol "usuario" en la base: no se probo el 403)');
    }

    // ---- la baja ----
    const baja = await pedir('DELETE', `/proyecto-reportes/${P}/${id}`);
    c(baja.estado === 200, `el admin si puede darlo de baja (dio ${baja.estado})`);

    const fila = await query<{ activo: boolean; envio_proximo_intento: Date | null }>(
      'SELECT activo, envio_proximo_intento FROM proyecto_reportes WHERE id = $1', [id]);
    c(fila.rows.length === 1, 'la fila NO se destruye, sigue ahi');
    c(fila.rows[0].activo === false, 'queda marcada como inactiva');
    c(fila.rows[0].envio_proximo_intento === null, 'y sale de la cola de correo');

    const enCola = await reservarPendientes();
    c(!enCola.some((r) => r.id === id), 'el cron ya no lo coge para mandarlo');

    c(!(await enLista()), 'desaparece de la lista');
    c((await pedir('GET', `/proyecto-reportes/${P}/${id}`)).estado === 404,
      'su detalle da 404');
    c((await pedir('GET', `/proyecto-reportes/${P}/${id}/pdf`)).estado === 404,
      'su PDF da 404');
    c((await pedir('POST', `/proyecto-reportes/${P}/${id}/emitir`)).estado === 404,
      'ya no se puede emitir');

    const repetida = await pedir('DELETE', `/proyecto-reportes/${P}/${id}`);
    c(repetida.estado === 404, 'darlo de baja dos veces da 404, no revienta');

    const rastro = await query<{ detalles: { numero?: string } }>(
      `SELECT detalles FROM audit_log
        WHERE entidad = 'reporte_diario' AND entidad_id = $1 AND accion = 'eliminar'
        ORDER BY created_at DESC LIMIT 1`, [id]);
    c(rastro.rows.length === 1, 'queda registrado quien lo dio de baja');
    c(!!rastro.rows[0]?.detalles?.numero, 'y con que numero de reporte era');
  } finally {
    if (id) {
      await query('DELETE FROM audit_log WHERE entidad = $1 AND entidad_id = $2',
        ['reporte_diario', id]);
      await query('DELETE FROM proyecto_reportes WHERE id = $1', [id]);
      console.log('limpiado: el reporte de prueba y su rastro');
    }
  }

  console.log(`${ok} pasaron, ${fallo} fallaron`);
  await pool.end();
  process.exit(fallo ? 1 : 0);
};
main();
