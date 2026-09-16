// Prueba de humo: el mismo guardado llega dos veces a la vez.
// cd andrei-backend && npx tsx --env-file=.env scripts/reporte-guardado-doble-humo.ts
//
// Nace del 2026-09-14, en produccion: a Ivan se le corto la subida de una foto
// desde el iPhone, le dio a Guardar otra vez, y llegaron DOS copias de ese PUT
// con 170 ms de diferencia (no pulso dos veces; lo mas probable es que el
// telefono lo repitiera solo). El servidor corrio las dos a la vez. Cada una
// borraba las areas del reporte y las volvia a escribir en pasos sueltos, sin
// transaccion: el segundo escribio encima del primero y revento contra
// proyecto_reporte_areas_pkey. «Error interno del servidor», y el reintento que
// debia arreglar la subida cortada fue el que fallo.
//
// Lo que se exige aqui: que el mismo guardado repetido a la vez no falle, no
// duplique filas —las entregas no tienen clave unica, asi que se habrian
// duplicado sin error— y deje una sola linea en el rastro de correcciones.
//
// La carrera no sale siempre a la primera, por eso se repite en varias rondas
// de varios PUT simultaneos. Borra en un finally todo lo que crea.
import { API } from './pruebas/contexto.js';
import jwt from 'jsonwebtoken';
import { query, pool } from '../src/database/config.js';

const P = 1;
const FECHA = '2027-04-18';
const RONDAS = 6;
const A_LA_VEZ = 8;

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

  const cuenta = async (tabla: string, id: number) =>
    Number((await query<{ n: string }>(
      `SELECT count(*) n FROM ${tabla} WHERE reporte_id = $1`, [id])).rows[0].n);

  let id: number | undefined;
  const areas = (await query<{ id: number }>(
    'SELECT id FROM proyecto_areas WHERE proyecto_id = $1 AND activo ORDER BY id LIMIT 2',
    [P])).rows.map((a) => a.id);
  const listas = (await pedir('GET', `/proyecto-listas/${P}`)).cuerpo.data;
  const puestos = listas.puestos as { id: number }[];
  const equipos = listas.equipos as { id: number }[];
  const cats = listas.categorias as { id: number }[];
  c(areas.length === 2 && puestos.length >= 2 && equipos.length >= 1 && cats.length >= 1,
    'el proyecto de prueba tiene areas, puestos, equipos y categorias');

  // Lo mismo que manda la pantalla: el cuerpo completo, todas las secciones.
  const cuerpo = (texto: string) => ({
    fecha: FECHA, clima: 'Soleado', que_se_hizo: texto,
    horas_perdidas: null, motivo: null, atrasos: null, novedades: null,
    areas,
    personal: [
      { puesto_id: puestos[0].id, cantidad: 3 },
      { puesto_id: puestos[1].id, cantidad: 5 },
    ],
    equipos: [{ equipo_id: equipos[0].id, unidades: 1, horas: 4 }],
    entregas: [
      { categoria_id: cats[0].id, descripcion: 'Cemento', cantidad: 20, unidad: 'sacos', notas: null },
      { categoria_id: cats[0].id, descripcion: 'Arena', cantidad: 2, unidad: 'm3', notas: null },
    ],
  });

  const creado = await pedir('POST', `/proyecto-reportes/${P}`, cuerpo('Texto original'));
  c(creado.estado === 201, 'crea el borrador');
  id = creado.cuerpo.data.id as number;

  for (let ronda = 1; ronda <= RONDAS; ronda += 1) {
    const texto = `Corregido en la ronda ${ronda}`;
    const antes = Number((await query<{ n: string }>(
      `SELECT count(*) n FROM audit_log
        WHERE entidad = 'reporte_diario' AND entidad_id = $1 AND accion = 'editar'`,
      [id])).rows[0].n);

    const respuestas = await Promise.all(
      Array.from({ length: A_LA_VEZ }, () =>
        pedir('PUT', `/proyecto-reportes/${P}/${id}`, cuerpo(texto))),
    );
    const estados = respuestas.map((r) => r.estado);

    c(estados.every((e) => e === 200),
      `ronda ${ronda}: los ${A_LA_VEZ} guardados iguales responden 200 (dieron ${estados.join(',')})`);
    c(await cuenta('proyecto_reporte_areas', id) === 2,
      `ronda ${ronda}: quedan 2 areas, ni mas ni menos`);
    c(await cuenta('proyecto_reporte_personal', id) === 2,
      `ronda ${ronda}: quedan 2 filas de personal`);
    c(await cuenta('proyecto_reporte_equipos', id) === 1,
      `ronda ${ronda}: queda 1 fila de equipo`);
    c(await cuenta('proyecto_reporte_entregas', id) === 2,
      `ronda ${ronda}: quedan 2 entregas, sin duplicar (hay ${await cuenta('proyecto_reporte_entregas', id)})`);

    const despues = Number((await query<{ n: string }>(
      `SELECT count(*) n FROM audit_log
        WHERE entidad = 'reporte_diario' AND entidad_id = $1 AND accion = 'editar'`,
      [id])).rows[0].n);
    c(despues - antes === 1,
      `ronda ${ronda}: el cambio deja UNA linea en el rastro, no una por copia (dejo ${despues - antes})`);
  }

  // Y lo que quedo es lo ultimo que se mando, completo.
  const fila = (await query<{ que_se_hizo: string }>(
    'SELECT que_se_hizo FROM proyecto_reportes WHERE id = $1', [id])).rows[0];
  c(fila.que_se_hizo === `Corregido en la ronda ${RONDAS}`, 'el texto guardado es el de la ultima ronda');

  console.log(`${ok} pasaron, ${fallo} fallaron`);
  await pool.end();
  process.exit(fallo ? 1 : 0);
};
main();
