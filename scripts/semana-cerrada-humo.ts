// Prueba de humo de la semana cerrada, contra la base desechable.
// cd andrei-backend && npm run pruebas -- semana-cerrada
//
// Decisión de Ivan (2026-09-17): cuando el reporte SEMANAL de una semana se
// envía, esa semana queda cerrada para los diarios. Ni se corrigen, ni se
// eliminan, ni se puede crear uno nuevo con fecha de esos siete días; lo que
// aparezca después se anota en un diario posterior.
//
// Lo que vigila esta prueba es justamente eso, porque el bloqueo toca el camino
// que el ingeniero usa todos los días: si se pasa de listo, Cesar no puede
// corregir un reporte que sí debería poder corregir. Por eso cada cierre se
// comprueba con su contrario: el mismo movimiento en una semana ABIERTA tiene
// que seguir funcionando.
//
// El reporte semanal se mete aquí a mano con SQL: sus rutas son de la etapa 2.
import { API } from './pruebas/contexto.js';
import jwt from 'jsonwebtoken';
import { query, pool } from '../src/database/config.js';
import { lunesDe, semanaIso } from '../src/services/reporteSemana.js';

const P = 1;

// Dos semanas de 2026 que no se tocan: la 37 se cierra, la 38 se queda abierta.
const CERRADA = '2026-09-09';   // miércoles de la semana 37
const ABIERTA = '2026-09-16';   // miércoles de la semana 38

const main = async () => {
  const admin = await query<{ id: number; email: string; rol: string }>(
    "SELECT id, email, rol FROM users WHERE rol='admin' AND activo=true ORDER BY id LIMIT 1");
  const token = jwt.sign(
    { userId: admin.rows[0].id, email: admin.rows[0].email, rol: admin.rows[0].rol },
    process.env.JWT_SECRET!, { expiresIn: '10m' },
  );

  const pedir = async (m: string, r: string, b?: unknown) => {
    const res = await fetch(`${API}${r}`, {
      method: m,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(b ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(b ? { body: JSON.stringify(b) } : {}),
    });
    return { estado: res.status, cuerpo: await res.json().catch(() => null) };
  };

  let ok = 0; let fallo = 0;
  const c = (cond: boolean, etq: string) => {
    if (cond) ok += 1; else { fallo += 1; console.log('FALLA ', etq); }
  };

  const crearDiario = async (fecha: string, texto: string) => {
    const creado = await pedir('POST', `/proyecto-reportes/${P}`, {
      fecha, clima: 'Soleado', que_se_hizo: texto,
    });
    if (creado.estado !== 201) return null;
    const id = creado.cuerpo.data.id as number;
    await pedir('POST', `/proyecto-reportes/${P}/${id}/emitir`);
    return id;
  };

  // ---- los dos diarios nacen ANTES de que se cierre nada ----
  const enCerrada = await crearDiario(CERRADA, 'Colado de losa, semana que se cerrará');
  const enAbierta = await crearDiario(ABIERTA, 'Encofrado de columnas, semana abierta');
  c(enCerrada !== null && enAbierta !== null, 'se crean los dos reportes diarios de partida');

  // ---- se cierra la semana 37 ----
  const lunes = lunesDe(CERRADA);
  const iso = semanaIso(CERRADA);
  const semanal = await query<{ id: number }>(
    `INSERT INTO proyecto_reportes_semanales
       (proyecto_id, numero, semana_inicio, semana_fin, anio_iso, semana_iso,
        resumen, completo, enviado_at, creado_por)
     VALUES ($1, $2, $3, ($3::date + 6), $4, $5, $6, true, CURRENT_TIMESTAMP, $7)
     RETURNING id`,
    [P, 'RS-HUMO-260907', lunes, iso.anio, iso.semana, 'Resumen de prueba', admin.rows[0].id],
  );
  c(semanal.rows.length === 1, 'se registra el reporte semanal que cierra la semana 37');

  // ---- lo que ya NO se puede en la semana cerrada ----
  const corregir = await pedir('PUT', `/proyecto-reportes/${P}/${enCerrada}`, {
    que_se_hizo: 'Intento de corrección después del semanal',
  });
  c(corregir.estado === 409, `corregir un diario de la semana cerrada da 409 (dio ${corregir.estado})`);
  c(typeof corregir.cuerpo?.message === 'string'
    && corregir.cuerpo.message.includes('RS-HUMO-260907'),
    'y el mensaje nombra el reporte semanal que la cerró');

  const sinTocar = await query<{ que_se_hizo: string }>(
    'SELECT que_se_hizo FROM proyecto_reportes WHERE id = $1', [enCerrada]);
  c(!sinTocar.rows[0].que_se_hizo.startsWith('Intento'),
    'y el texto del diario se queda como estaba');

  const nuevoEnCerrada = await pedir('POST', `/proyecto-reportes/${P}`, {
    fecha: '2026-09-10', clima: 'Nublado', que_se_hizo: 'Un día que se le olvidó a alguien',
  });
  c(nuevoEnCerrada.estado === 409,
    `crear un diario con fecha de la semana cerrada da 409 (dio ${nuevoEnCerrada.estado})`);

  const borrar = await pedir('DELETE', `/proyecto-reportes/${P}/${enCerrada}`);
  c(borrar.estado === 409, `ni el admin lo elimina (dio ${borrar.estado})`);
  c((await query<{ activo: boolean }>(
    'SELECT activo FROM proyecto_reportes WHERE id = $1', [enCerrada])).rows[0].activo === true,
    'y el diario sigue activo');

  const quitarFoto = await pedir('DELETE', `/proyecto-reportes/${P}/${enCerrada}/fotos/999999`);
  c(quitarFoto.estado === 409 || quitarFoto.estado === 404,
    'quitarle una foto no abre la semana por la puerta de atrás');

  // Mover un diario de una semana abierta HACIA la cerrada tampoco vale: sería
  // meterle un día al reporte que ya salió por correo.
  const mudar = await pedir('PUT', `/proyecto-reportes/${P}/${enAbierta}`, {
    fecha: CERRADA,
  });
  c(mudar.estado === 409, `mover un diario a la semana cerrada da 409 (dio ${mudar.estado})`);

  // ---- y lo que SÍ se sigue pudiendo en la semana abierta ----
  const corregirAbierta = await pedir('PUT', `/proyecto-reportes/${P}/${enAbierta}`, {
    que_se_hizo: 'Corrección normal en una semana abierta',
  });
  c(corregirAbierta.estado === 200,
    `corregir un diario de una semana abierta sigue dando 200 (dio ${corregirAbierta.estado})`);

  const otroEnAbierta = await pedir('POST', `/proyecto-reportes/${P}`, {
    fecha: '2026-09-17', clima: 'Soleado', que_se_hizo: 'Otro día de la semana abierta',
  });
  c(otroEnAbierta.estado === 201,
    `y crear otro diario de esa semana sigue dando 201 (dio ${otroEnAbierta.estado})`);

  // ---- un semanal en BORRADOR no cierra nada ----
  await query('UPDATE proyecto_reportes_semanales SET completo = false WHERE id = $1',
    [semanal.rows[0].id]);
  const conBorrador = await pedir('PUT', `/proyecto-reportes/${P}/${enCerrada}`, {
    que_se_hizo: 'Corrección con el semanal todavía en borrador',
  });
  c(conBorrador.estado === 200,
    `con el semanal en borrador el diario se corrige (dio ${conBorrador.estado})`);

  console.log(`${ok} pasaron, ${fallo} fallaron`);
  await pool.end();
  process.exit(fallo ? 1 : 0);
};
main();
