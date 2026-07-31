-- 143_desglose_items_row_uid.sql
-- Identidad de fila ESTABLE para el desglose. replaceItems() en
-- routes/desgloses.ts BORRA todos los desglose_items y los reinserta con ids
-- SERIAL nuevos en cada guardado, así que `id` (ni `orden`, ni el free-text
-- `item`, que puede estar vacío / repetirse / cambiar) sirve como ancla durable.
-- La foto de avance de cada cuenta (migración 144) necesita enganchar el avance
-- a una fila que SOBREVIVA ese DELETE+reinsert y las ediciones del desglose.
--
-- row_uid es un UUID que el cliente genera UNA vez por fila y reenvía en cada
-- guardado; replaceItems lo preserva al reinsertar (ver cambio en la ruta). Al
-- COPIAR un desglose se generan uids nuevos (documento independiente), por eso
-- la unicidad se acota al desglose. Las filas existentes se rellenan con un UUID.
CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid() para el backfill

ALTER TABLE desglose_items ADD COLUMN IF NOT EXISTS row_uid UUID;
UPDATE desglose_items SET row_uid = gen_random_uuid() WHERE row_uid IS NULL;
ALTER TABLE desglose_items ALTER COLUMN row_uid SET NOT NULL;
ALTER TABLE desglose_items ALTER COLUMN row_uid SET DEFAULT gen_random_uuid();

-- Una fila (row_uid) es única dentro de su desglose; sobrevive los saves porque
-- el cliente la reenvía. El índice también acelera el match del encadenamiento.
CREATE UNIQUE INDEX IF NOT EXISTS uq_desglose_items_row_uid
  ON desglose_items (desglose_id, row_uid);
