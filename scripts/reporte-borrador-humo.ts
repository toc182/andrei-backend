// Prueba de humo del estado borrador, contra el servidor local.
// cd andrei-backend && npx tsx --env-file=.env scripts/reporte-borrador-humo.ts
//
// «Si las fotos no se suben, no hay reporte, punto» — la regla que decidio el
// dueno del producto el 2026-09-11. Un reporte recien creado es un borrador y
// NO existe para nadie hasta que /emitir lo completa.
//
// Lo que se comprueba aqui es que «no existe» es verdad en todas partes, y que
// un borrador abandonado no gasta numero: si lo gastara, el siguiente intento
// del ingeniero saldria como «-2», que es el sintoma del 2026-09-10.
//
// Borra en un finally todo lo que crea, incluidas las fotos de R2.
import jwt from 'jsonwebtoken';
import { query, pool } from '../src/database/config.js';
import { deleteFile } from '../src/services/storage.js';
import {
  barrerBorradoresAbandonados,
} from '../src/routes/proyectoReportes.js';
import { reservarPendientes, encolarEnvio } from '../src/services/reporteEnvio.js';

const API = 'http://localhost:5000/api';
const P = 1;
// Un mes sin ningun otro reporte: si se usara uno con reportes de verdad, el
// mes saldria en el desplegable por ellos y la comprobacion no probaria nada.
const FECHA = '2027-03-14';

const main = async () => {
  const u = await query<{ id: number; email: string; rol: string }>(
    "SELECT id, email, rol FROM users WHERE rol='admin' AND activo=true ORDER BY id LIMIT 1");
  const token = jwt.sign(
    { userId: u.rows[0].id, email: u.rows[0].email, rol: u.rows[0].rol },
    process.env.JWT_SECRET!, { expiresIn: '10m' });

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

  const crear = async (texto: string) => {
    const r = await pedir('POST', `/proyecto-reportes/${P}`, {
      fecha: FECHA, clima: 'Soleado', que_se_hizo: texto,
    });
    return r.cuerpo?.data?.id as number;
  };
  const enLista = async (id: number) => {
    const l = await pedir('GET', `/proyecto-reportes/${P}?limit=2000`);
    return (l.cuerpo?.data ?? []).some((r: { id: number }) => r.id === id);
  };
  const fila = async (id: number) =>
    (await query<{ numero: string | null; completo: boolean; activo: boolean }>(
      'SELECT numero, completo, activo FROM proyecto_reportes WHERE id = $1', [id])).rows[0];

  const creados: number[] = [];
  const claves: string[] = [];

  try {
    // ---- un borrador no existe para nadie ----
    const borrador = await crear('Borrador que se va a abandonar');
    creados.push(borrador);
    c(Number.isInteger(borrador), 'el alta devuelve un id');

    const f0 = await fila(borrador);
    c(f0.completo === false, 'nace incompleto');
    c(f0.numero === null, 'y SIN numero: un borrador no gasta numero');

    c(!(await enLista(borrador)), 'no sale en la lista');
    c((await pedir('GET', `/proyecto-reportes/${P}/${borrador}`)).estado === 404,
      'su detalle da 404');
    c((await pedir('GET', `/proyecto-reportes/${P}/${borrador}/pdf`)).estado === 404,
      'su PDF da 404');

    const meses = await pedir('GET', `/proyecto-reportes/${P}/meses`);
    c(!(meses.cuerpo?.data ?? []).includes(FECHA.slice(0, 7)),
      'no mete su mes en el desplegable de meses');

    const existe = await pedir('GET', `/proyecto-reportes/${P}/existe?fecha=${FECHA}`);
    c(!existe.cuerpo?.data?.ya_reportado,
      'no cuenta como «ya reportaste esta fecha» (si no, desanimaria de rehacerlo)');

    // ---- la cola de correo tampoco lo ve ----
    await encolarEnvio(borrador);
    const cola = await reservarPendientes();
    c(!cola.some((r) => r.id === borrador),
      'el cron NO lo saca de la cola: un borrador no puede salir por correo');
    await query('UPDATE proyecto_reportes SET envio_proximo_intento = NULL WHERE id = $1',
      [borrador]);

    // ---- las fotos SI se pueden subir mientras es borrador ----
    const foto = Buffer.from(
      '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
      'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
      'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64');
    const form = new FormData();
    form.append('fotos', new Blob([new Uint8Array(foto)], { type: 'image/jpeg' }), 'prueba.jpg');
    const subida = await fetch(`${API}/proyecto-reportes/${P}/${borrador}/fotos`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form,
    });
    const subidas = await subida.json().catch(() => null);
    c(subida.status === 201, `las fotos SI suben al borrador (dio ${subida.status})`);
    for (const f of subidas?.data ?? []) claves.push(f.r2_key);
    c(claves.length === 1, 'la foto quedo guardada');
    c(claves[0]?.includes(`/reportes/${borrador}/`),
      `la ruta en R2 lleva el ID, no el numero (es ${claves[0]})`);
    c(!claves[0]?.includes('/null/'),
      'y no cae en una carpeta «null» por no tener numero todavia');

    // ---- el borrador abandonado NO gasta numero ----
    const bueno = await crear('El reporte de verdad');
    creados.push(bueno);
    const emitido = await pedir('POST', `/proyecto-reportes/${P}/${bueno}/emitir`);
    c(emitido.estado === 200, 'emitir completa el reporte bueno');
    const numeroBueno = emitido.cuerpo?.data?.numero as string;
    c(typeof numeroBueno === 'string' && numeroBueno.length > 0,
      'y devuelve su numero');
    c(!numeroBueno.endsWith('-2'),
      `el borrador abandonado NO le quemo el numero (salio ${numeroBueno})`);

    const f1 = await fila(bueno);
    c(f1.completo === true, 'queda completo');
    c(f1.numero === numeroBueno, 'con el numero guardado en la fila');
    c(await enLista(bueno), 'y ahora SI sale en la lista');
    const meses2 = await pedir('GET', `/proyecto-reportes/${P}/meses`);
    c((meses2.cuerpo?.data ?? []).includes(FECHA.slice(0, 7)),
      'y su mes SI aparece ya en el desplegable: el filtro esconde, no borra');
    c((await pedir('GET', `/proyecto-reportes/${P}/${bueno}`)).estado === 200,
      'su detalle se abre');

    // ---- emitir dos veces no renumera ----
    const otra = await pedir('POST', `/proyecto-reportes/${P}/${bueno}/emitir`);
    c(otra.estado === 200, 'emitir de nuevo no falla');
    c((await fila(bueno)).numero === numeroBueno,
      'y NO le cambia el numero: completar es idempotente');

    // ---- un segundo reporte del mismo dia si lleva -2 ----
    const segundo = await crear('Segundo turno del mismo dia');
    creados.push(segundo);
    const num2 = (await pedir('POST', `/proyecto-reportes/${P}/${segundo}/emitir`))
      .cuerpo?.data?.numero as string;
    c(num2 === `${numeroBueno}-2`,
      `dos reportes completos del mismo dia si se numeran -2 (salio ${num2})`);

    // ---- corregir la fecha libera su numero, y nadie choca al reutilizarlo ----
    //
    // El PUT deja cambiar la fecha sin recalcular el numero. Antes, el numero
    // salia de CONTAR reportes de esa fecha, asi que al mover uno la cuenta
    // bajaba y el siguiente pedia un numero que ya existia: choque contra el
    // indice unico y «Error interno del servidor». Desde que se busca el primer
    // hueco libre en vez de contar, no puede pasar. Y ahora importaria mas,
    // porque el numero se asigna DESPUES de subir las fotos.
    await pedir('PUT', `/proyecto-reportes/${P}/${segundo}`, { fecha: '2027-03-20' });
    const tercero = await crear('Otro del dia original, con el numero ya liberado');
    creados.push(tercero);
    const r3 = await pedir('POST', `/proyecto-reportes/${P}/${tercero}/emitir`);
    c(r3.estado === 200,
      `completar tras mover una fecha NO revienta (dio ${r3.estado})`);
    const num3 = r3.cuerpo?.data?.numero as string;
    c(typeof num3 === 'string' && num3.length > 0,
      `y le da un numero libre (salio ${num3})`);
    c(num3 !== numeroBueno, 'que no es el del reporte que sigue ahi');

    // ---- el barrido se lleva los borradores viejos, no los de hoy ----
    const barridosAhora = await barrerBorradoresAbandonados();
    c((await fila(borrador)).activo === true,
      `un borrador de hace un rato NO se barre (barrio ${barridosAhora})`);

    await query(
      `UPDATE proyecto_reportes
          SET created_at = CURRENT_TIMESTAMP - INTERVAL '30 hours' WHERE id = $1`,
      [borrador]);
    await barrerBorradoresAbandonados();
    const fb = await fila(borrador);
    c(fb.activo === false, 'uno de hace mas de 24 horas si se da de baja');
    c(fb.completo === false, 'y sigue siendo borrador, no se destruye la fila');
  } finally {
    for (const k of claves) await deleteFile(k).catch(() => {});
    for (const id of creados) {
      await query('DELETE FROM audit_log WHERE entidad = $1 AND entidad_id = $2',
        ['reporte_diario', id]);
      await query('DELETE FROM proyecto_reportes WHERE id = $1', [id]);
    }
    const quedan = await query<{ n: string }>(
      'SELECT count(*) n FROM proyecto_reportes WHERE proyecto_id = $1 AND fecha = $2',
      [P, FECHA]);
    console.log(`limpiado: ${creados.length} reporte(s), ${claves.length} foto(s) de R2; quedan ${quedan.rows[0].n} de esa fecha`);
  }

  console.log(`${ok} pasaron, ${fallo} fallaron`);
  await pool.end();
  process.exit(fallo ? 1 : 0);
};
main();
