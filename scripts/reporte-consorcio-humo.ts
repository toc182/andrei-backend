// Prueba de humo del reporte de un proyecto en consorcio.
// npm run pruebas -- reporte-consorcio
//
// En un proyecto en consorcio el reporte diario sale con el nombre y el logo
// del consorcio, no con los de Pinellas (pedido de Ivan, 2026-09-16). Esto
// recorre el camino entero: el formulario del proyecto exige el nombre y
// guarda el logo reducido, y el reporte —PDF, formulario y detalle— los usa.
//
// Lo que se ve en el papel se comprobo a ojo al construirlo; aqui se prueba que
// al PDF le llega lo que tiene que llegarle y que sale.
import { API } from './pruebas/contexto.js';
import jwt from 'jsonwebtoken';
import sharp from 'sharp';
import { query, pool } from '../src/database/config.js';
import { buildReportePdfInput } from '../src/routes/proyectoReportes.js';
import { nombreEmisor, nombrePropio } from '../src/services/consorcioProyecto.js';

const P = 3; // empieza normal; esta prueba lo vuelve consorcio
const PINELLAS = 1;
const NOMBRE = 'Consorcio de Pruebas';
const SOCIOS = [
  { nombre: 'Pinellas, S.A.', porcentaje: 50 },
  { nombre: 'Socio de Pruebas, S.A.', porcentaje: 50 },
];

const main = async () => {
  const admin = await query<{ id: number; email: string; rol: string }>(
    "SELECT id, email, rol FROM users WHERE rol='admin' AND activo=true ORDER BY id LIMIT 1");
  const u = admin.rows[0];
  const token = jwt.sign({ userId: u.id, email: u.email, rol: u.rol },
    process.env.JWT_SECRET!, { expiresIn: '10m' });

  const pedir = async (m: string, r: string, b?: unknown) => {
    const res = await fetch(`${API}${r}`, {
      method: m,
      headers: { Authorization: `Bearer ${token}`, ...(b ? { 'Content-Type': 'application/json' } : {}) },
      ...(b ? { body: JSON.stringify(b) } : {}),
    });
    const tipo = res.headers.get('content-type') ?? '';
    const cuerpo = tipo.includes('json')
      ? await res.json().catch(() => null)
      : Buffer.from(await res.arrayBuffer());
    return { estado: res.status, cuerpo };
  };

  let ok = 0; let fallo = 0;
  const c = (cond: boolean, etq: string) => {
    if (cond) ok += 1; else { fallo += 1; console.log('FALLA ', etq); }
  };

  const filaProyecto = async () => (await query<{
    contratista: string | null;
    logo_consorcio: string | null;
    datos_adicionales: { es_consorcio?: boolean } | null;
  }>('SELECT contratista, logo_consorcio, datos_adicionales FROM proyectos WHERE id = $1', [P])).rows[0];

  // ---- el nombre es obligatorio en un consorcio ----
  let r = await pedir('PUT', `/projects/${P}`, {
    contratista: '', datos_adicionales: { es_consorcio: true, socios: SOCIOS },
  });
  c(r.estado === 400, `marcar consorcio sin nombre se rechaza (dio ${r.estado})`);
  c(/consorcio/i.test(r.cuerpo?.message ?? ''), `y dice por que (dijo «${r.cuerpo?.message}»)`);
  c((await filaProyecto()).datos_adicionales?.es_consorcio !== true, 'y no se guardo nada');

  r = await pedir('POST', '/projects', {
    nombre: 'Consorcio sin nombre', cliente_id: 1, monto_total: 100,
    datos_adicionales: { es_consorcio: true, socios: SOCIOS },
  });
  c(r.estado === 400, `crear un consorcio sin nombre tambien se rechaza (dio ${r.estado})`);
  c((await query("SELECT 1 FROM proyectos WHERE nombre = 'Consorcio sin nombre'")).rows.length === 0,
    'y no se crea el proyecto');

  // ---- un logo que no sirve se rechaza con un mensaje ----
  r = await pedir('PUT', `/projects/${P}`, { logo_consorcio: 'data:text/plain;base64,aG9sYQ==' });
  c(r.estado === 400, `un archivo que no es imagen se rechaza (dio ${r.estado})`);
  r = await pedir('PUT', `/projects/${P}`, { logo_consorcio: 'data:image/png;base64,AAAA' });
  c(r.estado === 400, `una imagen rota se rechaza (dio ${r.estado})`);
  c(!!r.cuerpo?.message && r.cuerpo.message !== 'Error interno del servidor',
    `con un mensaje de verdad (dijo «${r.cuerpo?.message}»)`);
  r = await pedir('PUT', `/projects/${P}`, { logo_consorcio: `data:image/png;base64,${'A'.repeat(700_000)}` });
  c(r.estado === 400, `un logo demasiado pesado se rechaza (dio ${r.estado})`);

  // ---- el bueno: nombre, consorcio y un logo enorme con transparencia ----
  const enorme = await sharp({
    create: { width: 2400, height: 1200, channels: 4, background: { r: 30, g: 120, b: 160, alpha: 0.5 } },
  }).png().toBuffer();
  r = await pedir('PUT', `/projects/${P}`, {
    contratista: NOMBRE,
    datos_adicionales: { es_consorcio: true, socios: SOCIOS },
    logo_consorcio: `data:image/png;base64,${enorme.toString('base64')}`,
  });
  c(r.estado === 200, `el consorcio con nombre y logo se guarda (dio ${r.estado})`);

  const guardado = (await filaProyecto()).logo_consorcio;
  c(!!guardado?.startsWith('data:image/png;base64,'), 'el logo queda guardado como PNG');
  const meta = await sharp(Buffer.from(guardado!.split(',')[1], 'base64')).metadata();
  c((meta.height ?? 999) <= 200 && (meta.width ?? 999) <= 800,
    `y reducido al tamano del papel (quedo ${meta.width}x${meta.height})`);
  c(meta.hasAlpha === true, 'sin perder la transparencia');

  // Un guardado que no trae el logo no lo toca, y uno que solo cambia el estado
  // no tropieza con la regla del nombre.
  r = await pedir('PUT', `/projects/${P}`, { estado: 'en_curso' });
  c(r.estado === 200, `cambiar solo el estado de un consorcio funciona (dio ${r.estado})`);
  c((await filaProyecto()).logo_consorcio === guardado, 'y el logo sigue igual');

  r = await pedir('PUT', `/projects/${P}`, { contratista: null });
  c(r.estado === 400, `borrarle el nombre a un consorcio se rechaza (dio ${r.estado})`);
  c((await filaProyecto()).contratista === NOMBRE, 'y el nombre sigue ahi');

  r = await pedir('GET', `/projects/${P}`);
  c(r.cuerpo?.proyecto?.logo_consorcio === guardado, 'el formulario recibe el logo al abrir el proyecto');

  // ---- las pantallas del reporte ----
  r = await pedir('GET', `/proyecto-listas/${P}`);
  c(r.cuerpo?.data?.nombre_propio === NOMBRE,
    `el formulario llama al bloque propio como el consorcio (dijo «${r.cuerpo?.data?.nombre_propio}»)`);
  r = await pedir('GET', `/proyecto-listas/${PINELLAS}`);
  c(r.cuerpo?.data?.nombre_propio === 'Pinellas',
    `en un proyecto normal sigue siendo Pinellas (dijo «${r.cuerpo?.data?.nombre_propio}»)`);

  // Un reporte con cuadrilla propia y de un subcontratista: el caso en que el
  // nombre del bloque propio se imprime.
  r = await pedir('POST', `/proyecto-listas/${P}/empresas`, { nombre: 'Subcontratista de Pruebas' });
  c(r.estado === 201 || r.estado === 200, `se agrega un subcontratista (dio ${r.estado})`);
  const listas = (await pedir('GET', `/proyecto-listas/${P}`)).cuerpo.data as {
    empresas: { id: number }[];
    puestos: { id: number; empresa_id: number | null }[];
  };
  const propio = listas.puestos.find((p) => p.empresa_id === null)!;
  const ajeno = listas.puestos.find((p) => p.empresa_id === listas.empresas[0]?.id)!;

  r = await pedir('POST', `/proyecto-reportes/${P}`, {
    fecha: '2026-09-16', clima: 'Soleado', que_se_hizo: 'Prueba del consorcio',
    personal: [
      { puesto_id: propio.id, cantidad: 6 },
      { puesto_id: ajeno.id, cantidad: 3 },
    ],
  });
  c(r.estado === 201, `se crea un reporte en el consorcio (dio ${r.estado})`);
  const id = r.cuerpo.data.id as number;
  c((await pedir('POST', `/proyecto-reportes/${P}/${id}/emitir`)).estado === 200, 'y se emite');

  r = await pedir('GET', `/proyecto-reportes/${P}/${id}`);
  c(r.cuerpo?.data?.nombre_propio === NOMBRE,
    `el detalle llama a la cuadrilla propia como el consorcio (dijo «${r.cuerpo?.data?.nombre_propio}»)`);
  c(r.cuerpo?.data?.contratista === undefined && r.cuerpo?.data?.es_consorcio === undefined,
    'sin colar las columnas que usa para decidirlo');

  // ---- el PDF ----
  let datos = await buildReportePdfInput(id);
  c(datos?.consorcio?.nombre === NOMBRE, 'al PDF le llega el nombre del consorcio');
  c(datos?.consorcio?.logo === guardado, 'y su logo, el reducido');
  c(nombreEmisor(datos?.consorcio) === NOMBRE && nombrePropio(datos?.consorcio) === NOMBRE,
    'el pie y la cuadrilla propia dicen el consorcio');

  let pdf = await pedir('GET', `/proyecto-reportes/${P}/${id}/pdf`);
  c(pdf.estado === 200 && Buffer.isBuffer(pdf.cuerpo) && pdf.cuerpo.subarray(0, 4).toString() === '%PDF',
    `el PDF del consorcio sale (dio ${pdf.estado})`);
  const conLogo = Buffer.isBuffer(pdf.cuerpo) ? pdf.cuerpo.length : 0;

  // Sin logo: sale sin logo, nunca con el de Pinellas.
  r = await pedir('PUT', `/projects/${P}`, { logo_consorcio: null });
  c(r.estado === 200, `quitar el logo funciona (dio ${r.estado})`);
  c((await filaProyecto()).logo_consorcio === null, 'y queda vacio');
  datos = await buildReportePdfInput(id);
  c(datos?.consorcio?.nombre === NOMBRE && datos?.consorcio?.logo === null,
    'al PDF le llega el consorcio sin logo');
  pdf = await pedir('GET', `/proyecto-reportes/${P}/${id}/pdf`);
  c(pdf.estado === 200, `y el PDF sale igual (dio ${pdf.estado})`);
  const sinLogo = Buffer.isBuffer(pdf.cuerpo) ? pdf.cuerpo.length : 0;
  c(sinLogo > 0 && sinLogo < conLogo, `mas liviano que con logo: no metio otro (${sinLogo} < ${conLogo})`);

  // ---- un proyecto normal no cambia ----
  r = await pedir('POST', `/proyecto-reportes/${PINELLAS}`, {
    fecha: '2026-09-16', clima: 'Soleado', que_se_hizo: 'Prueba de Pinellas',
  });
  const idNormal = r.cuerpo?.data?.id as number;
  await pedir('POST', `/proyecto-reportes/${PINELLAS}/${idNormal}/emitir`);
  datos = await buildReportePdfInput(idNormal);
  c(datos !== null && datos.consorcio === null, 'un proyecto normal no trae consorcio');
  c(nombreEmisor(datos?.consorcio) === 'Pinellas, S.A.' && nombrePropio(datos?.consorcio) === 'Pinellas',
    'y su papel sigue diciendo Pinellas');
  r = await pedir('GET', `/proyecto-reportes/${PINELLAS}/${idNormal}`);
  c(r.cuerpo?.data?.nombre_propio === 'Pinellas', 'y su detalle tambien');

  console.log(`${ok} pasaron, ${fallo} fallaron`);
  await pool.end();
  process.exit(fallo ? 1 : 0);
};
main();
