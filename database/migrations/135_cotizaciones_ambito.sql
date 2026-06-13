-- 135_cotizaciones_ambito.sql
--
-- Splits the old single "no project" bucket into two distinct, trackable
-- options. Until now proyecto_id IS NULL meant "Oficina / General" — a
-- single label. The purchasing team wants to tell office purchases apart
-- from miscellaneous ones, so we record which it was.
--
-- ambito is meaningful ONLY when proyecto_id IS NULL:
--   proyecto_id set            -> tied to a project, ambito stays NULL
--   proyecto_id NULL + oficina -> "Oficina"
--   proyecto_id NULL + otros   -> "Otros"
-- No cross-column CHECK: the application guarantees exactly one is set,
-- and leaving it loose avoids breaking any pre-existing NULL/NULL rows.

ALTER TABLE cotizaciones
  ADD COLUMN IF NOT EXISTS ambito VARCHAR(10) CHECK (ambito IN ('oficina', 'otros'));
