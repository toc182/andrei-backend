-- 066_caja_menuda_comprobantes.sql
-- Adds optional comprobantes for caja menuda opening and for each amount change.
-- Mirrors the comprobante_cierre pattern introduced in migration 064:
-- single-file-per-row stored as columns on the parent table (not in an adjuntos table).

-- Opening comprobante on the caja itself
ALTER TABLE cajas_menudas
  ADD COLUMN IF NOT EXISTS comprobante_apertura_r2_key TEXT,
  ADD COLUMN IF NOT EXISTS comprobante_apertura_nombre TEXT;

-- Per-change comprobantes on the historial_monto rows
ALTER TABLE cajas_menudas_historial_monto
  ADD COLUMN IF NOT EXISTS comprobante_r2_key TEXT,
  ADD COLUMN IF NOT EXISTS comprobante_nombre TEXT;
