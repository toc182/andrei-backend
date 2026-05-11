-- 109_equipos_codigo_not_null_unique.sql
-- L6 from schema audit: equipos.codigo is the business identifier for a
-- piece of equipment. Should never be NULL, should be unique. Local DB:
-- 16/16 rows have a codigo, zero duplicates. Self-verifying migration
-- aborts cleanly if production has any NULL or duplicate codigos.

DO $$
DECLARE
  null_count INTEGER;
  dup_count INTEGER;
BEGIN
  -- Preflight: confirm no NULLs.
  SELECT COUNT(*) INTO null_count FROM equipos WHERE codigo IS NULL;
  IF null_count > 0 THEN
    RAISE EXCEPTION
      'Migration 109 aborted. equipos has % rows with NULL codigo. Backfill before retry.',
      null_count;
  END IF;

  -- Preflight: confirm no duplicates.
  SELECT COUNT(*) INTO dup_count FROM (
    SELECT codigo FROM equipos WHERE codigo IS NOT NULL GROUP BY codigo HAVING COUNT(*) > 1
  ) d;
  IF dup_count > 0 THEN
    RAISE EXCEPTION
      'Migration 109 aborted. equipos has % duplicate codigos. Reconcile before retry.',
      dup_count;
  END IF;

  RAISE NOTICE 'Preflight passed. Applying NOT NULL and UNIQUE to equipos.codigo.';

  ALTER TABLE equipos ALTER COLUMN codigo SET NOT NULL;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'equipos_codigo_key'
  ) THEN
    ALTER TABLE equipos ADD CONSTRAINT equipos_codigo_key UNIQUE (codigo);
  END IF;

  RAISE NOTICE 'Migration 109 complete.';
END $$;