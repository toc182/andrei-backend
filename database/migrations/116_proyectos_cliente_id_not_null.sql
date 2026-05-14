-- 116_proyectos_cliente_id_not_null.sql
-- H4 from schema audit: proyectos.cliente_id is nullable, but the business
-- rule is "every project has a client." Lock NOT NULL. Self-verifying —
-- aborts cleanly if any row has NULL cliente_id so production rows can be
-- backfilled via the UI before re-running, without losing data.

DO $$
DECLARE
  null_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO null_count
  FROM proyectos
  WHERE cliente_id IS NULL;

  IF null_count > 0 THEN
    RAISE EXCEPTION
      'Migration 116 aborted. proyectos has % rows with NULL cliente_id. Assign a cliente in the UI before retry.',
      null_count;
  END IF;

  RAISE NOTICE 'Preflight passed. Locking proyectos.cliente_id NOT NULL.';
  ALTER TABLE proyectos ALTER COLUMN cliente_id SET NOT NULL;
  RAISE NOTICE 'Migration 116 complete.';
END $$;
