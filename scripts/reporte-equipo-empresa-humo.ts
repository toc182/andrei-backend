// Prueba de humo del equipo por empresa en el reporte diario.
// cd andrei-backend && npm run pruebas -- reporte-equipo-empresa
//
// Decisión de Ivan del 2026-09-28: cada máquina dice de quién es, como cada
// puesto de Personal. Lo que esta prueba cuida es que el dueño llegue a todos
// los lados: el detalle con sus siglas, el PDF, y el semanal, donde la
// retroexcavadora del propio y la de un subcontratista NO se suman en una.
import { API } from './pruebas/contexto.js';
import jwt from 'jsonwebtoken';
import { query, pool } from '../src/database/config.js';
import { datosDeLaSemana } from '../src/services/reporteSemanalDatos.js';

const P = 1;
// Una semana que ninguna otra prueba toca.
const FECHA = '2026-11-03';

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
    const tipo = res.headers.get('content-type') ?? '';
    return {
      estado: res.status,
      tipo,
      cuerpo: tipo.includes('json') ? await res.json().catch(() => null) : null,
    };
  };

  let ok = 0; let fallo = 0;
  const c = (cond: boolean, etq: string) => {
    if (cond) ok += 1; else { fallo += 1; console.log('FALLA ', etq); }
  };

  // ---- una empresa, y una retroexcavadora del propio y otra suya ----
  const emp = await pedir('POST', `/proyecto-listas/${P}/empresas`, { nombre: 'Hermanos Rodríguez, S.A.' });
  const empId = emp.cuerpo.data.id as number;
  // La semilla ya trae una «Retroexcavadora» del propio; la empresa agrega la suya.
  const suya = await pedir('POST', `/proyecto-listas/${P}/equipos`, { nombre: 'Retroexcavadora', empresa_id: empId });
  c(suya.estado === 201, `la empresa agrega su retroexcavadora aunque el propio tenga una (dio ${suya.estado})`);

  const listas = await pedir('GET', `/proyecto-listas/${P}`);
  const propiaId = listas.cuerpo.data.equipos.find(
    (x: { empresa_id: number | null; nombre: string }) =>
      x.empresa_id === null && x.nombre === 'Retroexcavadora').id as number;
  const puestoPropio = listas.cuerpo.data.puestos.find(
    (x: { empresa_id: number | null; nombre: string }) => x.empresa_id === null && x.nombre === 'Ayudantes');
  const puestoSuyo = listas.cuerpo.data.puestos.find(
    (x: { empresa_id: number | null; nombre: string }) => x.empresa_id === empId && x.nombre === 'Ayudantes');

  // ---- un reporte con las dos ----
  const creado = await pedir('POST', `/proyecto-reportes/${P}`, {
    fecha: FECHA, clima: 'Soleado', que_se_hizo: 'Excavación de zanja',
    personal: [
      { puesto_id: puestoPropio.id, cantidad: 12 },
      { puesto_id: puestoSuyo.id, cantidad: 9 },
    ],
    equipos: [
      { equipo_id: propiaId, unidades: 1, horas: 9 },
      { equipo_id: suya.cuerpo.data.id, unidades: 1, horas: 8 },
    ],
  });
  const id = creado.cuerpo.data.id as number;
  await pedir('POST', `/proyecto-reportes/${P}/${id}/emitir`);

  // ---- el detalle ----
  const det = await pedir('GET', `/proyecto-reportes/${P}/${id}`);
  const d = det.cuerpo?.data;
  const siglas = (d?.columnas ?? []).map((x: { sigla: string }) => x.sigla).join(',');
  c(siglas === 'PIN,HRS', `el detalle trae las columnas con sus siglas (trajo ${siglas})`);
  const maquinas = d?.equipos ?? [];
  c(maquinas.length === 2, 'el detalle trae las dos retroexcavadoras');
  c(maquinas[0]?.empresa_id === null && maquinas[1]?.empresa_id === empId,
    'cada una con su dueño, la del propio primero');
  c(maquinas[1]?.empresa_nombre === 'Hermanos Rodríguez, S.A.', 'y el nombre de la empresa');

  // ---- el PDF ----
  const pdf = await pedir('GET', `/proyecto-reportes/${P}/${id}/pdf`);
  c(pdf.estado === 200 && pdf.tipo.includes('pdf'), `el PDF sale (dio ${pdf.estado})`);

  // ---- el semanal ----
  const semana = await datosDeLaSemana(P, FECHA);
  const nombres = semana.equipos.map((e) => e.nombre);
  c(nombres.includes('Retroexcavadora') && nombres.includes('Retroexcavadora — Hermanos Rodríguez, S.A.'),
    `el semanal separa las dos retroexcavadoras (trajo ${nombres.join(' | ')})`);
  c(semana.equipos.find((e) => e.nombre === 'Retroexcavadora')?.total === 9,
    'la del propio con sus 9 horas, sin las de la otra');

  console.log(`${ok} pasaron, ${fallo} fallaron`);
  await pool.end();
  process.exit(fallo ? 1 : 0);
};
main();
