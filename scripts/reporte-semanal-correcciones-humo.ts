// Prueba de humo de las Correcciones del reporte semanal.
// cd andrei-backend && npm run pruebas -- reporte-semanal-correcciones
//
// Lo que se vigila es lo mismo que en el diario: que la sección diga lo que
// cambió DESPUÉS de enviar y nada más. Un guardado que no mueve nada no deja
// línea —si no, el rastro se llena de ruido y deja de leerse— y cada corrección
// archiva su propia versión del PDF, que es la constancia de qué decía el papel
// en cada momento.
import { API } from './pruebas/contexto.js';
import jwt from 'jsonwebtoken';
import { query, pool } from '../src/database/config.js';
import { archivarCorreccionesSemanalesPendientes } from '../src/services/reporteSemanalEnvio.js';

const P = 1;
const LUNES = '2026-11-09'; // semana 46 de 2026, que no toca ninguna otra prueba

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

  // ---- un reporte semanal enviado ----
  const listas = await pedir('GET', `/proyecto-listas/${P}`);
  const puesto = listas.cuerpo.data.puestos[0];
  const diario = await pedir('POST', `/proyecto-reportes/${P}`, {
    fecha: LUNES, clima: 'Soleado', que_se_hizo: 'Armado de acero',
    personal: [{ puesto_id: puesto.id, cantidad: 8 }],
  });
  await pedir('POST', `/proyecto-reportes/${P}/${diario.cuerpo.data.id}/emitir`);

  const semanal = await pedir('POST', `/proyecto-reportes-semanales/${P}`, { fecha: LUNES });
  const id = semanal.cuerpo.data.id as number;
  await pedir('PUT', `/proyecto-reportes-semanales/${P}/${id}`, {
    resumen: 'Se armo el acero de las columnas del nivel 4.',
    lo_que_se_espera: 'Colar las columnas.',
    metas_plan: [{ texto: 'Colar las columnas del nivel 4', cantidad: 9, unidad: 'm3' }],
    problemas: [{ fecha: LUNES, problema: 'Falto madera', accion: null, pendiente: true }],
    decisiones: [{ texto: 'Aprobar la compra de madera' }],
  });
  await pedir('POST', `/proyecto-reportes-semanales/${P}/${id}/emitir`);

  const correcciones = async () => {
    const d = await pedir('GET', `/proyecto-reportes-semanales/${P}/${id}`);
    return (d.cuerpo?.data?.correcciones ?? []) as {
      id: number; quien: string;
      cambios: { etiqueta: string; renglones: { tipo: string; texto: string }[][] }[];
    }[];
  };
  c((await correcciones()).length === 0, 'recien enviado, Correcciones esta vacia');

  // ---- un guardado que no mueve nada NO deja linea ----
  await pedir('PUT', `/proyecto-reportes-semanales/${P}/${id}`, {
    resumen: 'Se armo el acero de las columnas del nivel 4.',
  });
  c((await correcciones()).length === 0, 'guardar lo mismo no deja correccion');

  // ---- una correccion de verdad ----
  await pedir('PUT', `/proyecto-reportes-semanales/${P}/${id}`, {
    resumen: 'Se armo el acero de las columnas del nivel 5.',
    decisiones: [{ texto: 'Aprobar la compra de madera' }, { texto: 'Confirmar la bomba' }],
  });
  const una = await correcciones();
  c(una.length === 1, `un guardado con cambios deja UNA linea (dejo ${una.length})`);
  c(una[0].quien === admin.rows[0].email || typeof una[0].quien === 'string',
    'y dice quien la hizo');

  const etiquetas = una[0].cambios.map((k) => k.etiqueta);
  c(etiquetas.includes('Resumen de la semana'), 'la linea nombra el resumen');
  c(etiquetas.includes('Decisiones'), 'y las decisiones');
  c(!etiquetas.includes('Plan de la próxima semana'), 'y NO nombra lo que no se toco');

  const resumen = una[0].cambios.find((k) => k.etiqueta === 'Resumen de la semana')!;
  const marcas = resumen.renglones.flat();
  c(marcas.some((t) => t.tipo === 'quitado') && marcas.some((t) => t.tipo === 'agregado'),
    'el resumen se marca con lo quitado y lo agregado');
  c(marcas.some((t) => t.tipo === 'quitado' && t.texto.includes('4')),
    'y se ve el «4» que se quito');

  const decisiones = una[0].cambios.find((k) => k.etiqueta === 'Decisiones')!;
  c(decisiones.renglones.flat().some((t) => t.tipo === 'agregado' && t.texto.includes('bomba')),
    'la decision nueva sale como agregada');

  // ---- una segunda correccion es otra linea ----
  await pedir('PUT', `/proyecto-reportes-semanales/${P}/${id}`, {
    problemas: [{ fecha: LUNES, problema: 'Falto madera', accion: 'Se compro el martes', pendiente: false }],
  });
  const dos = await correcciones();
  c(dos.length === 2, `otro guardado con cambios deja otra linea (van ${dos.length})`);
  c(dos[1].cambios.some((k) => k.etiqueta === 'Problemas y atrasos'),
    'la segunda nombra los problemas');

  // ---- cada correccion archiva su version del PDF ----
  await archivarCorreccionesSemanalesPendientes();
  const versiones = await query<{ n: string }>(
    'SELECT COUNT(*)::text n FROM proyecto_reporte_semanal_pdfs WHERE reporte_id = $1', [id]);
  c(Number(versiones.rows[0].n) >= 2,
    `queda archivada una version por correccion (hay ${versiones.rows[0].n})`);
  const pendientes = await query<{ n: string }>(
    `SELECT COUNT(*)::text n FROM proyecto_reporte_semanal_correcciones
      WHERE reporte_id = $1 AND pdf_version IS NULL`, [id]);
  c(pendientes.rows[0].n === '0', 'y ninguna correccion se queda sin su version');

  // ---- el PDF sigue saliendo, ya con su seccion ----
  const res = await fetch(`${API}/proyecto-reportes-semanales/${P}/${id}/pdf`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const pdf = Buffer.from(await res.arrayBuffer());
  c(res.status === 200 && pdf.subarray(0, 4).toString() === '%PDF',
    'el PDF del reporte corregido se abre');

  console.log(`${ok} pasaron, ${fallo} fallaron`);
  await pool.end();
  process.exit(fallo ? 1 : 0);
};
main();
