-- 060_add_devolucion_estado.sql
-- Add 'devolucion' to the estado CHECK constraint
ALTER TABLE solicitudes_pago DROP CONSTRAINT solicitudes_pago_estado_check;
ALTER TABLE solicitudes_pago ADD CONSTRAINT solicitudes_pago_estado_check
  CHECK (estado IN ('borrador', 'pendiente', 'aprobada', 'rechazada', 'pagada', 'facturada', 'devolucion'));
