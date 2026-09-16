// Prueba de humo de las listas del reporte (empresas, puestos, equipos,
// categorias).
//
// Corre contra la base desechable y su servidor propio: npm run pruebas -- listas
// No limpia nada: la empresa y los puestos que crea se van con la base. Antes
// limpiaba solo si todo pasaba —no tenía try/finally—, así que una caída a
// mitad le dejaba a Ivan una «Aceros QA» entre sus datos.
//
// El import de la guardia va primero: si esto no apunta a una base de pruebas,
// el proceso se muere antes de la primera consulta.
import { API } from './pruebas/contexto.js';
import jwt from 'jsonwebtoken';
import { query, pool } from '../src/database/config.js';

const BASE = `${API}/proyecto-listas`;
const P = 1;

const main = async () => {
  const u = await query<{ id: number; email: string; rol: string }>(
    "SELECT id, email, rol FROM users WHERE rol='admin' AND activo=true ORDER BY id LIMIT 1");
  const token = jwt.sign(
    { userId: u.rows[0].id, email: u.rows[0].email, rol: u.rows[0].rol },
    process.env.JWT_SECRET!, { expiresIn: '10m' });

  const pedir = async (metodo: string, ruta: string, cuerpo?: unknown) => {
    const r = await fetch(`${BASE}${ruta}`, {
      method: metodo,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(cuerpo ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(cuerpo ? { body: JSON.stringify(cuerpo) } : {}),
    });
    return { estado: r.status, cuerpo: await r.json().catch(() => null) };
  };

  let ok = 0; let fallo = 0;
  const comprobar = (cond: boolean, etiqueta: string) => {
    if (cond) { ok += 1; } else { fallo += 1; console.log(`FALLA  ${etiqueta}`); }
  };

  // 1. las cuatro listas
  const todas = await pedir('GET', `/${P}`);
  const d = todas.cuerpo?.data;
  comprobar(todas.estado === 200, 'GET devuelve 200');
  comprobar(d?.puestos?.length === 4, 'el bloque propio trae 4 puestos');
  comprobar(d?.puestos?.every((x: { fijo: boolean }) => x.fijo), 'los 4 vienen marcados como fijos');
  comprobar(d?.categorias?.length === 3, 'trae 3 categorias');
  comprobar(d?.equipos?.length === 5, 'trae los 5 equipos deducidos');

  // 2. un puesto fijo no se quita
  const fijo = d.puestos[0];
  const noSeQuita = await pedir('DELETE', `/${P}/puestos/${fijo.id}`);
  comprobar(noSeQuita.estado === 400, 'un puesto fijo devuelve 400 al intentar quitarlo');

  // 3. agregar un puesto al bloque propio
  const tk = await pedir('POST', `/${P}/puestos`, { nombre: 'Timekeeper QA' });
  comprobar(tk.estado === 201, 'agrega un puesto nuevo');
  comprobar(tk.cuerpo?.data?.fijo === false, 'el puesto nuevo NO es fijo');
  const tkId = tk.cuerpo.data.id;

  // 4. repetirlo choca
  const repetido = await pedir('POST', `/${P}/puestos`, { nombre: 'timekeeper qa' });
  comprobar(repetido.estado === 409, 'el mismo nombre repetido devuelve 409');

  // 5. quitarlo y volver a ponerlo REACTIVA la misma fila
  await pedir('DELETE', `/${P}/puestos/${tkId}`);
  const revivido = await pedir('POST', `/${P}/puestos`, { nombre: 'Timekeeper QA' });
  comprobar(revivido.cuerpo?.data?.id === tkId, 'volver a agregarlo reactiva la MISMA fila');

  // 6. una empresa nueva nace con los 4 puestos
  const emp = await pedir('POST', `/${P}/empresas`, { nombre: 'Aceros QA' });
  comprobar(emp.estado === 201, 'agrega una empresa');
  const empId = emp.cuerpo.data.id;
  const tras = await pedir('GET', `/${P}`);
  const suyos = tras.cuerpo.data.puestos.filter(
    (x: { empresa_id: number | null }) => x.empresa_id === empId);
  comprobar(suyos.length === 4, 'la empresa nace con 4 puestos');
  comprobar(suyos.every((x: { fijo: boolean }) => !x.fijo), 'los de la empresa NO son fijos');

  // 7. dentro de la empresa si se puede quitar cualquiera
  const quitado = await pedir('DELETE', `/${P}/puestos/${suyos[0].id}`);
  comprobar(quitado.estado === 200, 'dentro de una empresa si se quita un puesto');

  // 8. y eso no toca el bloque propio
  const tras2 = await pedir('GET', `/${P}`);
  const propios = tras2.cuerpo.data.puestos.filter(
    (x: { empresa_id: number | null }) => x.empresa_id === null);
  comprobar(propios.length === 5, 'el bloque propio sigue con sus 5 (4 fijos + Timekeeper)');

  // 9. quitar la empresa se lleva sus puestos
  await pedir('DELETE', `/${P}/empresas/${empId}`);
  const tras3 = await pedir('GET', `/${P}`);
  const quedan = tras3.cuerpo.data.puestos.filter(
    (x: { empresa_id: number | null }) => x.empresa_id === empId);
  comprobar(quedan.length === 0, 'quitar la empresa se lleva sus puestos');

  console.log(`${ok} pasaron, ${fallo} fallaron`);
  await pool.end();
  process.exit(fallo ? 1 : 0);
};
main();
