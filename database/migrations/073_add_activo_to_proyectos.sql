-- 073_add_activo_to_proyectos.sql
-- Add an activo flag to proyectos so projects can be soft-deleted
-- (per the project convention: never hard-delete business records).
-- Existing rows default to true; the DELETE endpoint flips this to false.

ALTER TABLE proyectos
  ADD COLUMN IF NOT EXISTS activo BOOLEAN DEFAULT true;

-- Backfill any rows where the column is NULL (e.g. older inserts that
-- bypassed the default). Defensive; should be a no-op for new schemas.
UPDATE proyectos SET activo = true WHERE activo IS NULL;
