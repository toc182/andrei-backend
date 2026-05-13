-- 115_solicitud_aprobaciones_fecha_not_null.sql
-- H3 from schema audit: solicitud_aprobaciones.fecha is nullable, but the
-- column already defaults to CURRENT_TIMESTAMP and every existing row has
-- one. A row with NULL fecha would corrupt approval-history ordering.
-- Lock the column NOT NULL. Self-verifying — aborts if any row is NULL.

DO $$
DECLARE
  null_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO null_count
  FROM solicitud_aprobaciones
  WHERE fecha IS NULL;

  IF null_count > 0 THEN
    RAISE EXCEPTION
      'Migration 115 aborted. solicitud_aprobaciones has % rows with NULL fecha. Backfill before retry.',
      null_count;
  END IF;

  RAISE NOTICE 'Preflight passed. Locking solicitud_aprobaciones.fecha NOT NULL.';
  ALTER TABLE solicitud_aprobaciones ALTER COLUMN fecha SET NOT NULL;
  RAISE NOTICE 'Migration 115 complete.';
END $$;
