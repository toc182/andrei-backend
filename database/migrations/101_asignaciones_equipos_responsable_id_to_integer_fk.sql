-- 101_asignaciones_equipos_responsable_id_to_integer_fk.sql
-- C1 schema audit: convert asignaciones_equipos.responsable_id from VARCHAR(255)
-- to INTEGER with a real FK to users(id).
-- Pre-deploy verification (2026-05-11): zero non-numeric values, zero orphan IDs
-- in production. Type conversion and FK creation are safe.
-- Also folds in the matching FK index.

-- Convert VARCHAR → INTEGER (idempotent: only runs if still VARCHAR).
DO $$
BEGIN
  IF (SELECT data_type
        FROM information_schema.columns
       WHERE table_name = 'asignaciones_equipos'
         AND column_name = 'responsable_id') = 'character varying' THEN
    ALTER TABLE asignaciones_equipos
      ALTER COLUMN responsable_id TYPE INTEGER
      USING NULLIF(responsable_id, '')::INTEGER;
  END IF;
END $$;

-- Add FK constraint (idempotent).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'asignaciones_equipos_responsable_id_fkey'
  ) THEN
    ALTER TABLE asignaciones_equipos
      ADD CONSTRAINT asignaciones_equipos_responsable_id_fkey
      FOREIGN KEY (responsable_id) REFERENCES users(id);
  END IF;
END $$;

-- Index for "asignaciones by user" queries.
CREATE INDEX IF NOT EXISTS idx_asignaciones_equipos_responsable_id
  ON asignaciones_equipos(responsable_id);
