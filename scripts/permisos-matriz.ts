// Matriz de permisos: que contesta cada endpoint a un admin y a un usuario
// restringido. Se corre ANTES de tocar los permisos para tener la linea base, y
// despues de cada cambio para ver que se movio solo lo que se queria mover.
//
//   cd andrei-backend && npx tsx --env-file=.env scripts/permisos-matriz.ts [adminId] [usuarioId] [proyectoId] [apagar]
//
// Con "apagar" como cuarto argumento, apaga las llaves de seccion del usuario
// de prueba mientras corre y las DEJA COMO ESTABAN al terminar, pase lo que
// pase (try/finally). Es la unica manera de ver si los candados muerden: la
// migracion 159 deja esas llaves encendidas para todo el que ya existia.
//
// Sin argumentos busca solo: el primer admin activo y el usuario con menos
// permisos encendidos, sobre un proyecto al que ese usuario tenga acceso.
//
// NO ESCRIBE NADA. Las rutas de escritura se prueban de dos maneras seguras:
//   - DELETE/PUT apuntados a un id inexistente -> 404 si me dejo pasar
//   - POST con cuerpo vacio -> 400 si me dejo pasar, porque la validacion
//     corre despues del middleware de permisos y antes de tocar la base
// En ambos casos 401/403 significa "me freno". Es el mismo truco que descubrio
// el fallo de las fotos de los reportes: distinguir "llegue" de "no llegue" sin
// dejar rastro.
//
// El servidor tiene que estar levantado (npm run dev).

import jwt from 'jsonwebtoken';
import { query, pool } from '../src/database/config.js';

const BASE = process.env.MATRIZ_BASE ?? 'http://localhost:5000/api';
const ID_INEXISTENTE = 999999;

interface Quien {
  etiqueta: string;
  token: string;
  descripcion: string;
}

interface Sonda {
  metodo: 'GET' | 'POST' | 'PUT' | 'DELETE';
  ruta: string;
  nota: string;
  /** Cuerpo vacio a proposito: la validacion frena antes de escribir. */
  cuerpo?: Record<string, unknown>;
}

function firmar(id: number, email: string, rol: string): string {
  const secreto = process.env.JWT_SECRET;
  if (!secreto) throw new Error('Falta JWT_SECRET. Corre con: npx tsx --env-file=.env ...');
  return jwt.sign({ userId: id, email, rol }, secreto, { expiresIn: '15m' });
}

async function pedir(quien: Quien, sonda: Sonda): Promise<string> {
  try {
    const r = await fetch(`${BASE}${sonda.ruta}`, {
      method: sonda.metodo,
      headers: {
        Authorization: `Bearer ${quien.token}`,
        ...(sonda.cuerpo ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(sonda.cuerpo ? { body: JSON.stringify(sonda.cuerpo) } : {}),
    });
    return String(r.status);
  } catch (e) {
    return `ERR ${(e as Error).message.slice(0, 20)}`;
  }
}

/** 401/403 es "me freno"; cualquier otra cosa es "me dejo pasar". */
function lectura(codigo: string): string {
  if (codigo === '403' || codigo === '401') return 'FRENADO';
  if (codigo.startsWith('2') || codigo === '404' || codigo === '400') return 'pasa';
  return codigo;
}

async function buscarUsuarios(): Promise<{ admin: Quien; usuario: Quien; proyectoId: number }> {
  const [adminId, usuarioId, proyectoId] = process.argv.slice(2).map((n) => parseInt(n, 10));

  const admin = adminId
    ? await query<{ id: number; email: string; rol: string }>(
      'SELECT id, email, rol FROM users WHERE id = $1', [adminId])
    : await query<{ id: number; email: string; rol: string }>(
      "SELECT id, email, rol FROM users WHERE rol = 'admin' AND activo = true ORDER BY id LIMIT 1");

  // El usuario con menos permisos encendidos es el que mejor representa a un
  // ingeniero de campo. Se cuentan las llaves booleanas de su fila.
  const usuario = usuarioId
    ? await query<{ id: number; email: string; rol: string }>(
      'SELECT id, email, rol FROM users WHERE id = $1', [usuarioId])
    : await query<{ id: number; email: string; rol: string }>(
      `SELECT u.id, u.email, u.rol
         FROM users u
         LEFT JOIN user_permissions p ON p.user_id = u.id
        WHERE u.rol = 'usuario' AND u.activo = true
        ORDER BY (
          (COALESCE(p.acceso_global, false))::int + (COALESCE(p.cuentas, false))::int +
          (COALESCE(p.caja_menuda, false))::int + (COALESCE(p.cotizaciones, false))::int +
          (COALESCE(p.documentos_acceso, false))::int + (COALESCE(p.reportes, false))::int
        ), u.id
        LIMIT 1`);

  if (!admin.rows[0]) throw new Error('No encontre un admin activo.');
  if (!usuario.rows[0]) throw new Error('No encontre un usuario con rol=usuario activo.');

  const u = usuario.rows[0];
  const proyecto = proyectoId
    ? { rows: [{ proyecto_id: proyectoId }] }
    : await query<{ proyecto_id: number }>(
      'SELECT proyecto_id FROM user_project_access WHERE user_id = $1 ORDER BY proyecto_id LIMIT 1',
      [u.id]);

  const pid = proyecto.rows[0]?.proyecto_id
    ?? (await query<{ id: number }>('SELECT id FROM proyectos ORDER BY id LIMIT 1')).rows[0]?.id;
  if (!pid) throw new Error('No hay proyectos en la base.');

  const a = admin.rows[0];
  return {
    admin: { etiqueta: 'admin', token: firmar(a.id, a.email, a.rol), descripcion: `#${a.id} ${a.email}` },
    usuario: { etiqueta: 'usuario', token: firmar(u.id, u.email, u.rol), descripcion: `#${u.id} ${u.email}` },
    proyectoId: pid,
  };
}

function sondas(p: number): Sonda[] {
  return [
    // --- Miembros: las lecturas las usan los formularios de requisicion,
    //     solicitud de pago y tareas. Las escrituras, solo la pagina de
    //     administracion. El corte va entre unas y otras.
    { metodo: 'GET', ruta: `/project-members/project/${p}`, nota: 'leer miembros (3 formularios dependen)' },
    { metodo: 'GET', ruta: '/project-members/users', nota: 'leer usuarios asignables' },
    { metodo: 'POST', ruta: '/project-members', nota: 'AGREGAR miembro', cuerpo: {} },
    { metodo: 'PUT', ruta: `/project-members/${ID_INEXISTENTE}`, nota: 'EDITAR miembro' },
    { metodo: 'DELETE', ruta: `/project-members/${ID_INEXISTENTE}`, nota: 'BORRAR miembro' },

    // --- Aprobadores: leer lo hacen dos pantallas de solicitudes; guardar,
    //     solo la pagina de miembros.
    { metodo: 'GET', ruta: `/approval-settings/project/${p}`, nota: 'leer cadena de aprobacion' },
    { metodo: 'PUT', ruta: `/approval-settings/project/${p}`, nota: 'REESCRIBIR aprobadores', cuerpo: {} },

    // --- Secciones que hoy no se pueden apagar
    { metodo: 'GET', ruta: '/solicitudes-pago', nota: 'listado de solicitudes' },
    { metodo: 'GET', ruta: '/requisiciones', nota: 'listado de requisiciones' },
    { metodo: 'GET', ruta: '/clientes', nota: 'listado de clientes' },
    { metodo: 'GET', ruta: `/solicitudes-pago/project/${p}`, nota: 'solicitudes del proyecto' },
    { metodo: 'GET', ruta: `/requisiciones/project/${p}`, nota: 'requisiciones del proyecto (lo usa tambien el form de solicitud)' },
    { metodo: 'GET', ruta: `/costs/projects/${p}/partidas`, nota: 'partidas de Control de Costos' },
    { metodo: 'GET', ruta: `/clientes/${ID_INEXISTENTE}`, nota: 'detalle de cliente' },
    { metodo: 'GET', ruta: '/clientes/stats/dashboard', nota: 'stats del dashboard (lo llama todo el mundo)' },
    { metodo: 'GET', ruta: `/costs/projects/${p}/resumen`, nota: 'resumen de Control de Costos' },
    { metodo: 'GET', ruta: `/presupuestos/proyecto/${p}`, nota: 'presupuestos del proyecto' },

    // --- Cotizaciones: hoy sin filtro por proyecto
    { metodo: 'GET', ruta: '/cotizaciones', nota: 'cotizaciones (sin filtro por proyecto)' },
    { metodo: 'GET', ruta: '/cotizaciones/ofertas', nota: 'ofertas (sin filtro por proyecto)' },

    // --- Las que YA tienen permiso: sirven de control. No deben moverse.
    { metodo: 'GET', ruta: '/equipos', nota: 'control: equipos (equipos_ver)' },
    { metodo: 'GET', ruta: '/cuentas/detalle', nota: 'control: cuentas (cuentas)' },
    { metodo: 'GET', ruta: `/proyecto-reportes/${p}`, nota: 'control: reportes (reportes)' },
  ];
}

const LLAVES = ['solicitudes_ver', 'requisiciones_ver', 'clientes_ver', 'costos_ver'] as const;

/** Devuelve como estaban, para poder dejarlas igual al terminar. */
async function apagarLlaves(userId: number): Promise<Record<string, boolean>> {
  const antes = await query<Record<string, boolean>>(
    `SELECT ${LLAVES.join(', ')} FROM user_permissions WHERE user_id = $1`, [userId]);
  await query(
    `UPDATE user_permissions SET ${LLAVES.map((k) => `${k} = false`).join(', ')} WHERE user_id = $1`,
    [userId]);
  return antes.rows[0] ?? {};
}

async function restaurarLlaves(userId: number, antes: Record<string, boolean>): Promise<void> {
  if (Object.keys(antes).length === 0) return;
  await query(
    `UPDATE user_permissions SET ${LLAVES.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE user_id = $1`,
    [userId, ...LLAVES.map((k) => antes[k] ?? false)]);
}

const main = async () => {
  const { admin, usuario, proyectoId } = await buscarUsuarios();

  console.log('MATRIZ DE PERMISOS');
  console.log(`  admin   : ${admin.descripcion}`);
  console.log(`  usuario : ${usuario.descripcion}`);
  console.log(`  proyecto: ${proyectoId}`);
  console.log(`  servidor: ${BASE}\n`);

  const apagar = process.argv[5] === 'apagar';
  const idUsuario = parseInt(usuario.descripcion.slice(1), 10);
  let antes: Record<string, boolean> = {};
  if (apagar) {
    antes = await apagarLlaves(idUsuario);
    console.log('  LLAVES DE SECCION APAGADAS para el usuario (se restauran al final)');
  }

  try {
    await correrMatriz(admin, usuario, proyectoId);
  } finally {
    // El finally no es adorno: si la matriz truena a la mitad, el usuario se
    // quedaria con las llaves apagadas y nadie se enteraria.
    if (apagar) {
      await restaurarLlaves(idUsuario, antes);
      console.log('Llaves restauradas a como estaban.');
    }
    await pool.end();
  }
};

async function correrMatriz(admin: Quien, usuario: Quien, proyectoId: number): Promise<void> {
  const lista = sondas(proyectoId);
  const ancho = Math.max(...lista.map((s) => `${s.metodo} ${s.ruta}`.length));

  console.log(`${'RUTA'.padEnd(ancho)}  ${'ADMIN'.padEnd(7)}  ${'USUARIO'.padEnd(9)}  QUE ES`);
  console.log('-'.repeat(ancho + 40));

  for (const sonda of lista) {
    const a = await pedir(admin, sonda);
    const u = await pedir(usuario, sonda);
    const etiqueta = `${sonda.metodo} ${sonda.ruta}`.padEnd(ancho);
    console.log(`${etiqueta}  ${a.padEnd(7)}  ${`${u} ${lectura(u)}`.padEnd(9)}  ${sonda.nota}`);
  }

  console.log('\n401/403 = frenado. 2xx/404/400 = le dejaron pasar.');
}

main().catch(async (e) => {
  console.error(e instanceof Error ? e.message : e);
  console.error('*** Si corriste con "apagar", revisa las llaves del usuario a mano. ***');
  await pool.end().catch(() => {});
  process.exit(1);
});
