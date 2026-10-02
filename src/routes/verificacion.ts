/**
 * La pagina publica del codigo de verificacion, sin sesion.
 *
 * Responde por DOS papeles, porque los dos salen de Pinellas con su QR: la
 * solicitud de pago y la orden de compra. El codigo dice cual es —cada tabla
 * tiene el suyo, unico— y la respuesta trae `tipo` para que la pagina sepa que
 * dibujar.
 *
 * De la orden NO se dice cuanto se ha pagado ni cuanto se debe. Cualquiera con
 * el codigo puede abrir esto: sirve para confirmar que el papel es de verdad y
 * ver quien lo aprobo, no para ensenarle a un tercero la posicion de pago de
 * Pinellas (decision de Ivan del 2026-09-30).
 */
import { Router, Request, Response } from 'express';
import { param, validationResult } from 'express-validator';
import { query } from '../database/config.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

const router = Router();

interface Aprobacion {
  usuario_nombre: string;
  fecha: string;
}

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

      const codigo = req.params.codigo.toUpperCase();

      const solicitud = await query<{
        numero: string;
        fecha: string;
        beneficiario: string | null;
        proveedor: string;
        concepto: string | null;
        monto_total: number;
        estado: string;
        proyecto_nombre: string | null;
      }>(
        `SELECT sp.numero, sp.fecha, sp.beneficiario, sp.proveedor,
                sp.observaciones AS concepto, sp.monto_total, sp.estado,
                COALESCE(p.nombre_corto, p.nombre) AS proyecto_nombre
           FROM solicitudes_pago sp
           LEFT JOIN proyectos p ON sp.proyecto_id = p.id
          WHERE sp.codigo_verificacion = $1 AND sp.activo = true`,
        [codigo],
      );

      if (solicitud.rows.length > 0) {
        const aprobaciones = await query<Aprobacion>(
          `SELECT u.nombre AS usuario_nombre, sa.fecha
             FROM solicitud_aprobaciones sa
             JOIN users u ON sa.user_id = u.id
             JOIN solicitudes_pago sp ON sp.id = sa.solicitud_pago_id AND sp.activo = true
            WHERE sp.codigo_verificacion = $1 AND sa.accion = 'aprobado'
            ORDER BY sa.orden`,
          [codigo],
        );
        const sol = solicitud.rows[0];
        res.json({
          success: true,
          data: {
            tipo: 'solicitud_pago',
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
        return;
      }

      // El mismo estado que ve la pantalla: mientras la orden esta 'enviada', lo
      // que manda es lo que llego, y eso sale de las entregas.
      const orden = await query<{
        numero: string;
        fecha: string;
        proveedor: string;
        proveedor_ruc: string | null;
        monto_total: number;
        estado: string;
        termino_dias: number;
        condiciones: string | null;
        proyecto_nombre: string | null;
      }>(
        `SELECT o.numero, o.fecha, o.proveedor, o.proveedor_ruc, o.monto_total,
                o.termino_dias, o.condiciones,
                COALESCE(p.nombre_corto, p.nombre) AS proyecto_nombre,
                CASE
                  WHEN o.estado <> 'enviada' THEN o.estado
                  WHEN EXISTS (
                    SELECT 1 FROM orden_compra_entregas e
                     WHERE e.orden_compra_id = o.id AND e.activo = true
                  ) THEN 'recibida'
                  ELSE 'enviada'
                END AS estado
           FROM ordenes_compra o
           LEFT JOIN proyectos p ON p.id = o.proyecto_id
          WHERE o.codigo_verificacion = $1 AND o.activo = true`,
        [codigo],
      );

      if (orden.rows.length === 0) {
        res.status(404).json({
          success: false,
          message: 'Código de verificación no válido',
        });
        return;
      }

      const aprobaciones = await query<Aprobacion>(
        `SELECT u.nombre AS usuario_nombre, ap.fecha
           FROM orden_compra_aprobaciones ap
           JOIN users u ON ap.user_id = u.id
           JOIN ordenes_compra o ON o.id = ap.orden_compra_id AND o.activo = true
          WHERE o.codigo_verificacion = $1 AND ap.accion = 'aprobado'
          ORDER BY ap.orden`,
        [codigo],
      );

      const oc = orden.rows[0];
      res.json({
        success: true,
        data: {
          tipo: 'orden_compra',
          numero: oc.numero,
          fecha: oc.fecha,
          beneficiario: oc.proveedor,
          proveedor_ruc: oc.proveedor_ruc,
          concepto: oc.condiciones,
          monto_total: oc.monto_total,
          estado: oc.estado,
          termino_dias: oc.termino_dias,
          proyecto_nombre: oc.proyecto_nombre,
          verificado: true,
          aprobaciones: aprobaciones.rows,
        },
      });
    },
  ),
);

export default router;
