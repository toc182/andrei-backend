-- 064_comprobante_cierre.sql
-- Store comprobante for caja menuda closure
ALTER TABLE cajas_menudas ADD COLUMN IF NOT EXISTS comprobante_cierre_r2_key VARCHAR(1000);
ALTER TABLE cajas_menudas ADD COLUMN IF NOT EXISTS comprobante_cierre_nombre VARCHAR(500);
