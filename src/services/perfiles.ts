import type { PoolClient } from 'pg';
import type { UserPermissions } from '../types/auth.js';

// Perfiles de permisos (migración 190). Un perfil no es otra fuente de
// permisos: el sistema revisa siempre las llaves de la persona en
// user_permissions. El perfil solo las llena, y aquí está cómo.

// Las llaves que un perfil puede dar: todas las de hoy menos tres que no son
// de un puesto:
//   acceso_global       es «Proyectos» de cada persona, no del perfil;
//   proyectos_eliminar  sola no hace nada: solo el dueño borra proyectos;
//   oportunidades_ver   no tiene pantalla.
// Esas tres no las toca un perfil: quedan como estén en cada persona.
export const LLAVES_DE_PERFIL: (keyof UserPermissions)[] = [
  'proyectos_crear',
  'proyectos_editar',
  'clientes_ver',
  'clientes_agregar',
  'clientes_editar',
  'clientes_eliminar',
  'solicitudes_ver',
  'solicitudes_editar_todas',
  'registrar_pago',
  'ordenes_ver',
  'ordenes_entregas',
  'requisiciones_ver',
  'requisiciones_crear',
  'requisiciones_atender',
  'caja_menuda',
  'cuentas',
  'cotizaciones',
  'costos_ver',
  'desglose_ver',
  'reportes',
  'cronogramas_ver',
  'documentos_acceso',
  'equipos_ver',
  'equipos_agregar',
  'equipos_editar',
  'equipos_eliminar',
  'equipos_asignacion',
  'equipos_editar_asignacion',
  'equipos_uso',
];

export function esLlaveDePerfil(llave: string): llave is keyof UserPermissions {
  return (LLAVES_DE_PERFIL as string[]).includes(llave);
}

/** Las llaves que da un perfil vivo, o null si no existe o está quitado. */
export async function llavesDelPerfil(
  db: PoolClient,
  perfilId: number,
): Promise<Set<string> | null> {
  // FOR SHARE: si a la vez alguien cambia los permisos del perfil, uno espera
  // al otro y la persona no se queda con las llaves viejas de un perfil nuevo.
  const perfil = await db.query<{ id: number }>(
    'SELECT id FROM permission_profiles WHERE id = $1 AND activo FOR SHARE',
    [perfilId],
  );
  if (perfil.rows.length === 0) return null;
  const llaves = await db.query<{ permission_key: string }>(
    'SELECT permission_key FROM permission_profile_keys WHERE profile_id = $1',
    [perfilId],
  );
  return new Set(llaves.rows.map((r) => r.permission_key));
}

/**
 * Escribe en la fila de la persona las llaves de un perfil: la que el perfil da
 * queda en true y la que no, en false. Las que no son de perfil no se tocan.
 * Si la persona no tenía fila, nace con los valores de siempre en esas tres.
 * Devuelve las llaves que cambiaron, para el rastro.
 */
export async function escribirLlavesDePerfil(
  db: PoolClient,
  userId: number,
  llaves: Set<string>,
): Promise<{ llave: string; antes: boolean; despues: boolean }[]> {
  // Los nombres de columna salen de LLAVES_DE_PERFIL, nunca de lo que llega.
  const columnas = LLAVES_DE_PERFIL;
  const antes = await db.query<Record<string, boolean | null>>(
    `SELECT ${columnas.join(', ')} FROM user_permissions WHERE user_id = $1`,
    [userId],
  );
  await db.query(
    `INSERT INTO user_permissions (user_id, ${columnas.join(', ')}, updated_at)
     VALUES ($1, ${columnas.map((_, i) => `$${i + 2}`).join(', ')}, CURRENT_TIMESTAMP)
     ON CONFLICT (user_id) DO UPDATE SET
       ${columnas.map((c) => `${c} = EXCLUDED.${c}`).join(',\n       ')},
       updated_at = CURRENT_TIMESTAMP`,
    [userId, ...columnas.map((c) => llaves.has(c))],
  );
  const fila = antes.rows[0] ?? {};
  return columnas
    .filter((c) => (fila[c] ?? false) !== llaves.has(c))
    .map((c) => ({ llave: c, antes: fila[c] ?? false, despues: llaves.has(c) }));
}

/** ¿Las llaves de perfil de esta persona son exactamente las del perfil? */
export async function coincideConPerfil(
  db: PoolClient,
  userId: number,
  llaves: Set<string>,
): Promise<boolean> {
  const fila = await db.query<Record<string, boolean | null>>(
    `SELECT ${LLAVES_DE_PERFIL.join(', ')} FROM user_permissions WHERE user_id = $1`,
    [userId],
  );
  if (fila.rows.length === 0) return llaves.size === 0;
  return LLAVES_DE_PERFIL.every((c) => (fila.rows[0][c] ?? false) === llaves.has(c));
}
