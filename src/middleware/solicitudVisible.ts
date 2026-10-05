// Una solicitud de pago pedida por su numero: solo si es de un proyecto que esta
// persona puede ver.
//
// Ivan, 2026-10-05: probando el enlace del WhatsApp de las urgentes
// (/solicitud/<id>) se vio que bastaba cambiar el numero en la direccion para
// abrir la solicitud de cualquier proyecto, datos de banco incluidos. Las
// listas ya filtraban por proyecto; abrir una sola no miraba nada.
//
// Las reglas son las de checkProjectAccess: admin y co-admin, todo; un usuario,
// con acceso global o con el proyecto en user_project_access. Si no puede
// verla, 404, como si no existiera: un 403 le diria que ese numero existe.

import type { NextFunction, Request, Response } from 'express';
import { query } from '../database/config.js';

/** Los ids que caben en la columna; uno mas largo no es una solicitud. */
const ID = /^\d{1,9}$/;

async function proyectoVisible(req: Request, proyectoId: number): Promise<boolean> {
  const u = req.user;
  if (!u) return false;
  if (u.rol === 'admin' || u.rol === 'co-admin' || u.permissions?.acceso_global) return true;
  const r = await query(
    'SELECT 1 FROM user_project_access WHERE user_id = $1 AND proyecto_id = $2',
    [u.id, proyectoId],
  );
  return r.rows.length > 0;
}

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
    const r = await query<{ proyecto_id: number }>(sql, [Number(id)]);
    if (r.rows.length === 0 || (await proyectoVisible(req, r.rows[0].proyecto_id))) {
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
    'SELECT proyecto_id FROM solicitudes_pago WHERE id = $1',
    req.params.id,
    'Solicitud no encontrada',
  );
}

/** Para /adjuntos/:adjuntoId: el adjunto es de una solicitud, y la solicitud de un proyecto. */
export function soloAdjuntoVisible(req: Request, res: Response, next: NextFunction): Promise<void> {
  return revisar(
    req, res, next,
    `SELECT s.proyecto_id FROM solicitud_pago_adjuntos a
       JOIN solicitudes_pago s ON s.id = a.solicitud_pago_id
      WHERE a.id = $1`,
    req.params.adjuntoId,
    'Adjunto no encontrado',
  );
}
