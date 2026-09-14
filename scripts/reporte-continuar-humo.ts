// Prueba de humo: seguir un reporte que no llego a enviarse, y descartarlo.
// cd andrei-backend && npx tsx --env-file=.env scripts/reporte-continuar-humo.ts
//
// Nace del 2026-09-14: el ingeniero Cesar lleno un reporte en Playa Blanca, una
// foto paso de 10 MB, el envio fallo y salio del formulario. Todo lo que habia
// escrito estaba guardado en el servidor como borrador, pero ninguna pantalla lo
// podia mostrar, asi que para el se habia perdido.
//
// Se exige:
// - GET /:proyectoId/borrador devuelve el borrador MAS RECIENTE de quien pregunta
//   en ese proyecto, completo —texto, areas, filas y fotos con su url—, y nunca
//   el de otra persona ni un reporte ya enviado ni uno descartado.
// - DELETE /:proyectoId/:id/borrador lo da de baja (activo = false) y no puede
//   tocar un reporte enviado.
// - Las fotos de hasta 15 MB se aceptan; las de mas, se rechazan diciendo 15 MB.
//
// Borra en un finally todo lo que crea, incluidas las fotos de R2.
import jwt from 'jsonwebtoken';
import { query, pool } from '../src/database/config.js';
import { deleteFile } from '../src/services/storage.js';
import { claveReducida } from '../src/services/reportePdf.js';

const API = 'http://localhost:5000/api';
const P = 1;
const FECHA = '2027-05-09';
const MB = 1024 * 1024;

const main = async () => {
  const u = await query<{ id: number; email: string; rol: string }>(
    "SELECT id, email, rol FROM users WHERE rol='admin' AND activo=true ORDER BY id LIMIT 1");
  const yo = u.rows[0];
  const token = jwt.sign(
    { userId: yo.id, email: yo.email, rol: yo.rol },
    process.env.JWT_SECRET!, { expiresIn: '10m' });
  const otro = (await query<{ id: number }>(
    'SELECT id FROM users WHERE activo = true AND id <> $1 ORDER BY id LIMIT 1', [yo.id])).rows[0].id;

  const pedir = async (m: string, r: string, b?: unknown) => {
    const res = await fetch(`${API}${r}`, {
      method: m,
      headers: { Authorization: `Bearer ${token}`, ...(b ? { 'Content-Type': 'application/json' } : {}) },
      ...(b ? { body: JSON.stringify(b) } : {}),
    });
    return { estado: res.status, cuerpo: await res.json().catch(() => null) };
  };
  const subir = async (id: number, bytes: number, nombre: string) => {
    const form = new FormData();
    form.append('fotos', new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }), nombre);
    const res = await fetch(`${API}/proyecto-reportes/${P}/${id}/fotos`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form,
    });
    return { estado: res.status, cuerpo: await res.json().catch(() => null) };
  };

  let ok = 0; let fallo = 0;
  const c = (cond: boolean, etq: string) => {
    if (cond) ok += 1; else { fallo += 1; console.log('FALLA ', etq); }
  };

  const creados: number[] = [];
  const claves: string[] = [];

  try {
    const areas = (await query<{ id: number }>(
      'SELECT id FROM proyecto_areas WHERE proyecto_id = $1 AND activo ORDER BY id LIMIT 2',
      [P])).rows.map((a) => a.id);
    const listas = (await pedir('GET', `/proyecto-listas/${P}`)).cuerpo.data;
    const puesto = (listas.puestos as { id: number }[])[0].id;
    const cat = (listas.categorias as { id: number }[])[0].id;

    // Sin nada a medias, no hay nada que ofrecer.
    const nada = await pedir('GET', `/proyecto-reportes/${P}/borrador`);
    c(nada.estado === 200, `la consulta responde 200 aunque no haya borrador (dio ${nada.estado})`);
    c(nada.cuerpo?.data === null, 'y devuelve null');

    // Uno viejo y uno nuevo, los dos mios.
    const crear = async (texto: string) => {
      const r = await pedir('POST', `/proyecto-reportes/${P}`, {
        fecha: FECHA, clima: 'Nublado', que_se_hizo: texto, atrasos: 'Llovio a mediodia',
        areas,
        personal: [{ puesto_id: puesto, cantidad: 4 }],
        equipos: [],
        entregas: [{ categoria_id: cat, descripcion: 'Tubo PVC 8"', cantidad: 12, unidad: 'u', notas: null }],
      });
      const id = r.cuerpo?.data?.id as number;
      creados.push(id);
      return id;
    };
    const viejo = await crear('El que empezo primero');
    await query(
      "UPDATE proyecto_reportes SET updated_at = CURRENT_TIMESTAMP - INTERVAL '2 hours' WHERE id = $1",
      [viejo]);
    const nuevo = await crear('Colocacion de tuberia en el tramo 3');

    // Uno de otra persona, mas reciente todavia: no debe salir.
    const ajeno = (await query<{ id: number }>(
      `INSERT INTO proyecto_reportes (proyecto_id, numero, completo, fecha, clima, que_se_hizo, creado_por)
       VALUES ($1, NULL, false, $2, 'Soleado', 'Borrador de otra persona', $3) RETURNING id`,
      [P, FECHA, otro])).rows[0].id;
    creados.push(ajeno);

    const foto = await subir(nuevo, 2048, 'tramo3.jpg');
    c(foto.estado === 201, `sube una foto al borrador (dio ${foto.estado})`);
    for (const f of foto.cuerpo?.data ?? []) claves.push(f.r2_key);

    const b = await pedir('GET', `/proyecto-reportes/${P}/borrador`);
    const d = b.cuerpo?.data;
    c(d?.id === nuevo, `devuelve el borrador mas reciente MIO (dio ${d?.id}; el mio nuevo es ${nuevo}, el ajeno ${ajeno})`);
    c(d?.que_se_hizo === 'Colocacion de tuberia en el tramo 3', 'con el texto que escribio');
    c(d?.atrasos === 'Llovio a mediodia', 'y los atrasos');
    c(d?.clima === 'Nublado', 'y el clima');
    c(String(d?.fecha ?? '').slice(0, 10) === FECHA, `y la fecha (dio ${d?.fecha})`);
    c(Array.isArray(d?.areas) && d.areas.length === 2 && d.areas.every((a: { id: number }) => areas.includes(a.id)),
      'con sus areas');
    c(d?.personal?.length === 1 && Number(d.personal[0].cantidad) === 4, 'con su personal');
    c(d?.entregas?.length === 1 && d.entregas[0].descripcion === 'Tubo PVC 8"', 'con sus entregas');
    c(d?.fotos?.length === 1 && typeof d.fotos[0].url === 'string' && d.fotos[0].url.length > 0,
      'y con la foto ya subida, con una url para verla');

    // Un reporte ya enviado deja de ser borrador.
    await query(
      "UPDATE proyecto_reportes SET completo = true, numero = 'PRUEBA-CONT-1' WHERE id = $1", [nuevo]);
    const tras = await pedir('GET', `/proyecto-reportes/${P}/borrador`);
    c(tras.cuerpo?.data?.id === viejo,
      `enviado el nuevo, ofrece el siguiente borrador mio, no el enviado (dio ${tras.cuerpo?.data?.id})`);

    // Descartar un reporte enviado no se puede.
    const noEnviado = await pedir('DELETE', `/proyecto-reportes/${P}/${nuevo}/borrador`);
    c(noEnviado.estado === 404, `descartar un reporte ya enviado da 404 (dio ${noEnviado.estado})`);
    const sigue = (await query<{ activo: boolean }>(
      'SELECT activo FROM proyecto_reportes WHERE id = $1', [nuevo])).rows[0];
    c(sigue.activo === true, 'y el enviado sigue activo');

    // Descartar el borrador lo da de baja, sin borrar la fila.
    const desc = await pedir('DELETE', `/proyecto-reportes/${P}/${viejo}/borrador`);
    c(desc.estado === 200, `descartar mi borrador responde 200 (dio ${desc.estado})`);
    const fila = (await query<{ activo: boolean }>(
      'SELECT activo FROM proyecto_reportes WHERE id = $1', [viejo])).rows[0];
    c(fila?.activo === false, 'queda dado de baja, la fila no se destruye');
    const rastro = await query(
      `SELECT 1 FROM audit_log WHERE entidad = 'reporte_diario' AND entidad_id = $1 AND accion = 'descartar'`,
      [viejo]);
    c(rastro.rows.length === 1, 'y deja rastro');
    const yaNo = await pedir('GET', `/proyecto-reportes/${P}/borrador`);
    c(yaNo.cuerpo?.data === null, `ya no se ofrece nada (dio ${yaNo.cuerpo?.data?.id})`);

    // El limite de 15 MB, a los dos lados del borde.
    const limite = await crear('Para probar el tamano de las fotos');
    const cabe = await subir(limite, Math.floor(14.5 * MB), 'grande.jpg');
    c(cabe.estado === 201, `una foto de 14,5 MB se acepta (dio ${cabe.estado}: ${cabe.cuerpo?.message ?? ''})`);
    for (const f of cabe.cuerpo?.data ?? []) claves.push(f.r2_key);
    const noCabe = await subir(limite, Math.floor(15.5 * MB), 'enorme.jpg');
    c(noCabe.estado === 400, `una de 15,5 MB se rechaza (dio ${noCabe.estado})`);
    c(noCabe.cuerpo?.message === 'Cada foto debe pesar menos de 15 MB',
      `diciendo el limite nuevo (dijo «${noCabe.cuerpo?.message}»)`);
  } finally {
    for (const k of claves) {
      await deleteFile(k).catch(() => {});
      await deleteFile(claveReducida(k)).catch(() => {});
    }
    for (const id of creados) {
      await query('DELETE FROM audit_log WHERE entidad = $1 AND entidad_id = $2', ['reporte_diario', id]);
      await query('DELETE FROM proyecto_reportes WHERE id = $1', [id]);
    }
    const quedan = await query<{ n: string }>(
      'SELECT count(*) n FROM proyecto_reportes WHERE proyecto_id = $1 AND fecha = $2', [P, FECHA]);
    console.log(`limpiado: ${creados.length} reporte(s), ${claves.length} foto(s) de R2; quedan ${quedan.rows[0].n} de esa fecha`);
  }

  console.log(`${ok} pasaron, ${fallo} fallaron`);
  await pool.end();
  process.exit(fallo ? 1 : 0);
};
main();
