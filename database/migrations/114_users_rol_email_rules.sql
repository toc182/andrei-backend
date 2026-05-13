-- 114_users_rol_email_rules.sql
-- H1 from schema audit: users.rol and users.email are nullable, but the
-- login and permission middleware assume both are populated for internal
-- users. External users (tipo_usuario = 'externo') legitimately have no
-- email since they don't log in, so a blanket email NOT NULL is the
-- wrong call. This migration:
--   1. Locks rol NOT NULL (zero NULL rol rows today).
--   2. Adds a partial CHECK: internos must have an email; externos may not.
-- Self-verifying — aborts if any row would fail either rule.

DO $$
DECLARE
  bad_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO bad_count FROM users WHERE rol IS NULL;
  IF bad_count > 0 THEN
    RAISE EXCEPTION
      'Migration 114 aborted. users has % rows with NULL rol. Backfill before retry.',
      bad_count;
  END IF;

  SELECT COUNT(*) INTO bad_count
  FROM users
  WHERE tipo_usuario = 'interno' AND email IS NULL;
  IF bad_count > 0 THEN
    RAISE EXCEPTION
      'Migration 114 aborted. users has % interno rows with NULL email. Backfill before retry.',
      bad_count;
  END IF;

  RAISE NOTICE 'Preflight passed. Locking rol NOT NULL and adding interno-email CHECK.';

  ALTER TABLE users ALTER COLUMN rol SET NOT NULL;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_interno_requires_email'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_interno_requires_email
      CHECK (tipo_usuario <> 'interno' OR email IS NOT NULL);
  END IF;

  RAISE NOTICE 'Migration 114 complete.';
END $$;
