// Quien puede ver, adjuntar y manejar UNA solicitud de pago pedida por su numero.
//
// Ivan, 2026-10-05: probando el enlace del WhatsApp de las urgentes
// (/solicitud/<id>) se vio que bastaba cambiar el numero en la direccion para
// abrir la solicitud de cualquier proyecto, datos de banco incluidos. Las
// listas ya filtraban por proyecto; abrir una sola no miraba nada.
//
// Ivan, 2026-10-06 (revision de permisos, huecos 2 y 3): tener el proyecto no
// basta. Una solicitud se ve si se cumple CUALQUIERA de estas:
//   1. admin o co-admin;
//   2. la preparo esa persona;
//   3. esa persona firma en la cadena del proyecto, o ya la firmo;
//   4. tiene el proyecto y «Ver solicitudes de pago» o «Registrar pagos y
//      facturas»;
//   5. tiene el proyecto y «Ver control de costos», y la solicitud esta pagada o
//      facturada (Control de costos > Pagos abre esas);
//   6. tiene el proyecto y «Acceso a cajas menudas», y es la apertura, un
//      aumento o un reembolso de una caja (el boton «Descargar» de la caja).
// César tiene Santa Isabel para hacer reportes: no ve sus pagos. Hilario firma
// en Santa Isabel: la abre desde el WhatsApp aunque nadie le haya marcado el
// proyecto.
//
// Si no puede verla, 404, como si no existiera: un 403 le diria que ese numero
// existe.

import type { NextFunction, Request, Response } from 'express';
import { query } from '../database/config.js';
import type { AuthUser } from '../types/auth.js';

/** Lo que hace falta de una solicitud para decidir quien la ve. */
export interface SolicitudAcceso {
  id: number;
  proyecto_id: number;
  preparado_por: number;
  estado: string;
  tipo: string;
}

/** Los ids que caben en la columna; uno mas largo no es una solicitud. */
const ID = /^\d{1,9}$/;

const esAdmin = (u: AuthUser): boolean => u.rol === 'admin' || u.rol === 'co-admin';

/** Las mismas reglas que checkProjectAccess. */
async function tieneElProyecto(u: AuthUser, proyectoId: number): Promise<boolean> {
  if (esAdmin(u) || u.permissions?.acceso_global) return true;
  const r = await query(
    'SELECT 1 FROM user_project_access WHERE user_id = $1 AND proyecto_id = $2',
    [u.id, proyectoId],
  );
  return r.rows.length > 0;
}

/** Firma en la cadena del proyecto, o ya firmo esta. */
async function firma(u: AuthUser, s: SolicitudAcceso): Promise<boolean> {
  const r = await query(
    `SELECT 1 FROM proyecto_ajustes_aprobacion
      WHERE proyecto_id = $1 AND user_id = $2 AND activo = true
     UNION ALL
     SELECT 1 FROM solicitud_aprobaciones
      WHERE solicitud_pago_id = $3 AND user_id = $2
     LIMIT 1`,
    [s.proyecto_id, u.id, s.id],
  );
  return r.rows.length > 0;
}

/** Casos 1 a 6 de arriba. */
export async function puedeVerSolicitud(u: AuthUser, s: SolicitudAcceso): Promise<boolean> {
  if (esAdmin(u) || s.preparado_por === u.id) return true;
  if (await firma(u, s)) return true;
  const p = u.permissions;
  const porCostos = !!p?.costos_ver && (s.estado === 'pagada' || s.estado === 'facturada');
  const porCaja = !!p?.caja_menuda && (s.tipo === 'apertura' || s.tipo === 'reembolso');
  if (!p?.solicitudes_ver && !p?.registrar_pago && !porCostos && !porCaja) return false;
  return tieneElProyecto(u, s.proyecto_id);
}

/**
 * Adjuntarle archivos: casos 1 a 4. Control de costos y las cajas solo la miran;
 * verla desde ahi no da para agregarle papeles.
 */
export async function puedeAdjuntar(u: AuthUser, s: SolicitudAcceso): Promise<boolean> {
  if (esAdmin(u) || s.preparado_por === u.id) return true;
  if (await firma(u, s)) return true;
  const p = u.permissions;
  if (!p?.solicitudes_ver && !p?.registrar_pago) return false;
  return tieneElProyecto(u, s.proyecto_id);
}

/**
 * Manejarla —editarla, reenviarla, borrarle adjuntos—: admin, co-admin, quien la
 * preparo, o quien tiene «Editar todas las solicitudes». Es la regla que PUT /:id
 * aplicaba por su cuenta.
 */
export function puedeGestionarSolicitud(u: AuthUser, s: Pick<SolicitudAcceso, 'preparado_por'>): boolean {
  return esAdmin(u) || s.preparado_por === u.id || !!u.permissions?.solicitudes_editar_todas;
}

const CAMPOS = 's.id, s.proyecto_id, s.preparado_por, s.estado, s.tipo';

async function revisar(
  req: Request,
  res: Response,
  next: NextFunction,
  sql: string,
  id: string | undefined,
  mensaje: string,
): Promise<void> {
  // Un tramo que no es un numero no es una de estas: sigue su camino (/project/…,
  // /aprobar-masivo…). Una que no existe, igual: la ruta dice su propio 404.
  if (!id || !ID.test(id)) {
    next();
    return;
  }
  try {
    const r = await query<SolicitudAcceso>(sql, [Number(id)]);
    if (r.rows.length === 0) {
      next();
      return;
    }
    if (req.user && (await puedeVerSolicitud(req.user, r.rows[0]))) {
      // Lo que viene despues (adjuntar, borrar un adjunto) no la vuelve a leer.
      res.locals.solicitudAcceso = r.rows[0];
      next();
      return;
    }
    res.status(404).json({ success: false, message: mensaje });
  } catch (e) {
    next(e);
  }
}

/** Para las rutas /:id de las solicitudes. Va despues de authenticateToken. */
export function soloSolicitudVisible(req: Request, res: Response, next: NextFunction): Promise<void> {
  return revisar(
    req, res, next,
    `SELECT ${CAMPOS} FROM solicitudes_pago s WHERE s.id = $1`,
    req.params.id,
    'Solicitud no encontrada',
  );
}

/** Para /adjuntos/:adjuntoId: el adjunto es de una solicitud, y la solicitud de un proyecto. */
export function soloAdjuntoVisible(req: Request, res: Response, next: NextFunction): Promise<void> {
  return revisar(
    req, res, next,
    `SELECT ${CAMPOS} FROM solicitud_pago_adjuntos a
       JOIN solicitudes_pago s ON s.id = a.solicitud_pago_id
      WHERE a.id = $1`,
    req.params.adjuntoId,
    'Adjunto no encontrado',
  );
}

/**
 * Para POST /:id/adjuntos, despues de soloSolicitudVisible y ANTES de recibir los
 * archivos: si no puede, no se le lee ni un byte.
 */
export async function soloQuienPuedeAdjuntar(req: Request, res: Response, next: NextFunction): Promise<void> {
  const s = res.locals.solicitudAcceso as SolicitudAcceso | undefined;
  if (!s) {
    res.status(404).json({ success: false, message: 'Solicitud no encontrada' });
    return;
  }
  try {
    if (req.user && (await puedeAdjuntar(req.user, s))) {
      next();
      return;
    }
    res.status(403).json({
      success: false,
      message: 'No puedes adjuntar archivos a esta solicitud',
    });
  } catch (e) {
    next(e);
  }
}
