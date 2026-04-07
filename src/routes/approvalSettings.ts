import { Router, Request, Response } from 'express';
import { param, body, validationResult } from 'express-validator';
import { query } from '../database/config.js';
import { authenticateToken } from '../middleware/auth.js';
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
    FROM project_approval_settings pas
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
router.put(
  '/project/:projectId',
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

      await query('BEGIN');

      try {
        // Resetear solicitudes no finalizadas del proyecto
        const affected = await query<{ id: number }>(
          `SELECT id FROM solicitudes_pago WHERE proyecto_id = $1 AND estado NOT IN ('pagada', 'facturada')`,
          [projectId],
        );

        if (affected.rows.length > 0) {
          const affectedIds = affected.rows.map((r) => r.id);
          await query(
            'DELETE FROM solicitud_aprobaciones WHERE solicitud_pago_id = ANY($1::int[])',
            [affectedIds],
          );
          await query(
            'DELETE FROM solicitud_revisiones WHERE solicitud_pago_id = ANY($1::int[])',
            [affectedIds],
          );
          await query(
            `UPDATE solicitudes_pago SET estado = 'pendiente' WHERE id = ANY($1::int[])`,
            [affectedIds],
          );
        }

        // Eliminar aprobadores actuales
        await query(
          'DELETE FROM project_approval_settings WHERE proyecto_id = $1',
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
          await query(
            `
        INSERT INTO project_approval_settings (proyecto_id, user_id, orden, activo)
        VALUES ${values}
      `,
            params,
          );
        }

        await query('COMMIT');
      } catch (err) {
        await query('ROLLBACK');
        throw err;
      }

      // Retornar la lista actualizada
      const result = await query<ApproverRow>(
        `
    SELECT pas.*, u.nombre, u.email
    FROM project_approval_settings pas
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
