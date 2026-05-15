-- 123_timestamps_to_timestamptz.sql
-- M8 from schema audit: every timestamp column in public schema is
-- currently `timestamp without time zone`. Convert all of them to
-- `timestamptz` so the database knows when each instant happened
-- regardless of the connecting session's timezone setting.
--
-- The conversion uses `AT TIME ZONE current_setting('TimeZone')` so the
-- bare timestamp is interpreted as being in whatever timezone the server
-- session is currently using — which is the same timezone the writes
-- were made under. Wall-clock semantics are preserved per environment.
--
-- Sampling: the migration prints the current session TZ and one row's
-- timestamps from users (small stable table) before and after the
-- conversion, so the deploy log shows what was preserved.
--
-- All work runs inside the implicit transaction the migrator wraps
-- around each migration file. A failure mid-loop rolls back cleanly.

DO $$
DECLARE
  current_tz TEXT;
  before_created TEXT;
  before_updated TEXT;
  after_created TEXT;
  after_updated TEXT;
  col_count INTEGER;
  converted_count INTEGER := 0;
  r RECORD;
BEGIN
  current_tz := current_setting('TimeZone');
  RAISE NOTICE 'Migration 123 starting. Session TimeZone = %', current_tz;

  -- Before-snapshot
  SELECT created_at::text, updated_at::text
    INTO before_created, before_updated
    FROM users WHERE id = 1;
  IF FOUND THEN
    RAISE NOTICE 'BEFORE  users.id=1: created_at=%, updated_at=%', before_created, before_updated;
  END IF;

  SELECT COUNT(*) INTO col_count
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND data_type    = 'timestamp without time zone';
  RAISE NOTICE 'Found % timestamp-without-time-zone columns to convert.', col_count;

  -- Convert each column. format() safely quotes identifiers.
  FOR r IN
    SELECT table_name, column_name
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND data_type    = 'timestamp without time zone'
     ORDER BY table_name, column_name
  LOOP
    EXECUTE format(
      'ALTER TABLE %I ALTER COLUMN %I TYPE timestamptz USING %I AT TIME ZONE current_setting(''TimeZone'')',
      r.table_name, r.column_name, r.column_name
    );
    converted_count := converted_count + 1;
  END LOOP;

  RAISE NOTICE 'Converted % columns.', converted_count;

  -- After-snapshot
  SELECT created_at::text, updated_at::text
    INTO after_created, after_updated
    FROM users WHERE id = 1;
  IF FOUND THEN
    RAISE NOTICE 'AFTER   users.id=1: created_at=%, updated_at=%', after_created, after_updated;
  END IF;

  RAISE NOTICE 'Migration 123 complete.';
END $$;
