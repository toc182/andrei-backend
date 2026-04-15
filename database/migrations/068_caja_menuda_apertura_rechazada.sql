-- 068_caja_menuda_apertura_rechazada.sql
ALTER TABLE cajas_menudas_historial_monto
  ADD COLUMN IF NOT EXISTS estado VARCHAR(20) NOT NULL DEFAULT 'activa';
