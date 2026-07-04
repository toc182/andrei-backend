import { Router, Request, Response } from 'express';
import { query } from '../database/config.js';
import { authenticateToken, requireAdmin } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import type { UserPermissions } from '../types/auth.js';

const router = Router();

// Todas las rutas requieren admin o co-admin
router.use(authenticateToken, requireAdmin);

interface UserWithPermissions {
  id: number;
  nombre: string;
  email: string;
  rol: string;
  activo: boolean;
  acceso_global: boolean | null;
  proyectos_crear: boolean | null;
  proyectos_editar: boolean | null;
  proyectos_eliminar: boolean | null;
  clientes_agregar: boolean | null;
  clientes_editar: boolean | null;
  clientes_eliminar: boolean | null;
  solicitudes_editar_todas: boolean | null;
  requisiciones_editar_todas: boolean | null;
  equipos_ver: boolean | null;
  equipos_agregar: boolean | null;
  equipos_editar: boolean | null;
  equipos_eliminar: boolean | null;
  equipos_asignacion: boolean | null;
  equipos_uso: boolean | null;
  equipos_editar_asignacion: boolean | null;
  documentos_acceso: boolean | null;
  oportunidades_ver: boolean | null;
  registrar_pago: boolean | null;
  caja_menuda: boolean | null;
  cuentas: boolean | null;
  cotizaciones: boolean | null;
  cronogramas_ver: boolean | null;
}

// GET /users — lista usuarios (excluye admin) con sus permisos
router.get(
  '/users',
  asyncHandler(async (_req: Request, res: Response): Promise<void> => {
    const result = await query<UserWithPermissions>(
      `SELECT u.id, u.nombre, u.email, u.rol, u.activo,
            up.acceso_global, up.proyectos_crear, up.proyectos_editar, up.proyectos_eliminar,
            up.clientes_agregar, up.clientes_editar, up.clientes_eliminar,
            up.solicitudes_editar_todas, up.requisiciones_editar_todas,
            up.equipos_ver, up.equipos_agregar, up.equipos_editar, up.equipos_eliminar,
            up.equipos_asignacion, up.equipos_uso, up.equipos_editar_asignacion,
            up.documentos_acceso, up.oportunidades_ver, up.registrar_pago, up.caja_menuda, up.cuentas,
            up.cotizaciones, up.cronogramas_ver
     FROM users u
     LEFT JOIN user_permissions up ON up.user_id = u.id
     WHERE u.rol != 'admin'
     ORDER BY u.nombre`,
    );

    res.json({
      success: true,
      users: result.rows,
    });
  }),
);

// GET /:userId — permisos de un usuario
router.get(
  '/:userId',
  asyncHandler(
    async (req: Request<{ userId: string }>, res: Response): Promise<void> => {
      const { userId } = req.params;
      const result = await query<UserPermissions>(
        `SELECT acceso_global, proyectos_crear, proyectos_editar, proyectos_eliminar,
            clientes_agregar, clientes_editar, clientes_eliminar,
            solicitudes_editar_todas, requisiciones_editar_todas,
            equipos_ver, equipos_agregar, equipos_editar, equipos_eliminar,
            equipos_asignacion, equipos_uso, equipos_editar_asignacion,
            documentos_acceso, oportunidades_ver, registrar_pago, caja_menuda, cuentas,
            cotizaciones, cronogramas_ver
     FROM user_permissions WHERE user_id = $1`,
        [userId],
      );

      if (result.rows.length === 0) {
        res
          .status(404)
          .json({ success: false, message: 'Permisos no encontrados' });
        return;
      }

      res.json({
        success: true,
        permissions: result.rows[0],
      });
    },
  ),
);

// PUT /:userId — actualizar permisos (UPSERT)
router.put(
  '/:userId',
  asyncHandler(
    async (req: Request<{ userId: string }>, res: Response): Promise<void> => {
      const { userId } = req.params;
      const permissions = req.body as Partial<UserPermissions>;

      const result = await query(
        `INSERT INTO user_permissions (user_id, acceso_global, proyectos_crear, proyectos_editar, proyectos_eliminar,
       clientes_agregar, clientes_editar, clientes_eliminar,
       solicitudes_editar_todas, requisiciones_editar_todas,
       equipos_ver, equipos_agregar, equipos_editar, equipos_eliminar,
       equipos_asignacion, equipos_uso, equipos_editar_asignacion,
       documentos_acceso, oportunidades_ver, registrar_pago, caja_menuda, cuentas, cotizaciones, cronogramas_ver, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, CURRENT_TIMESTAMP)
     ON CONFLICT (user_id) DO UPDATE SET
       acceso_global = EXCLUDED.acceso_global,
       proyectos_crear = EXCLUDED.proyectos_crear,
       proyectos_editar = EXCLUDED.proyectos_editar,
       proyectos_eliminar = EXCLUDED.proyectos_eliminar,
       clientes_agregar = EXCLUDED.clientes_agregar,
       clientes_editar = EXCLUDED.clientes_editar,
       clientes_eliminar = EXCLUDED.clientes_eliminar,
       solicitudes_editar_todas = EXCLUDED.solicitudes_editar_todas,
       requisiciones_editar_todas = EXCLUDED.requisiciones_editar_todas,
       equipos_ver = EXCLUDED.equipos_ver,
       equipos_agregar = EXCLUDED.equipos_agregar,
       equipos_editar = EXCLUDED.equipos_editar,
       equipos_eliminar = EXCLUDED.equipos_eliminar,
       equipos_asignacion = EXCLUDED.equipos_asignacion,
       equipos_uso = EXCLUDED.equipos_uso,
       equipos_editar_asignacion = EXCLUDED.equipos_editar_asignacion,
       documentos_acceso = EXCLUDED.documentos_acceso,
       oportunidades_ver = EXCLUDED.oportunidades_ver,
       registrar_pago = EXCLUDED.registrar_pago,
       caja_menuda = EXCLUDED.caja_menuda,
       cuentas = EXCLUDED.cuentas,
       cotizaciones = EXCLUDED.cotizaciones,
       cronogramas_ver = EXCLUDED.cronogramas_ver,
       updated_at = CURRENT_TIMESTAMP`,
        [
          userId,
          permissions.acceso_global ?? false,
          permissions.proyectos_crear ?? false,
          permissions.proyectos_editar ?? false,
          permissions.proyectos_eliminar ?? false,
          permissions.clientes_agregar ?? false,
          permissions.clientes_editar ?? false,
          permissions.clientes_eliminar ?? false,
          permissions.solicitudes_editar_todas ?? false,
          permissions.requisiciones_editar_todas ?? false,
          permissions.equipos_ver ?? true,
          permissions.equipos_agregar ?? false,
          permissions.equipos_editar ?? false,
          permissions.equipos_eliminar ?? false,
          permissions.equipos_asignacion ?? false,
          permissions.equipos_uso ?? false,
          permissions.equipos_editar_asignacion ?? false,
          permissions.documentos_acceso ?? false,
          permissions.oportunidades_ver ?? false,
          permissions.registrar_pago ?? false,
          permissions.caja_menuda ?? false,
          permissions.cuentas ?? false,
          permissions.cotizaciones ?? false,
          permissions.cronogramas_ver ?? false,
        ],
      );

      res.json({
        success: true,
        message: 'Permisos actualizados',
        rowCount: result.rowCount,
      });
    },
  ),
);

// GET /:userId/projects — proyectos asignados
router.get(
  '/:userId/projects',
  asyncHandler(
    async (req: Request<{ userId: string }>, res: Response): Promise<void> => {
      const { userId } = req.params;
      const result = await query<{ proyecto_id: number; nombre: string }>(
        `SELECT upa.proyecto_id, p.nombre
     FROM user_project_access upa
     JOIN proyectos p ON p.id = upa.proyecto_id
     WHERE upa.user_id = $1
     ORDER BY p.nombre`,
        [userId],
      );

      res.json({
        success: true,
        projects: result.rows,
      });
    },
  ),
);

// PUT /:userId/projects — actualizar proyectos asignados (DELETE + INSERT en transacción)
router.put(
  '/:userId/projects',
  asyncHandler(
    async (req: Request<{ userId: string }>, res: Response): Promise<void> => {
      const { userId } = req.params;
      const { projectIds } = req.body as { projectIds: number[] };

      if (!Array.isArray(projectIds)) {
        res
          .status(400)
          .json({ success: false, message: 'projectIds debe ser un array' });
        return;
      }

      // DELETE existing
      await query('DELETE FROM user_project_access WHERE user_id = $1', [
        userId,
      ]);

      // INSERT new ones
      if (projectIds.length > 0) {
        const values = projectIds.map((pid, i) => `($1, $${i + 2})`).join(', ');
        await query(
          `INSERT INTO user_project_access (user_id, proyecto_id) VALUES ${values} ON CONFLICT DO NOTHING`,
          [userId, ...projectIds],
        );
      }

      res.json({
        success: true,
        message: 'Proyectos asignados actualizados',
        count: projectIds.length,
      });
    },
  ),
);

export default router;
