import { Router, Request, Response } from 'express';
import { param, body, validationResult } from 'express-validator';
import type { PoolClient } from 'pg';
import { query, pool } from '../database/config.js';
import { authenticateToken, requireAdmin } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { registrarAudit } from '../services/auditLog.js';

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

// La cadena tal como la guarda el rastro de un cambio: antes y despues.
const leerCadena = (db: PoolClient, projectId: string) =>
  db.query<{ user_id: number; orden: number; nombre: string }>(
    `SELECT pas.user_id, pas.orden, u.nombre
       FROM proyecto_ajustes_aprobacion pas
       JOIN users u ON u.id = pas.user_id
      WHERE pas.proyecto_id = $1 AND pas.activo = true
      ORDER BY pas.orden`,
    [projectId],
  );

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
//
// Cada cambio queda en audit_log (accion 'editar_aprobadores', entidad
// 'proyecto'): quien, cuando, la cadena antes y despues, y cada solicitud que
// volvio a cero con las firmas y revisiones que perdio. No se ve en ninguna
// pantalla; se consulta cuando alguien pregunta (decision de Ivan, 2026-09-21).
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
      let cambio = false;
      try {
        await client.query('BEGIN');

        // Dos guardados a la vez del mismo proyecto leerian la misma lista de
        // antes y el rastro de uno de los dos mentiria: el lock los pone en fila.
        await client.query('SELECT id FROM proyectos WHERE id = $1 FOR UPDATE', [
          projectId,
        ]);

        const antes = await leerCadena(client, projectId);

        // La cadena es la secuencia de personas: mismas personas en el mismo
        // orden = no cambio nada, aunque los numeros de orden vengan distintos.
        // Guardar sin tocar nada devolvia a pendiente todo el proyecto. Cambiar
        // solo el orden SI es un cambio: el orden decide quien firma despues.
        const nuevos = [...approvers].sort((a, b) => a.orden - b.orden);
        cambio =
          nuevos.length !== antes.rows.length ||
          nuevos.some((a, i) => Number(a.user_id) !== antes.rows[i].user_id);

        if (cambio) {
          // Vuelven a cero solo las que estan dentro de la cadena: pendientes y
          // aprobadas sin pagar. El resto no se toca: las pagadas con cualquiera
          // de sus nombres (pagada, facturada; reembolsada y transferida son el
          // «pagada» de reembolsos y aperturas de caja menuda; devolucion viene
          // despues del pago), los borradores que nadie ha enviado, y las
          // rechazadas, que vuelven a la cola solo cuando quien las pidio las
          // corrige y las reenvia.
          const afectadas = await client.query<{
            id: number;
            numero: string;
            estado: string;
          }>(
            `SELECT id, numero, estado FROM solicitudes_pago
              WHERE proyecto_id = $1 AND estado IN ('pendiente', 'aprobada') AND activo = true
              ORDER BY id`,
            [projectId],
          );
          const ids = afectadas.rows.map((r) => r.id);

          // Lo que se borra queda escrito en el rastro: quien habia firmado o
          // revisado cada solicitud antes de que volviera a cero.
          const aprobaciones = await client.query<{
            solicitud_pago_id: number;
            user_id: number;
            nombre: string;
            orden: number;
            accion: string;
            fecha: Date;
          }>(
            `WITH borradas AS (
               DELETE FROM solicitud_aprobaciones WHERE solicitud_pago_id = ANY($1::int[])
               RETURNING solicitud_pago_id, user_id, orden, accion, fecha
             )
             SELECT b.*, u.nombre FROM borradas b JOIN users u ON u.id = b.user_id
             ORDER BY b.solicitud_pago_id, b.orden`,
            [ids],
          );
          const revisiones = await client.query<{
            solicitud_pago_id: number;
            user_id: number;
            nombre: string;
            fecha: Date;
          }>(
            `WITH borradas AS (
               DELETE FROM solicitud_revisiones WHERE solicitud_pago_id = ANY($1::int[])
               RETURNING solicitud_pago_id, user_id, created_at AS fecha
             )
             SELECT b.*, u.nombre FROM borradas b JOIN users u ON u.id = b.user_id
             ORDER BY b.solicitud_pago_id, b.fecha`,
            [ids],
          );
          await client.query(
            `UPDATE solicitudes_pago SET estado = 'pendiente', updated_at = CURRENT_TIMESTAMP
              WHERE id = ANY($1::int[]) AND estado = 'aprobada'`,
            [ids],
          );

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

          const despues = await leerCadena(client, projectId);

          // Una pendiente sin firmas ni revisiones no perdio nada: no se anota.
          const reiniciadas = afectadas.rows
            .map((s) => ({
              id: s.id,
              numero: s.numero,
              estado_antes: s.estado,
              aprobaciones: aprobaciones.rows
                .filter((a) => a.solicitud_pago_id === s.id)
                .map(({ user_id, nombre, orden, accion, fecha }) => ({
                  user_id, nombre, orden, accion, fecha,
                })),
              revisiones: revisiones.rows
                .filter((r) => r.solicitud_pago_id === s.id)
                .map(({ user_id, nombre, fecha }) => ({ user_id, nombre, fecha })),
            }))
            .filter(
              (s) =>
                s.estado_antes !== 'pendiente' ||
                s.aprobaciones.length > 0 ||
                s.revisiones.length > 0,
            );

          // Dentro de la transaccion: el rastro y el cambio se guardan juntos
          // o no se guarda ninguno.
          await registrarAudit(
            req.user!.id,
            'editar_aprobadores',
            'proyecto',
            Number(projectId),
            {
              antes: antes.rows,
              despues: despues.rows,
              solicitudes_reiniciadas: reiniciadas,
            },
            client,
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
        message: cambio
          ? 'Aprobadores actualizados'
          : 'Los aprobadores no cambiaron',
        approvers: result.rows,
      });
    },
  ),
);

export default router;
