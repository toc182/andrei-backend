/**
 * Áreas de un proyecto
 *
 * La lista de zonas de trabajo que un reporte diario puede señalar
 * ("Área de chorros", "Torre péndulo"). Van por proyecto porque son zonas
 * físicas de una obra concreta: lo único del reporte diario que no sirve
 * igual en cualquier obra.
 *
 * Gobernadas por el mismo permiso que los reportes, y además por
 * checkProjectAccess, porque viven dentro de un proyecto.
 */

import { Router, Request, Response } from 'express';
import { query } from '../database/config.js';
import {
  authenticateToken,
  checkPermission,
  checkProjectAccess,
} from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { registrarAudit } from '../services/auditLog.js';

const router = Router();

interface AreaRow {
  id: number;
  proyecto_id: number;
  nombre: string;
  orden: number;
  activo: boolean;
}

// El nombre viaja en el cuerpo de tres endpoints; una sola lectura para todos.
function leerNombre(req: Request): string {
  return String((req.body as { nombre?: unknown })?.nombre ?? '').trim();
}

// GET /api/proyecto-areas/:proyectoId — las activas, en orden
router.get(
  '/:proyectoId',
  authenticateToken,
  checkPermission('reportes'),
  checkProjectAccess('proyectoId'),
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const result = await query<AreaRow>(
      `SELECT id, proyecto_id, nombre, orden, activo
         FROM proyecto_areas
        WHERE proyecto_id = $1 AND activo = true
        ORDER BY orden, id`,
      [req.params.proyectoId],
    );
    res.json({ success: true, data: result.rows });
  }),
);

// POST /api/proyecto-areas/:proyectoId — agregar una
router.post(
  '/:proyectoId',
  authenticateToken,
  checkPermission('reportes'),
  checkProjectAccess('proyectoId'),
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const nombre = leerNombre(req);
    if (!nombre) {
      res
        .status(400)
        .json({ success: false, message: 'El nombre del área es obligatorio' });
      return;
    }

    // Hay un índice único sobre (proyecto_id, lower(nombre)) para las activas.
    // Se comprueba antes para poder dar un mensaje entendible en vez de dejar
    // que reviente la restricción.
    const repetida = await query(
      `SELECT 1 FROM proyecto_areas
        WHERE proyecto_id = $1 AND lower(nombre) = lower($2) AND activo = true`,
      [req.params.proyectoId, nombre],
    );
    if (repetida.rows.length > 0) {
      res
        .status(409)
        .json({ success: false, message: `El proyecto ya tiene un área "${nombre}"` });
      return;
    }

    const orden = await query<{ next: number }>(
      `SELECT COALESCE(MAX(orden), 0) + 1 AS next
         FROM proyecto_areas WHERE proyecto_id = $1`,
      [req.params.proyectoId],
    );

    const result = await query<AreaRow>(
      `INSERT INTO proyecto_areas (proyecto_id, nombre, orden, creado_por)
       VALUES ($1, $2, $3, $4)
       RETURNING id, proyecto_id, nombre, orden, activo`,
      [req.params.proyectoId, nombre, orden.rows[0].next, req.user!.id],
    );

    await registrarAudit(req.user!.id, 'crear', 'proyecto_area', result.rows[0].id, {
      proyecto_id: Number(req.params.proyectoId),
      nombre,
    });

    res.status(201).json({ success: true, data: result.rows[0] });
  }),
);

// PUT /api/proyecto-areas/:proyectoId/:id — renombrar
router.put(
  '/:proyectoId/:id',
  authenticateToken,
  checkPermission('reportes'),
  checkProjectAccess('proyectoId'),
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const nombre = leerNombre(req);
    if (!nombre) {
      res
        .status(400)
        .json({ success: false, message: 'El nombre del área es obligatorio' });
      return;
    }

    const previo = await query<{ nombre: string }>(
      `SELECT nombre FROM proyecto_areas
        WHERE id = $1 AND proyecto_id = $2 AND activo = true`,
      [req.params.id, req.params.proyectoId],
    );
    if (previo.rows.length === 0) {
      res.status(404).json({ success: false, message: 'Área no encontrada' });
      return;
    }

    const repetida = await query(
      `SELECT 1 FROM proyecto_areas
        WHERE proyecto_id = $1 AND lower(nombre) = lower($2)
          AND activo = true AND id <> $3`,
      [req.params.proyectoId, nombre, req.params.id],
    );
    if (repetida.rows.length > 0) {
      res
        .status(409)
        .json({ success: false, message: `El proyecto ya tiene un área "${nombre}"` });
      return;
    }

    const result = await query<AreaRow>(
      `UPDATE proyecto_areas SET nombre = $1
        WHERE id = $2 AND proyecto_id = $3
        RETURNING id, proyecto_id, nombre, orden, activo`,
      [nombre, req.params.id, req.params.proyectoId],
    );

    await registrarAudit(
      req.user!.id,
      'editar',
      'proyecto_area',
      Number(req.params.id),
      { nombre: { antes: previo.rows[0].nombre, despues: nombre } },
    );

    res.json({ success: true, data: result.rows[0] });
  }),
);

// DELETE /api/proyecto-areas/:proyectoId/:id
//
// Baja lógica, no borrado. Los reportes que ya señalan esta área siguen
// señalándola y se siguen viendo igual; el área solo deja de ofrecerse en
// reportes nuevos.
router.delete(
  '/:proyectoId/:id',
  authenticateToken,
  checkPermission('reportes'),
  checkProjectAccess('proyectoId'),
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const result = await query(
      `UPDATE proyecto_areas SET activo = false
        WHERE id = $1 AND proyecto_id = $2 AND activo = true`,
      [req.params.id, req.params.proyectoId],
    );

    if (result.rowCount === 0) {
      res.status(404).json({ success: false, message: 'Área no encontrada' });
      return;
    }

    await registrarAudit(
      req.user!.id,
      'eliminar',
      'proyecto_area',
      Number(req.params.id),
      { proyecto_id: Number(req.params.proyectoId) },
    );

    res.json({ success: true });
  }),
);

export default router;
