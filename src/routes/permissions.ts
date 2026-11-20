import { Router, Request, Response } from 'express';
import { query, pool } from '../database/config.js';
import { authenticateToken, requireAdmin, VALID_PERMISSIONS } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { registrarAudit } from '../services/auditLog.js';
import { coincideConPerfil, escribirLlavesDePerfil, llavesDelPerfil } from '../services/perfiles.js';
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
  permission_profile_id: number | null;
  proyectos: number[];
  acceso_global: boolean | null;
  proyectos_crear: boolean | null;
  proyectos_editar: boolean | null;
  proyectos_eliminar: boolean | null;
  clientes_agregar: boolean | null;
  clientes_editar: boolean | null;
  clientes_eliminar: boolean | null;
  solicitudes_editar_todas: boolean | null;
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
  desglose_ver: boolean | null;
  reportes: boolean | null;
  solicitudes_ver: boolean | null;
  requisiciones_ver: boolean | null;
  requisiciones_crear: boolean | null;
  requisiciones_atender: boolean | null;
  clientes_ver: boolean | null;
  costos_ver: boolean | null;
  ordenes_ver: boolean | null;
  ordenes_entregas: boolean | null;
}

// GET /users — lista usuarios (excluye admin) con sus permisos
router.get(
  '/users',
  asyncHandler(async (_req: Request, res: Response): Promise<void> => {
    const result = await query<UserWithPermissions>(
      `SELECT u.id, u.nombre, u.email, u.rol, u.activo, u.permission_profile_id,
            -- Los proyectos de cada persona, para la lista de Personas sin una
            -- llamada por persona.
            COALESCE((SELECT array_agg(upa.proyecto_id ORDER BY upa.proyecto_id)
                        FROM user_project_access upa WHERE upa.user_id = u.id), '{}') AS proyectos,
            up.acceso_global, up.proyectos_crear, up.proyectos_editar, up.proyectos_eliminar,
            up.clientes_agregar, up.clientes_editar, up.clientes_eliminar,
            up.solicitudes_editar_todas,
            up.equipos_ver, up.equipos_agregar, up.equipos_editar, up.equipos_eliminar,
            up.equipos_asignacion, up.equipos_uso, up.equipos_editar_asignacion,
            up.documentos_acceso, up.oportunidades_ver, up.registrar_pago, up.caja_menuda, up.cuentas,
            up.cotizaciones, up.cronogramas_ver, up.desglose_ver, up.reportes,
            up.solicitudes_ver, up.requisiciones_ver, up.requisiciones_crear, up.requisiciones_atender, up.clientes_ver, up.costos_ver,
            up.ordenes_ver, up.ordenes_entregas
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
            solicitudes_editar_todas,
            equipos_ver, equipos_agregar, equipos_editar, equipos_eliminar,
            equipos_asignacion, equipos_uso, equipos_editar_asignacion,
            documentos_acceso, oportunidades_ver, registrar_pago, caja_menuda, cuentas,
            cotizaciones, cronogramas_ver, desglose_ver, reportes,
            solicitudes_ver, requisiciones_ver, requisiciones_crear, requisiciones_atender, clientes_ver, costos_ver,
            ordenes_ver, ordenes_entregas
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

// PUT /:userId — actualizar permisos y perfil.
//
// Escribe SOLO las llaves que llegan (la regla de los PUT: lo que no vino no se
// toca). La pantalla vieja manda todas y le sale igual que antes; la nueva no
// manda las que no muestra, y quedan como estaban. Una llave que falta en una
// fila nueva nace con el valor de la columna (false; equipos_ver, true), igual
// que antes.
//
// permission_profile_id:
//   un número  la persona toma ese perfil: sus llaves de perfil pasan a ser las
//              del perfil, digan lo que digan las que llegaron.
//   null       «Personalizado»: deja el perfil y se queda con sus llaves.
//   no viene   se queda en su perfil mientras sus llaves sigan siendo las del
//              perfil; si cambió alguna, pasa a «Personalizado».
router.put(
  '/:userId',
  asyncHandler(
    async (req: Request<{ userId: string }>, res: Response): Promise<void> => {
      const userId = parseInt(req.params.userId, 10);
      const cuerpo = (req.body ?? {}) as Record<string, unknown>;
      const perfilPedido = cuerpo.permission_profile_id;
      if (
        !Number.isInteger(userId) ||
        (perfilPedido !== undefined && perfilPedido !== null && !Number.isInteger(perfilPedido))
      ) {
        res.status(400).json({ success: false, message: 'Datos inválidos' });
        return;
      }

      const persona = await query<{ rol: string; permission_profile_id: number | null }>(
        'SELECT rol, permission_profile_id FROM users WHERE id = $1',
        [userId],
      );
      if (persona.rows.length === 0) {
        res.status(404).json({ success: false, message: 'Usuario no encontrado' });
        return;
      }
      if (typeof perfilPedido === 'number' && persona.rows[0].rol !== 'usuario') {
        res.status(400).json({
          success: false,
          message: 'Gerencia y el dueño no llevan perfil: ya pueden todo',
        });
        return;
      }

      // Los nombres de columna salen de la lista blanca, nunca del cuerpo.
      const llaves = VALID_PERMISSIONS.filter((k) => typeof cuerpo[k] === 'boolean');
      const perfilAntes = persona.rows[0].permission_profile_id;

      const db = await pool.connect();
      try {
        await db.query('BEGIN');
        if (llaves.length > 0) {
          await db.query(
            `INSERT INTO user_permissions (user_id, ${llaves.join(', ')}, updated_at)
             VALUES ($1, ${llaves.map((_, i) => `$${i + 2}`).join(', ')}, CURRENT_TIMESTAMP)
             ON CONFLICT (user_id) DO UPDATE SET
               ${llaves.map((k) => `${k} = EXCLUDED.${k}`).join(', ')},
               updated_at = CURRENT_TIMESTAMP`,
            [userId, ...llaves.map((k) => cuerpo[k] as boolean)],
          );
        }

        let perfilDespues = perfilAntes;
        let cambiosDelPerfil: Awaited<ReturnType<typeof escribirLlavesDePerfil>> = [];
        if (typeof perfilPedido === 'number') {
          const delPerfil = await llavesDelPerfil(db, perfilPedido);
          if (!delPerfil) {
            await db.query('ROLLBACK');
            res.status(400).json({ success: false, message: 'Ese perfil no existe' });
            return;
          }
          cambiosDelPerfil = await escribirLlavesDePerfil(db, userId, delPerfil);
          perfilDespues = perfilPedido;
        } else if (perfilPedido === null) {
          perfilDespues = null;
        } else if (perfilAntes !== null) {
          const delPerfil = await llavesDelPerfil(db, perfilAntes);
          if (!delPerfil || !(await coincideConPerfil(db, userId, delPerfil))) perfilDespues = null;
        }
        if (perfilDespues !== perfilAntes) {
          await db.query('UPDATE users SET permission_profile_id = $1 WHERE id = $2', [
            perfilDespues,
            userId,
          ]);
        }

        await registrarAudit(req.user!.id, 'editar_permisos', 'user', userId, {
          ...Object.fromEntries(llaves.map((k) => [k, cuerpo[k]])),
          ...(perfilDespues !== perfilAntes
            ? { perfil_antes: perfilAntes, perfil_despues: perfilDespues }
            : {}),
          // Lo que el perfil le cambió de verdad, llave por llave.
          ...(cambiosDelPerfil.length > 0 ? { cambios_del_perfil: cambiosDelPerfil } : {}),
        }, db);
        await db.query('COMMIT');
        res.json({
          success: true,
          message: 'Permisos actualizados',
          permission_profile_id: perfilDespues,
        });
      } catch (err) {
        await db.query('ROLLBACK');
        throw err;
      } finally {
        db.release();
      }
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

      // DELETE + INSERT atomically: without the transaction, a failure between the two
      // steps would leave the user assigned to zero projects (old list gone, new one
      // never written). ROLLBACK restores the old list on any mid-way error.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('DELETE FROM user_project_access WHERE user_id = $1', [
          userId,
        ]);
        if (projectIds.length > 0) {
          const values = projectIds.map((pid, i) => `($1, $${i + 2})`).join(', ');
          await client.query(
            `INSERT INTO user_project_access (user_id, proyecto_id) VALUES ${values} ON CONFLICT DO NOTHING`,
            [userId, ...projectIds],
          );
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      await registrarAudit(req.user!.id, 'editar_proyectos_asignados', 'user', parseInt(userId, 10), {
        proyectos: projectIds,
      });

      res.json({
        success: true,
        message: 'Proyectos asignados actualizados',
        count: projectIds.length,
      });
    },
  ),
);

export default router;
