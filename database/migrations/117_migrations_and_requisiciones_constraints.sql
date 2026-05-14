-- 117_migrations_and_requisiciones_constraints.sql
-- Bundles two small audit findings:
--   L2 — migrations.executed_at NOT NULL. The migrator always writes a
--        timestamp; this just locks the rule at the schema level.
--   M3 — UNIQUE (proyecto_id, numero) on requisiciones, matching the
--        sibling pattern used by solicitudes_pago, cuentas, adendas.
-- Self-verifying — aborts cleanly if production has NULL executed_at
-- rows or duplicate (proyecto_id, numero) pairs.

DO $$
DECLARE
  null_count INTEGER;
  dup_count INTEGER;
BEGIN
  -- L2 preflight
  SELECT COUNT(*) INTO null_count FROM migrations WHERE executed_at IS NULL;
  IF null_count > 0 THEN
    RAISE EXCEPTION
      'Migration 117 aborted. migrations has % rows with NULL executed_at. Backfill before retry.',
      null_count;
  END IF;

  -- M3 preflight
  SELECT COUNT(*) INTO dup_count FROM (
    SELECT proyecto_id, numero
    FROM requisiciones
    WHERE numero IS NOT NULL
    GROUP BY proyecto_id, numero
    HAVING COUNT(*) > 1
  ) d;
  IF dup_count > 0 THEN
    RAISE EXCEPTION
      'Migration 117 aborted. requisiciones has % duplicate (proyecto_id, numero) pairs. Reconcile before retry.',
      dup_count;
  END IF;

  RAISE NOTICE 'Preflight passed. Applying L2 and M3.';

  ALTER TABLE migrations ALTER COLUMN executed_at SET NOT NULL;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'requisiciones_proyecto_id_numero_key'
  ) THEN
    ALTER TABLE requisiciones
      ADD CONSTRAINT requisiciones_proyecto_id_numero_key
      UNIQUE (proyecto_id, numero);
  END IF;

  RAISE NOTICE 'Migration 117 complete.';
END $$;
