-- 120_requisiciones_solicitante_solicitado_not_null.sql
-- M1 from schema audit: of the 34 nullable FK columns, only two are
-- populated at INSERT and never cleared — they should be NOT NULL.
--   requisiciones.solicitante_id  -- always set from solicitante_id || req.user.id
--   requisiciones.solicitado_por  -- always set from req.user.id
-- The other 32 nullable FKs are nullable by design (workflow events,
-- optional assignments, polymorphic XOR pairs covered by M2 CHECKs)
-- and are documented as keep-nullable in second-audit.md.
-- Self-verifying — aborts if either column has any NULL row.

DO $$
DECLARE
  null_solicitante INTEGER;
  null_solicitado  INTEGER;
BEGIN
  SELECT COUNT(*) INTO null_solicitante FROM requisiciones WHERE solicitante_id IS NULL;
  SELECT COUNT(*) INTO null_solicitado  FROM requisiciones WHERE solicitado_por IS NULL;

  IF null_solicitante > 0 THEN
    RAISE EXCEPTION
      'Migration 120 aborted. requisiciones has % rows with NULL solicitante_id. Backfill before retry.',
      null_solicitante;
  END IF;

  IF null_solicitado > 0 THEN
    RAISE EXCEPTION
      'Migration 120 aborted. requisiciones has % rows with NULL solicitado_por. Backfill before retry.',
      null_solicitado;
  END IF;

  RAISE NOTICE 'Preflight passed. Locking requisiciones.solicitante_id and solicitado_por NOT NULL.';

  ALTER TABLE requisiciones ALTER COLUMN solicitante_id SET NOT NULL;
  ALTER TABLE requisiciones ALTER COLUMN solicitado_por SET NOT NULL;

  RAISE NOTICE 'Migration 120 complete.';
END $$;
