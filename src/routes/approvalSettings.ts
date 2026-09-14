import { Router, Request, Response } from 'express';
import { param, body, validationResult } from 'express-validator';
import { query, pool } from '../database/config.js';
import { authenticateToken, requireAdmin } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

const router = Router();

router.use(authenticateToken);

// --- Interfaces ---

interface ApproverRow {
  id: number;
  proyecto_id: number;
  user_id: number;
  orden: number;
  activo: boolean;
  nombre: string;
  email: string;
}

interface ApproverInput {
  user_id: number;
  orden: number;
}

// --- GET /project/:projectId — Obtener aprobadores del proyecto ---
router.get(
  '/project/:projectId',
  [param('projectId').isInt()],
  asyncHandler(
    async (
      req: Request<{ projectId: string }>,
      res: Response,
    ): Promise<void> => {
      const { projectId } = req.params;

      const result = await query<ApproverRow>(
        `
    SELECT pas.*, u.nombre, u.email
    FROM proyecto_ajustes_aprobacion pas
    JOIN users u ON pas.user_id = u.id
    WHERE pas.proyecto_id = $1 AND pas.activo = true
    ORDER BY pas.orden
  `,
        [projectId],
      );

      res.json({ success: true, approvers: result.rows });
    },
  ),
);

// --- PUT /project/:projectId — Reemplazar lista completa de aprobadores ---
// Cambiar quien aprueba los pagos de un proyecto es de admin/co-admin. El GET
// de abajo NO lleva requireAdmin: las dos pantallas de solicitudes lo usan para
// pintar la cadena de aprobacion.
router.put(
  '/project/:projectId',
  requireAdmin,
  [
    param('projectId').isInt(),
    body('approvers')
      .isArray()
      .withMessage('Se requiere un array de aprobadores'),
  ],
  asyncHandler(
    async (
      req: Request<{ projectId: string }>,
      res: Response,
    ): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({
          success: false,
          message: 'Datos inválidos',
          errors: errors.array(),
        });
        return;
      }

      const { projectId } = req.params;
      const { approvers } = req.body as { approvers: ApproverInput[] };

      // Verificar que el proyecto existe
      const project = await query('SELECT id FROM proyectos WHERE id = $1', [
        projectId,
      ]);
      if (project.rows.length === 0) {
        res
          .status(404)
          .json({ success: false, message: 'Proyecto no encontrado' });
        return;
      }

      // Transaccion de verdad: pool.connect() + BEGIN en ESE cliente.
      //
      // Estaba escrito con query('BEGIN') sobre el pool, que no abre nada: cada
      // query toma la conexion que haya libre. Con el servidor ocupado, si el
      // INSERT del final fallaba, el ROLLBACK caia en otra conexion y los pasos
      // de antes se quedaban hechos —solicitudes devueltas a pendiente sin sus
      // aprobaciones, y el proyecto sin aprobadores—, y el BEGIN dejaba una
      // conexion con una transaccion abierta que el pool le prestaba despues a
      // cualquier otra peticion. Lo prueba
      // scripts/aprobadores-transaccion-humo.ts.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Resetear solicitudes no finalizadas del proyecto
        const affected = await client.query<{ id: number }>(
          `SELECT id FROM solicitudes_pago WHERE proyecto_id = $1 AND estado NOT IN ('pagada', 'facturada') AND activo = true`,
          [projectId],
        );

        if (affected.rows.length > 0) {
          const affectedIds = affected.rows.map((r) => r.id);
          await client.query(
            'DELETE FROM solicitud_aprobaciones WHERE solicitud_pago_id = ANY($1::int[])',
            [affectedIds],
          );
          await client.query(
            'DELETE FROM solicitud_revisiones WHERE solicitud_pago_id = ANY($1::int[])',
            [affectedIds],
          );
          await client.query(
            `UPDATE solicitudes_pago SET estado = 'pendiente' WHERE id = ANY($1::int[]) AND activo = true`,
            [affectedIds],
          );
        }

        // Eliminar aprobadores actuales
        await client.query(
          'DELETE FROM proyecto_ajustes_aprobacion WHERE proyecto_id = $1',
          [projectId],
        );

        // Insertar nuevos en una sola query
        if (approvers.length > 0) {
          const values = approvers
            .map((_, i) => `($1, $${i * 2 + 2}, $${i * 2 + 3}, true)`)
            .join(', ');
          const params: unknown[] = [
            projectId,
            ...approvers.flatMap((a) => [a.user_id, a.orden]),
          ];
          await client.query(
            `
        INSERT INTO proyecto_ajustes_aprobacion (proyecto_id, user_id, orden, activo)
        VALUES ${values}
      `,
            params,
          );
        }

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }

      // Retornar la lista actualizada
      const result = await query<ApproverRow>(
        `
    SELECT pas.*, u.nombre, u.email
    FROM proyecto_ajustes_aprobacion pas
    JOIN users u ON pas.user_id = u.id
    WHERE pas.proyecto_id = $1 AND pas.activo = true
    ORDER BY pas.orden
  `,
        [projectId],
      );

      res.json({
        success: true,
        message: 'Aprobadores actualizados',
        approvers: result.rows,
      });
    },
  ),
);

export default router;
