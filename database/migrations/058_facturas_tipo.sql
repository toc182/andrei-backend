-- 058_facturas_tipo.sql
-- Add tipo field to facturas_solicitud to distinguish between factura and recibo
ALTER TABLE facturas_solicitud ADD COLUMN IF NOT EXISTS tipo VARCHAR(20) DEFAULT 'factura';
