-- 118_rename_expense_id_to_gasto_id.sql
-- M4 from schema audit: requisiciones.expense_id is the last English FK
-- column on a Spanish-named business table (proyecto_gastos). The schema
-- convention is Spanish FK names point at Spanish parents. Rename the
-- column, plus the index and FK constraint that bear the old name, so
-- everything in pg_catalog stays consistent.
-- Self-verifying — every step uses IF EXISTS so a partially-applied
-- state (e.g. someone renamed the column manually) does not abort.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'requisiciones'
      AND column_name = 'expense_id'
  ) THEN
    RAISE NOTICE 'Renaming requisiciones.expense_id to gasto_id.';
    ALTER TABLE requisiciones RENAME COLUMN expense_id TO gasto_id;
  ELSE
    RAISE NOTICE 'Column already renamed.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'idx_requisiciones_expense_id'
  ) THEN
    ALTER INDEX idx_requisiciones_expense_id RENAME TO idx_requisiciones_gasto_id;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'requisiciones_expense_id_fkey'
  ) THEN
    ALTER TABLE requisiciones
      RENAME CONSTRAINT requisiciones_expense_id_fkey
                     TO requisiciones_gasto_id_fkey;
  END IF;

  RAISE NOTICE 'Migration 118 complete.';
END $$;
