// Prueba de humo de la lista de reportes diarios, que se pide de a una página.
//
// Corre contra la base desechable y su servidor propio: npm run pruebas -- reporte-lista
//
// Desde el 2026-10-01 la pantalla abre en los últimos reportes y no en el mes en
// curso: el primero de octubre, Lilia abrió Santa Isabel y vio una lista vacía.
// Abrir en «todos» obligó a paginar en el servidor —si no, la pantalla bajaría el
// proyecto entero cada vez— y con la paginación se mudaron al servidor el orden y
// los filtros del encabezado. Esto comprueba que las páginas no se pisan ni se
// saltan filas, que un mes sale entero, y que los filtros y sus valores dicen la
// verdad sobre TODO el proyecto, no solo sobre la página cargada.
//
// Los reportes se siembran directo en la base: lo que se prueba es la lectura.
// Lo que cree se va con la base al terminar.
//
// El import de la guardia va primero: si esto no apunta a una base de pruebas,
// el proceso se muere antes de la primera consulta.
import { API } from './pruebas/contexto.js';
import jwt from 'jsonwebtoken';
import { query, pool } from '../src/database/config.js';

const P = 1;
const OTRO = 2;
const CLIMAS = ['Soleado', 'Nublado', 'Lluvia parcial', 'Lluvia todo el día'];

interface Fila { id: number; numero: string; fecha: string; clima: string; creador_nombre: string }
interface Lista {
  data: Fila[];
  total: number;
  filtros: { creador_nombre: string[]; clima: string[] };
}

const main = async () => {
  const admin = await query<{ id: number; email: string; rol: string }>(
    "SELECT id, email, rol FROM users WHERE rol='admin' AND activo=true ORDER BY id LIMIT 1");
  const token = jwt.sign(
    { userId: admin.rows[0].id, email: admin.rows[0].email, rol: admin.rows[0].rol },
    process.env.JWT_SECRET!, { expiresIn: '10m' });
  const pedir = async (params: Record<string, string | number> = {}, proyecto = P) => {
    const qs = new URLSearchParams(
      Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
    const res = await fetch(`${API}/proyecto-reportes/${proyecto}${qs ? `?${qs}` : ''}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return { estado: res.status, cuerpo: (await res.json().catch(() => null)) as Lista };
  };

  let ok = 0; let fallo = 0;
  const c = (cond: boolean, etq: string) => {
    if (cond) ok += 1; else { fallo += 1; console.log('FALLA ', etq); }
  };

  // ---- la siembra ----
  // Tres autores con reportes enviados, julio a septiembre, más un cuarto que
  // solo tiene un borrador y uno dado de baja: no puede aparecer en ninguna
  // parte de la lista, ni siquiera como opción del filtro.
  const usuarios = await query<{ id: number; nombre: string }>(
    "SELECT id, nombre FROM users WHERE email LIKE 'aprobador%@pruebas.local' ORDER BY email");
  const autores = [admin.rows[0].id, usuarios.rows[0].id, usuarios.rows[1].id];
  const fantasma = usuarios.rows[3];
  const N = 60;
  for (let i = 0; i < N; i += 1) {
    const fecha = new Date(Date.UTC(2026, 6, 1) + Math.floor(i * 1.5) * 864e5)
      .toISOString().slice(0, 10);
    await query(
      `INSERT INTO proyecto_reportes (proyecto_id, numero, fecha, clima, que_se_hizo, creado_por)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [P, `RD-LISTA-${i}`, fecha, CLIMAS[i % 4],
        i % 7 === 0 ? 'Vaciado de la losa del tanque' : 'Trabajo del día', autores[i % 3]]);
  }
  await query(
    `INSERT INTO proyecto_reportes (proyecto_id, numero, fecha, clima, que_se_hizo, creado_por, completo)
     VALUES ($1, 'RD-LISTA-BORRADOR', '2026-09-30', 'Soleado', 'A medias', $2, false)`,
    [P, fantasma.id]);
  await query(
    `INSERT INTO proyecto_reportes (proyecto_id, numero, fecha, clima, que_se_hizo, creado_por, activo)
     VALUES ($1, 'RD-LISTA-BAJA', '2026-09-30', 'Soleado', 'De baja', $2, false)`,
    [P, fantasma.id]);
  await query(
    `INSERT INTO proyecto_reportes (proyecto_id, numero, fecha, clima, que_se_hizo, creado_por)
     VALUES ($1, 'RD-LISTA-OTRO', '2026-09-30', 'Soleado', 'De otro proyecto', $2)`,
    [OTRO, autores[0]]);

  // Lo que la base dice que hay, para comparar contra la API.
  const verdad = await query<{ id: number; fecha: string; clima: string; nombre: string }>(
    `SELECT r.id, to_char(r.fecha, 'YYYY-MM-DD') AS fecha, r.clima, u.nombre
       FROM proyecto_reportes r JOIN users u ON u.id = r.creado_por
      WHERE r.proyecto_id = $1 AND r.activo AND r.completo
      ORDER BY r.fecha DESC, r.id DESC`, [P]);
  const todos = verdad.rows;
  const nombres = [...new Set(todos.map((r) => r.nombre))].sort();
  const fechaDe = (f: Fila) => String(f.fecha).slice(0, 10);

  // ---- al abrir: los 25 más recientes ----
  const abre = await pedir();
  c(abre.estado === 200, `la lista responde (dio ${abre.estado})`);
  c(abre.cuerpo.data.length === 25, `trae 25 (trajo ${abre.cuerpo.data.length})`);
  c(abre.cuerpo.total === todos.length, `el total es el del proyecto (${abre.cuerpo.total} vs ${todos.length})`);
  c(abre.cuerpo.data.map((f) => f.id).join() === todos.slice(0, 25).map((r) => r.id).join(),
    'son los 25 más recientes, en orden');
  c(!abre.cuerpo.data.some((f) => f.creador_nombre === fantasma.nombre),
    'ni el borrador ni el dado de baja salen en la lista');
  c(JSON.stringify(abre.cuerpo.filtros.creador_nombre) === JSON.stringify(nombres),
    `el filtro de autor ofrece los tres que reportaron, y no al del borrador (${abre.cuerpo.filtros.creador_nombre})`);
  c(JSON.stringify([...abre.cuerpo.filtros.clima].sort()) === JSON.stringify([...CLIMAS].sort()),
    'el filtro de clima ofrece los cuatro');

  // ---- las páginas no se pisan ni se saltan filas ----
  const vistos: number[] = [];
  for (let offset = 0; offset < todos.length; offset += 25) {
    const pag = await pedir({ limit: 25, offset });
    vistos.push(...pag.cuerpo.data.map((f) => f.id));
  }
  c(vistos.join() === todos.map((r) => r.id).join(),
    'recorrer las páginas da cada reporte una vez, en orden');
  const despues = await pedir({ limit: 25, offset: 1000 });
  c(despues.cuerpo.data.length === 0 && despues.cuerpo.total === todos.length,
    'pasada la última página no hay filas, y el total no cambia');

  // ---- un mes sale entero ----
  const agosto = todos.filter((r) => r.fecha.startsWith('2026-08'));
  const mes = await pedir({ mes: '2026-08', limit: 2000 });
  c(mes.cuerpo.data.length === agosto.length && mes.cuerpo.total === agosto.length,
    `agosto sale entero (${mes.cuerpo.data.length} de ${agosto.length})`);
  c(mes.cuerpo.data.every((f) => fechaDe(f).startsWith('2026-08')), 'y solo agosto');
  c(mes.cuerpo.data.some((f) => fechaDe(f) === '2026-08-01')
    && mes.cuerpo.data.some((f) => fechaDe(f) === '2026-08-31'),
    'con el primero y el último día del mes');
  for (const malo of ['2026-13', 'agosto', '2026-8']) {
    c((await pedir({ mes: malo })).estado === 400, `un mes que no existe («${malo}») se rechaza`);
  }

  // ---- los filtros del encabezado miran todo el proyecto ----
  const soleados = todos.filter((r) => r.clima === 'Soleado');
  const sol = await pedir({ clima: JSON.stringify(['Soleado']) });
  c(sol.cuerpo.total === soleados.length, `filtrar Soleado cuenta todos los soleados (${sol.cuerpo.total} vs ${soleados.length})`);
  c(sol.cuerpo.data.every((f) => f.clima === 'Soleado'), 'y solo trae soleados');
  c(sol.cuerpo.filtros.clima.length === 4,
    'el filtro de clima sigue ofreciendo los cuatro: su propio filtro no lo recorta');
  c(JSON.stringify(sol.cuerpo.filtros.creador_nombre)
    === JSON.stringify([...new Set(soleados.map((r) => r.nombre))].sort()),
    'el de autor ofrece solo quien tiene días soleados');

  const ninguno = await pedir({ clima: '[]' });
  c(ninguno.cuerpo.data.length === 0 && ninguno.cuerpo.total === 0,
    'desmarcar todos los climas no deja ninguna fila');
  c(ninguno.cuerpo.filtros.clima.length === 4, 'pero el filtro de clima sigue ofreciendo los cuatro');

  const uno = nombres[0];
  const deUno = todos.filter((r) => r.nombre === uno && r.clima === 'Nublado');
  const ambos = await pedir({ autor: JSON.stringify([uno]), clima: JSON.stringify(['Nublado']) });
  c(ambos.cuerpo.total === deUno.length && ambos.cuerpo.data.every(
    (f) => f.creador_nombre === uno && f.clima === 'Nublado'),
  'autor y clima juntos se cumplen los dos');

  for (const malo of ['Soleado', '{"a":1}', '[1,2]']) {
    c((await pedir({ clima: malo })).estado === 400, `un filtro que no es lista de textos («${malo}») se rechaza`);
  }

  // ---- el orden del encabezado ----
  const porNombre = await pedir({ orden: 'creador_nombre', dir: 'asc', limit: 2000 });
  const pn = porNombre.cuerpo.data;
  c(pn.every((f, i) => i === 0
    || pn[i - 1].creador_nombre.toLowerCase() < f.creador_nombre.toLowerCase()
    || (pn[i - 1].creador_nombre === f.creador_nombre && fechaDe(pn[i - 1]) >= fechaDe(f))),
  'por autor, de la A a la Z, y lo empatado del más reciente al más viejo');
  const viejos = await pedir({ orden: 'fecha', dir: 'asc' });
  c(viejos.cuerpo.data[0].id === todos[todos.length - 1].id, 'por fecha ascendente abre en el más viejo');
  const raro = await pedir({ orden: 'r.id; DROP TABLE users', dir: 'asc' });
  c(raro.estado === 200 && raro.cuerpo.data[0].id === todos[0].id,
    'una columna que no está en la lista se ignora y queda el orden de siempre');

  // ---- la búsqueda pagina igual ----
  const busq = await pedir({ q: 'losa del tanque', limit: 5 });
  const conLosa = await query<{ n: string }>(
    `SELECT count(*)::text n FROM proyecto_reportes
      WHERE proyecto_id = $1 AND activo AND completo AND que_se_hizo ILIKE '%losa del tanque%'`, [P]);
  c(Number(conLosa.rows[0].n) > 5 && busq.cuerpo.total === Number(conLosa.rows[0].n) && busq.cuerpo.data.length === 5,
    `buscar cuenta todas las coincidencias aunque traiga una página (${busq.cuerpo.total})`);

  // ---- el otro proyecto no se mezcla ----
  const otro = await pedir({}, OTRO);
  c(otro.cuerpo.total === 1 && otro.cuerpo.data[0].numero === 'RD-LISTA-OTRO',
    'el otro proyecto solo ve el suyo');
  c(!vistos.includes(otro.cuerpo.data[0].id), 'y el suyo no sale en este');

  console.log(`${ok} pasaron, ${fallo} fallaron`);
  await pool.end();
  process.exit(fallo ? 1 : 0);
};
main();
