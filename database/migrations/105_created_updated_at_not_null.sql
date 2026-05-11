-- 105_created_updated_at_not_null.sql
-- M9 from schema audit: enforce NOT NULL on every created_at / updated_at column.
-- All such columns have CURRENT_TIMESTAMP / now() defaults, so NULLs are
-- rare-to-zero in practice, but the schema doesn't enforce it. This migration
-- discovers nullable timestamp columns at runtime, backfills any NULL values
-- with NOW(), then SET NOT NULL. Idempotent: rerunning on already-NOT-NULL is
-- a no-op.

DO $$
DECLARE
  r RECORD;
  rows_updated INTEGER;
  total_columns INTEGER := 0;
  total_backfilled INTEGER := 0;
BEGIN
  FOR r IN
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE column_name IN ('created_at', 'updated_at')
      AND is_nullable = 'YES'
      AND table_schema = 'public'
    ORDER BY table_name, column_name
  LOOP
    total_columns := total_columns + 1;

    -- Backfill any NULL values (rare, but preserves row continuity).
    EXECUTE format(
      'UPDATE %I SET %I = NOW() WHERE %I IS NULL',
      r.table_name, r.column_name, r.column_name
    );
    GET DIAGNOSTICS rows_updated = ROW_COUNT;
    IF rows_updated > 0 THEN
      total_backfilled := total_backfilled + rows_updated;
      RAISE NOTICE 'Backfilled % NULL rows in %.%',
        rows_updated, r.table_name, r.column_name;
    END IF;

    -- Enforce NOT NULL.
    EXECUTE format(
      'ALTER TABLE %I ALTER COLUMN %I SET NOT NULL',
      r.table_name, r.column_name
    );
  END LOOP;

  RAISE NOTICE 'Migration 105 complete. % timestamp columns set NOT NULL. % rows backfilled.',
    total_columns, total_backfilled;
END $$;