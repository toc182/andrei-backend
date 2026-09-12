// Prueba de humo de las filas del reporte (personal, equipo, entregas) contra
// el servidor local. Borra el reporte que ella misma crea.
import jwt from 'jsonwebtoken';
import { query, pool } from '../src/database/config.js';

const API = 'http://localhost:5000/api';
const P = 1;

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

  // Todo va dentro de try/finally. Antes la limpieza estaba solo al final del
  // camino feliz, y el 2026-09-11 la prueba revento a mitad y dejo dos
  // reportes en la base. Una prueba que se cae tiene que limpiar igual que
  // una que pasa.
  let id: number | undefined;
  try {
  const listas = (await pedir('GET', `/proyecto-listas/${P}`)).cuerpo.data;
  const puestos = listas.puestos as { id: number; nombre: string }[];
  const equipos = listas.equipos as { id: number; nombre: string }[];
  const cats = listas.categorias as { id: number; nombre: string }[];

  const creado = await pedir('POST', `/proyecto-reportes/${P}`, {
    fecha: '2026-09-10', clima: 'Soleado', que_se_hizo: 'Prueba de filas',
    personal: [
      { puesto_id: puestos[0].id, cantidad: 2 },
      { puesto_id: puestos[1].id, cantidad: 0 },   // cero: no debe guardarse
      { puesto_id: puestos[3].id, cantidad: 9 },
    ],
    equipos: [
      { equipo_id: equipos[0].id, unidades: 1, horas: 6 },
      { equipo_id: equipos[1].id, unidades: 0, horas: 0 }, // cero: no se guarda
    ],
    entregas: [
      { categoria_id: cats[0].id, descripcion: 'Varilla #5', cantidad: 2, unidad: 'ton' },
      { categoria_id: cats[2].id, descripcion: '', cantidad: 1 },  // sin texto: se salta
    ],
  });
  c(creado.estado === 201, 'crea el reporte');
  id = creado.cuerpo.data.id;

  // Desde el estado borrador, un reporte recien creado NO existe para nadie
  // hasta que /emitir lo completa. Sin esta llamada, todo lo que venga despues
  // recibe 404, que es exactamente lo que se busca.
  const completado = await pedir('POST', `/proyecto-reportes/${P}/${id}/emitir`);
  c(completado.estado === 200, 'emitir lo completa y le pone numero');
  c(typeof completado.cuerpo?.data?.numero === 'string',
    'y devuelve el numero que le acaba de asignar');

  const det = (await pedir('GET', `/proyecto-reportes/${P}/${id}`)).cuerpo.data;
  c(det.personal.length === 2, `personal guarda 2 filas y salta el cero (dio ${det.personal?.length})`);
  c(det.personal[0].nombre === puestos[0].nombre, 'la fila de personal trae el nombre del puesto');
  c(det.personal.every((f: { empresa_id: number | null }) => f.empresa_id === null), 'son del bloque propio');
  c(det.equipos.length === 1, `equipos guarda 1 fila y salta el cero (dio ${det.equipos?.length})`);
  c(Number(det.equipos[0].horas) === 6, 'las horas del equipo llegan bien');
  c(det.entregas.length === 1, `entregas guarda 1 y salta la vacia (dio ${det.entregas?.length})`);
  c(det.entregas[0].categoria === cats[0].nombre, 'la entrega trae el nombre de la categoria');

  // corregir SOLO las horas perdidas no debe tocar las filas
  await pedir('PUT', `/proyecto-reportes/${P}/${id}`, { horas_perdidas: 2 });
  const det2 = (await pedir('GET', `/proyecto-reportes/${P}/${id}`)).cuerpo.data;
  c(det2.personal.length === 2, 'una correccion parcial NO borra las filas de personal');
  c(det2.entregas.length === 1, 'una correccion parcial NO borra las entregas');

  // corregir mandando personal vacio si las borra
  await pedir('PUT', `/proyecto-reportes/${P}/${id}`, { personal: [] });
  const det3 = (await pedir('GET', `/proyecto-reportes/${P}/${id}`)).cuerpo.data;
  c(det3.personal.length === 0, 'mandar personal vacio si borra las filas');
  c(det3.equipos.length === 1, 'y no toca los equipos');

  // id de otro proyecto no cuela
  const ajeno = await query<{ id: number }>(
    'SELECT id FROM proyecto_puestos WHERE proyecto_id <> $1 LIMIT 1', [P]);
  await pedir('PUT', `/proyecto-reportes/${P}/${id}`, {
    personal: [{ puesto_id: ajeno.rows[0].id, cantidad: 5 }],
  });
  const det4 = (await pedir('GET', `/proyecto-reportes/${P}/${id}`)).cuerpo.data;
  c(det4.personal.length === 0, 'un puesto de otro proyecto no se cuela');

  // el rastro de correcciones tiene que ver los cambios de fila
  await pedir('PUT', `/proyecto-reportes/${P}/${id}`, {
    personal: [{ puesto_id: puestos[0].id, cantidad: 7 }],
  });
  const rastro = await query<{ detalles: { cambios?: Record<string, { label: string; antes: unknown; despues: unknown }> } }>(
    `SELECT detalles FROM audit_log
      WHERE entidad = 'reporte_diario' AND entidad_id = $1 AND accion = 'editar'
      ORDER BY created_at DESC LIMIT 1`, [id]);
  const cambios = rastro.rows[0]?.detalles?.cambios ?? {};
  const clave = `puesto:${puestos[0].id}`;
  c(!!cambios[clave], 'la correccion de una fila SI deja rastro');
  c(cambios[clave]?.label === puestos[0].nombre, 'el rastro dice de que puesto habla');
  c(Number(cambios[clave]?.despues) === 7, 'el rastro guarda el valor nuevo');

  } finally {
    if (id) await query('DELETE FROM proyecto_reportes WHERE id = $1', [id]);
  const quedan = await query('SELECT count(*) n FROM proyecto_reportes WHERE proyecto_id = $1', [P]);
  console.log('\nreportes del proyecto tras limpiar:', quedan.rows[0]);
  }

  console.log(`${ok} pasaron, ${fallo} fallaron`);
  await pool.end();
  process.exit(fallo ? 1 : 0);
};
main();
