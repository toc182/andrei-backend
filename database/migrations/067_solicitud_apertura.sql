-- 067_solicitud_apertura.sql
-- Introduces tipo 'apertura' for fund-transfer solicitudes linked to cajas menudas.
-- Adds estado 'transferida' for completed fund transfers (no factura step).
-- Links cajas and historial_monto entries to their apertura solicitudes.

-- 1. Expand tipo CHECK to include 'apertura'
ALTER TABLE solicitudes_pago DROP CONSTRAINT IF EXISTS solicitudes_pago_tipo_check;
ALTER TABLE solicitudes_pago ADD CONSTRAINT solicitudes_pago_tipo_check
  CHECK (tipo IN ('regular', 'reembolso', 'apertura'));

-- 2. Expand estado CHECK to include 'transferida'
ALTER TABLE solicitudes_pago DROP CONSTRAINT IF EXISTS solicitudes_pago_estado_check;
ALTER TABLE solicitudes_pago ADD CONSTRAINT solicitudes_pago_estado_check
  CHECK (estado IN ('borrador', 'pendiente', 'aprobada', 'rechazada',
                    'pagada', 'facturada', 'devolucion', 'reembolsada', 'transferida'));

-- 3. Link caja to its initial apertura solicitud
ALTER TABLE cajas_menudas
  ADD COLUMN IF NOT EXISTS solicitud_apertura_id INTEGER REFERENCES solicitudes_pago(id);

-- 4. Link historial_monto entries to their apertura solicitudes (for monto increases)
ALTER TABLE cajas_menudas_historial_monto
  ADD COLUMN IF NOT EXISTS solicitud_id INTEGER REFERENCES solicitudes_pago(id);
