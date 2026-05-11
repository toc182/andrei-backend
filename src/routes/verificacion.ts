import { Router, Request, Response } from 'express';
import { param, validationResult } from 'express-validator';
import { query } from '../database/config.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

const router = Router();

// --- GET /:codigo — Verificar solicitud de pago (público, sin auth) ---
router.get(
  '/:codigo',
  [param('codigo').isAlphanumeric().isLength({ min: 8, max: 10 })],
  asyncHandler(
    async (req: Request<{ codigo: string }>, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({
          success: false,
          message: 'Código de verificación no válido',
        });
        return;
      }

      const { codigo } = req.params;

      const result = await query<{
        numero: string;
        fecha: string;
        beneficiario: string | null;
        proveedor: string;
        concepto: string | null;
        monto_total: number;
        estado: string;
        proyecto_nombre: string | null;
      }>(
        `
    SELECT
      sp.numero,
      sp.fecha,
      sp.beneficiario,
      sp.proveedor,
      sp.observaciones as concepto,
      sp.monto_total,
      sp.estado,
      COALESCE(p.nombre_corto, p.nombre) as proyecto_nombre
    FROM solicitudes_pago sp
    LEFT JOIN proyectos p ON sp.proyecto_id = p.id
    WHERE sp.codigo_verificacion = $1 AND sp.activo = true
  `,
        [codigo.toUpperCase()],
      );

      if (result.rows.length === 0) {
        res.status(404).json({
          success: false,
          message: 'Código de verificación no válido',
        });
        return;
      }

      // Obtener aprobaciones
      const aprobaciones = await query<{
        usuario_nombre: string;
        fecha: string;
      }>(
        `
    SELECT u.nombre as usuario_nombre, sa.fecha
    FROM solicitud_aprobaciones sa
    JOIN users u ON sa.user_id = u.id
    JOIN solicitudes_pago sp ON sp.id = sa.solicitud_pago_id AND sp.activo = true
    WHERE sp.codigo_verificacion = $1 AND sa.accion = 'aprobado'
    ORDER BY sa.orden
  `,
        [codigo.toUpperCase()],
      );

      const sol = result.rows[0];

      res.json({
        success: true,
        data: {
          numero: sol.numero,
          fecha: sol.fecha,
          beneficiario: sol.beneficiario || sol.proveedor,
          concepto: sol.concepto,
          monto_total: sol.monto_total,
          estado: sol.estado,
          proyecto_nombre: sol.proyecto_nombre,
          verificado: true,
          aprobaciones: aprobaciones.rows,
        },
      });
    },
  ),
);

export default router;
