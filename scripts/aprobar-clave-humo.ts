// Prueba de humo: equivocarse de contraseña al aprobar dice «Contraseña
// incorrecta» y deja a la persona dentro del sistema.
// cd andrei-backend && npm run pruebas -- aprobar-clave
//
// La pantalla toma CUALQUIER 401 como sesión vencida: borra el token y manda al
// login (services/api.ts del frontend). Aprobar una solicitud de pago con la
// contraseña equivocada respondía 401, así que un error de dedo sacaba a la
// persona del sistema en vez de decirle que se equivocó (encontrado el
// 2026-10-01). Ahora responde 403, igual que aprobar una orden de compra. La
// prueba mira las tres maneras de aprobar: una solicitud, varias revisadas a la
// vez, y una orden.
//
// La contraseña se mira antes que nada, así que no hace falta que la solicitud
// ni la orden existan.
import { API } from './pruebas/contexto.js';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { query, pool } from '../src/database/config.js';

const main = async () => {
  const admin = (
    await query<{ id: number; email: string; rol: string }>(
      "SELECT id, email, rol FROM users WHERE rol='admin' AND activo=true ORDER BY id LIMIT 1",
    )
  ).rows[0];

  // Una contraseña que solo vive lo que dura la prueba.
  await query('UPDATE users SET password = $1 WHERE id = $2', [
    await bcrypt.hash(randomUUID(), 4),
    admin.id,
  ]);
  const token = jwt.sign(
    { userId: admin.id, email: admin.email, rol: admin.rol },
    process.env.JWT_SECRET!,
    { expiresIn: '10m' },
  );

  const pedir = async (ruta: string, cuerpo: unknown) => {
    const res = await fetch(`${API}${ruta}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(cuerpo),
    });
    return { estado: res.status, cuerpo: await res.json().catch(() => null) };
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

  const una = await pedir('/solicitudes-pago/1/aprobar', { password: 'no-es-esta' });
  c(una.estado === 403, `una solicitud con la contraseña equivocada da 403, no 401 (dio ${una.estado})`);
  c(una.cuerpo?.message === 'Contraseña incorrecta', 'y dice «Contraseña incorrecta»');

  const varias = await pedir('/solicitudes-pago/aprobar-masivo', {
    ids: [1],
    password: 'no-es-esta',
  });
  c(varias.estado === 403, `varias revisadas a la vez, igual: 403 (dio ${varias.estado})`);
  c(varias.cuerpo?.message === 'Contraseña incorrecta', 'con el mismo mensaje');

  const orden = await pedir('/ordenes-compra/1/aprobar', { password: 'no-es-esta' });
  c(orden.estado === 403, `y una orden de compra también (dio ${orden.estado})`);
  c(orden.cuerpo?.error === 'Contraseña incorrecta', 'con el mismo mensaje');

  console.log(`${ok} pasaron, ${fallo} fallaron`);
  await pool.end();
  // Sin process.exit: cortar el proceso justo después de las peticiones, con
  // sus conexiones todavía cerrándose, revienta Node en Windows
  // («Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)») y la prueba sale
  // como fallida aunque todo haya pasado. Así termina solo cuando se cierran.
  process.exitCode = fallo ? 1 : 0;
};

main();
