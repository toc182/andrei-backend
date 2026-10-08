/**
 * Quién puede qué con una requisición, y cómo se lee una de la base.
 *
 * Vive aparte de routes/requisiciones.ts porque no solo lo usa esa ruta: la
 * solicitud de pago y la orden de compra que nacen de una requisición
 * (services/requisicionCompras.ts) preguntan lo mismo —si quien la crea es
 * Compras en ese proyecto— y tienen que contestar igual.
 */
import type { Request } from 'express';
import type { PoolClient } from 'pg';
import { query, pool } from '../database/config.js';
import type { UserPermissions } from '../types/auth.js';

export type Estado = 'por_aprobar' | 'aprobada' | 'anulada';
export type Prioridad = 'normal' | 'urgente';
export type Marca = 'pendiente' | 'atendida' | 'parcial' | 'cancelada';

export interface RequisicionRow {
  id: number;
  proyecto_id: number;
  consecutivo: number;
  numero: string;
  descripcion: string;
  fecha_requerida: Date;
  prioridad: Prioridad;
  notas: string | null;
  beneficiario: string | null;
  banco: string | null;
  tipo_cuenta: string | null;
  numero_cuenta: string | null;
  estado: Estado;
  creado_por: number;
  aprobada_por: number | null;
  aprobada_at: Date | null;
  anulada_por: number | null;
  anulada_at: Date | null;
  created_at: Date;
  updated_at: Date;
  /** De proyectos: quién aprueba las requisiciones de ese proyecto. */
  aprobador_id: number | null;
}

export interface LineaRow {
  id: number;
  orden: number;
  cantidad: string;
  unidad: string | null;
  descripcion: string;
  renglon_desglose: string | null;
  marca: Marca;
}

export type Db = Pick<PoolClient, 'query'>;

/** Lo único que estas reglas miran de la petición: quién la hace. */
export type ConUsuario = Pick<Request, 'user'>;

export const esAdmin = (req: ConUsuario): boolean =>
  req.user!.rol === 'admin' || req.user!.rol === 'co-admin';

/** Una llave de usuario. admin y co-admin pasan siempre. */
export const tiene = (req: ConUsuario, llave: keyof UserPermissions): boolean =>
  esAdmin(req) || !!req.user!.permissions?.[llave];

export const veTodosLosProyectos = (req: ConUsuario): boolean =>
  req.user!.rol !== 'usuario' || !!req.user!.permissions?.acceso_global;

/** Que el usuario pueda tocar ESE proyecto. admin y co-admin pasan siempre. */
export async function puedeElProyecto(req: ConUsuario, proyectoId: number): Promise<boolean> {
  if (veTodosLosProyectos(req)) return true;
  const r = await query(
    'SELECT 1 FROM user_project_access WHERE user_id = $1 AND proyecto_id = $2',
    [req.user!.id, proyectoId],
  );
  return r.rows.length > 0;
}

export const esAutor = (req: ConUsuario, r: RequisicionRow): boolean => r.creado_por === req.user!.id;
export const esAprobador = (req: ConUsuario, r: RequisicionRow): boolean =>
  r.aprobador_id !== null && r.aprobador_id === req.user!.id;

/**
 * Si la puede ver. Por aprobar es de tres personas; aprobada la ve además quien
 * tenga cualquiera de las tres llaves en ese proyecto.
 */
export async function puedeVer(req: ConUsuario, r: RequisicionRow): Promise<boolean> {
  if (esAdmin(req) || esAutor(req, r) || esAprobador(req, r)) return true;
  if (r.estado !== 'aprobada') return false;
  const conLlave =
    tiene(req, 'requisiciones_ver') ||
    tiene(req, 'requisiciones_crear') ||
    tiene(req, 'requisiciones_atender');
  return conLlave && (await puedeElProyecto(req, r.proyecto_id));
}

/** Compras: marcar, cotizar, y crear la solicitud o la orden que sale de ella. */
export async function puedeAtender(req: ConUsuario, r: RequisicionRow): Promise<boolean> {
  if (r.estado !== 'aprobada') return false;
  if (esAdmin(req)) return true;
  return !!req.user!.permissions?.requisiciones_atender && (await puedeElProyecto(req, r.proyecto_id));
}

export async function traer(id: string | number, db: Db = pool, bloquear = false): Promise<RequisicionRow | null> {
  const r = await db.query<RequisicionRow>(
    `SELECT r.*, p.requisicion_aprobador_id AS aprobador_id
       FROM requisiciones r
       JOIN proyectos p ON p.id = r.proyecto_id
      WHERE r.id = $1${bloquear ? ' FOR UPDATE OF r' : ''}`,
    [id],
  );
  return r.rows[0] ?? null;
}

export async function lineasDe(id: number, db: Db = pool): Promise<LineaRow[]> {
  const r = await db.query<LineaRow>(
    `SELECT id, orden, cantidad, unidad, descripcion, renglon_desglose, marca
       FROM requisicion_lineas WHERE requisicion_id = $1 ORDER BY orden, id`,
    [id],
  );
  return r.rows;
}
