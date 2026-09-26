// Prueba de humo: «Trabajo ejecutado» por areas.
// npm run pruebas -- reporte-trabajos
//
// Nace del 2026-09-25. Ivan: «uno escoge el área de trabajo, y luego se escribe
// qué se hizo en esa área». Cada punto lleva su area, o «General» (area_id
// null); varios de la misma area salen juntos.
//
// Se exige:
// - Un reporte nuevo guarda sus puntos en su orden, y no guarda el texto de
//   antes ni la lista de areas aparte.
// - Sin ningun punto con texto, no se guarda. Un area de otro proyecto o dada
//   de baja se rechaza con su motivo; nada se descarta en silencio.
// - Corregir un reporte enviado deja en Correcciones una linea por area, bajo
//   «Trabajo ejecutado · <area>»; guardar lo mismo no deja nada.
// - Un area quitada de la lista despues sigue valiendo en el reporte que ya la
//   tenia.
// - Los reportes de antes (texto y areas aparte) se siguen creando desde una
//   pagina vieja y se corrigen como estan; un borrador de antes pasa a puntos.
import { API } from './pruebas/contexto.js';
import jwt from 'jsonwebtoken';
import { query, pool } from '../src/database/config.js';
import type { CambioLegible } from '../src/services/reporteCambios.js';
import { armarHtml } from '../src/services/reportePdf.js';
import { buildReportePdfInput } from '../src/routes/proyectoReportes.js';
import { diariosDeLaSemana } from '../src/services/reporteSemanalIA.js';

const P = 1;
let dia = 10;
const fecha = () => `2027-07-${String(dia++).padStart(2, '0')}`;

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

  const plano = (l: CambioLegible[] = []) =>
    l.map((k) => `${k.etiqueta}: ${k.renglones
      .map((r) => r.map((t) => (t.tipo === 'quitado' ? `[-${t.texto}]`
        : t.tipo === 'agregado' ? `[+${t.texto}]` : t.texto)).join(' '))
      .join(' / ')}`).join(' | ');

  const area = async (nombre: string, proyecto = P) =>
    (await query<{ id: number }>(
      'SELECT id FROM proyecto_areas WHERE proyecto_id = $1 AND nombre = $2', [proyecto, nombre],
    )).rows[0].id;
  const A1 = await area('Área 1');
  const A2 = await area('Área 2');
  const A3 = await area('Área 3');

  const base = () => ({
    fecha: fecha(), clima: 'Soleado', horas_perdidas: null, motivo: null,
    atrasos: null, novedades: null,
  });
  const detalle = async (id: number) =>
    (await pedir('GET', `/proyecto-reportes/${P}/${id}`)).cuerpo?.data;
  const fila = async (id: number) =>
    (await query<{ que_se_hizo: string | null }>(
      'SELECT que_se_hizo FROM proyecto_reportes WHERE id = $1', [id])).rows[0];
  const areasAparte = async (id: number) =>
    Number((await query<{ n: string }>(
      'SELECT count(*) n FROM proyecto_reporte_areas WHERE reporte_id = $1', [id])).rows[0].n);
  const puntos = async (id: number) =>
    ((await detalle(id))?.trabajos ?? []).map(
      (t: { area_id: number | null; area_nombre: string | null; texto: string }) =>
        `${t.area_id === null ? 'General' : t.area_nombre}: ${t.texto}`,
    ).join(' | ');

  // ---- 1. un reporte nuevo, con puntos ----
  const TRABAJOS = [
    { area_id: A1, texto: 'Vaciado de 18 m³ de concreto, eje C a F.' },
    { area_id: A2, texto: 'Armado de acero de columnas.' },
    { area_id: A1, texto: '  Encofrado del tramo F-H.  ' },
    { area_id: null, texto: 'Limpieza general de la obra.' },
    { area_id: A2, texto: '   ' },
  ];
  const creado = await pedir('POST', `/proyecto-reportes/${P}`, { ...base(), trabajos: TRABAJOS });
  c(creado.estado === 201, `crea el borrador con puntos (dio ${creado.estado} ${creado.cuerpo?.message ?? ''})`);
  const id = creado.cuerpo.data.id as number;
  c((await fila(id)).que_se_hizo === null, 'no guarda el texto de antes');
  c(await areasAparte(id) === 0, 'ni la lista de areas aparte');

  const emitido = await pedir('POST', `/proyecto-reportes/${P}/${id}/emitir`);
  c(emitido.estado === 200, 'se envia');
  c(await puntos(id) === 'Área 1: Vaciado de 18 m³ de concreto, eje C a F. | Área 2: Armado de acero de columnas. '
    + '| Área 1: Encofrado del tramo F-H. | General: Limpieza general de la obra.',
    `guarda los puntos en su orden, sin el vacio y sin espacios de sobra (quedo ${await puntos(id)})`);

  // ---- 2. lo que no se guarda ----
  const sinNada = await pedir('POST', `/proyecto-reportes/${P}`, { ...base(), trabajos: [{ area_id: A1, texto: ' ' }] });
  c(sinNada.estado === 400 && sinNada.cuerpo?.message === 'Debes anotar al menos un trabajo ejecutado',
    `sin ningun punto con texto no se guarda (dio ${sinNada.estado} ${sinNada.cuerpo?.message})`);
  const sinLista = await pedir('POST', `/proyecto-reportes/${P}`, base());
  c(sinLista.estado === 400, 'sin puntos ni texto tampoco');

  const ajena = await query<{ id: number }>(
    "INSERT INTO proyecto_areas (proyecto_id, nombre, orden) VALUES (2, 'Área de otra obra', 1) RETURNING id");
  const conAjena = await pedir('POST', `/proyecto-reportes/${P}`, {
    ...base(), trabajos: [{ area_id: A1, texto: 'Bien.' }, { area_id: ajena.rows[0].id, texto: 'Colado.' }],
  });
  c(conAjena.estado === 400 && /ya no está en la lista/.test(conAjena.cuerpo?.message ?? ''),
    `un area de otro proyecto se rechaza, no se descarta (dio ${conAjena.estado} ${conAjena.cuerpo?.message})`);

  // ---- 3. corregir el enviado ----
  const K = 'clave-trabajos-01';
  const corregir = (trabajos: unknown) =>
    pedir('PUT', `/proyecto-reportes/${P}/${id}?correccion=${K}`, { trabajos });
  const correcciones = async () => ((await detalle(id))?.correcciones ?? []) as { cambios: CambioLegible[] }[];

  const mismo = await corregir(TRABAJOS);
  c(mismo.estado === 200 && (await correcciones()).length === 0, 'guardar lo mismo no deja linea');

  const nuevo = await corregir([
    { area_id: A1, texto: 'Vaciado de 18 m³ de concreto, eje C a F.' },
    { area_id: A1, texto: 'Encofrado del tramo F-H.' },
    { area_id: A1, texto: 'Curado de la losa.' },
    { area_id: A3, texto: 'Excavación para zapatas.' },
    { area_id: null, texto: 'Limpieza general de la obra.' },
  ]);
  c(nuevo.estado === 200, `la correccion se guarda (dio ${nuevo.estado} ${nuevo.cuerpo?.message ?? ''})`);
  const linea = plano((await correcciones())[0]?.cambios);
  c(linea === 'Trabajo ejecutado · Área 1: [+Curado de la losa.]'
    + ' | Trabajo ejecutado · Área 2: [-Armado de acero de columnas.]'
    + ' | Trabajo ejecutado · Área 3: [+Excavación para zapatas.]',
  `una linea por area que cambio, y nada de General (quedo «${linea}»)`);

  // ---- 4. un area quitada despues sigue valiendo donde ya estaba ----
  await query('UPDATE proyecto_areas SET activo = false WHERE id = $1', [A3]);
  const conQuitada = await corregir([
    { area_id: A3, texto: 'Excavación para zapatas, eje 4.' },
  ]);
  c(conQuitada.estado === 200, `un area dada de baja que el reporte ya tenia se puede volver a guardar (dio ${conQuitada.estado} ${conQuitada.cuerpo?.message ?? ''})`);
  const otroConQuitada = await pedir('POST', `/proyecto-reportes/${P}`, {
    ...base(), trabajos: [{ area_id: A3, texto: 'No.' }],
  });
  c(otroConQuitada.estado === 400, 'pero un reporte nuevo ya no la puede usar');
  await query('UPDATE proyecto_areas SET activo = true WHERE id = $1', [A3]);

  const textoViejo = await pedir('PUT', `/proyecto-reportes/${P}/${id}`, { que_se_hizo: 'Texto de antes.' });
  c(textoViejo.estado === 400 && (await fila(id)).que_se_hizo === null,
    'a un reporte con puntos no se le escribe el texto de antes');

  // ---- 5. los reportes de antes ----
  const viejo = await pedir('POST', `/proyecto-reportes/${P}`, {
    ...base(), que_se_hizo: 'Todo en un parrafo.', areas: [A1, A2],
  });
  c(viejo.estado === 201, 'una pagina de antes del cambio sigue pudiendo crear su reporte');
  const vid = viejo.cuerpo.data.id as number;
  await pedir('POST', `/proyecto-reportes/${P}/${vid}/emitir`);
  c((await fila(vid)).que_se_hizo === 'Todo en un parrafo.' && await areasAparte(vid) === 2,
    'con su texto y su lista de areas, como antes');
  const viejoCorregido = await pedir('PUT', `/proyecto-reportes/${P}/${vid}`, { que_se_hizo: 'Todo en un parrafo, corregido.' });
  c(viejoCorregido.estado === 200, 'el enviado de antes se corrige como esta');
  const viejoAPuntos = await pedir('PUT', `/proyecto-reportes/${P}/${vid}`, { trabajos: [{ area_id: A1, texto: 'No.' }] });
  c(viejoAPuntos.estado === 400 && (await puntos(vid)) === '',
    'y no se pasa a puntos: los viejos se quedan como se enviaron');

  const borradorViejo = await pedir('POST', `/proyecto-reportes/${P}`, {
    ...base(), que_se_hizo: 'Borrador a medias.', areas: [A2],
  });
  const bid = borradorViejo.cuerpo.data.id as number;
  const aPuntos = await pedir('PUT', `/proyecto-reportes/${P}/${bid}`, {
    trabajos: [{ area_id: null, texto: 'Borrador a medias.' }],
  });
  c(aPuntos.estado === 200, `un borrador de antes pasa a puntos (dio ${aPuntos.estado} ${aPuntos.cuerpo?.message ?? ''})`);
  c((await fila(bid)).que_se_hizo === null && await areasAparte(bid) === 0,
    'y deja de tener el texto y la lista de antes');

  // ---- 6. el papel ----
  // El HTML y no el PDF: el texto del PDF va dibujado y no se puede buscar.
  const html = async (rid: number) => armarHtml((await buildReportePdfInput(rid))!, [], '', 0);
  const nuevoHtml = await html(id);
  c(nuevoHtml.includes('Resumen del día') && !nuevoHtml.includes('Áreas de trabajo'),
    'un reporte por areas sale con «Resumen del día» y sin la lista de areas aparte');
  const orden = ['Trabajo ejecutado', 'Área 3', 'Excavación para zapatas, eje 4.', 'Novedades del día', 'Atrasos o impedimentos']
    .map((t) => nuevoHtml.indexOf(t));
  c(orden.every((i, k) => i >= 0 && (k === 0 || i > orden[k - 1])),
    `con el trabajo por area, despues Novedades y despues Atrasos (posiciones ${orden.join(', ')})`);
  const viejoHtml = await html(vid);
  c(viejoHtml.includes('Áreas de trabajo') && viejoHtml.includes('Todo en un parrafo, corregido.')
    && !viejoHtml.includes('Resumen del día'),
  'un reporte de antes sale como salia');

  const conGeneral = await pedir('POST', `/proyecto-reportes/${P}`, {
    ...base(), trabajos: [{ area_id: null, texto: 'Limpieza <b>general</b>.' }, { area_id: A1, texto: 'Vaciado.' }],
  });
  const gid = conGeneral.cuerpo.data.id as number;
  await pedir('POST', `/proyecto-reportes/${P}/${gid}/emitir`);
  const gHtml = await html(gid);
  c(gHtml.indexOf('>General<') >= 0 && gHtml.indexOf('>General<') < gHtml.indexOf('>Área 1<'),
    'General sale como un area mas, en el orden en que se escribio');
  c(gHtml.includes('Limpieza &lt;b&gt;general&lt;/b&gt;.'), 'y el texto va escapado');

  // ---- 7. la lista, la busqueda y el reporte semanal ----
  const lista = async (q = '') =>
    ((await pedir('GET', `/proyecto-reportes/${P}?limit=2000${q ? `&q=${encodeURIComponent(q)}` : ''}`))
      .cuerpo?.data ?? []) as { id: number; que_se_hizo: string | null; areas: string[] }[];
  const enLista = (await lista()).find((r) => r.id === gid);
  c(enLista?.que_se_hizo === 'General: Limpieza <b>general</b>.\nÁrea 1: Vaciado.',
    `la lista muestra el trabajo por areas como texto (dio ${JSON.stringify(enLista?.que_se_hizo)})`);
  c(JSON.stringify(enLista?.areas) === '["Área 1"]', `y sus areas son las de los puntos (dio ${JSON.stringify(enLista?.areas)})`);
  const viejoEnLista = (await lista()).find((r) => r.id === vid);
  c(viejoEnLista?.que_se_hizo === 'Todo en un parrafo, corregido.'
    && JSON.stringify(viejoEnLista?.areas) === '["Área 1","Área 2"]',
  'un reporte de antes sale en la lista como salia');
  c((await lista('zapatas')).some((r) => r.id === id), 'buscar el texto de un punto encuentra el reporte');
  c((await lista('Área 3')).some((r) => r.id === id), 'y buscar el nombre del area tambien');
  c(!(await lista('zapatas')).some((r) => r.id === gid), 'sin traer los que no lo dicen');

  const f = new Date(`${(await query<{ f: string }>(
    "SELECT to_char(fecha, 'YYYY-MM-DD') f FROM proyecto_reportes WHERE id = $1", [gid])).rows[0].f}T12:00:00`);
  f.setDate(f.getDate() - ((f.getDay() + 6) % 7));
  const lunes = `${f.getFullYear()}-${String(f.getMonth() + 1).padStart(2, '0')}-${String(f.getDate()).padStart(2, '0')}`;
  const numeroG = (await query<{ numero: string }>('SELECT numero FROM proyecto_reportes WHERE id = $1', [gid])).rows[0].numero;
  const diaG = (await diariosDeLaSemana(P, lunes)).find((d) => d.numero === numeroG);
  c(diaG?.que_se_hizo === 'General: Limpieza <b>general</b>.\nÁrea 1: Vaciado.'
    && JSON.stringify(diaG?.areas) === '["General","Área 1"]',
  `el reporte semanal le cuenta a la IA el trabajo por areas (dio ${JSON.stringify(diaG)})`);

  console.log(`${ok} pasaron, ${fallo} fallaron`);
  await pool.end();
  process.exit(fallo ? 1 : 0);
};
main();
