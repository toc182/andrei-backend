-- 108_drop_unused_categorias_presupuesto_category_id.sql
-- L2 from schema audit: drop the unused `category_id` column on
-- `categorias_presupuesto`. The active column for this table is
-- `proyecto_categoria_id` (FK to proyecto_categorias_gastos) — used by
-- routes/costs.ts everywhere. `category_id` has no FK, no code references,
-- and is superseded by `proyecto_categoria_id`. Local DB: 0 non-NULL rows.
-- Also migrates the unique constraint to the new column.
--
-- Self-verifying: aborts cleanly if production has any non-NULL rows in
-- category_id (which would indicate the column is still being used somewhere).

DO $$
DECLARE
  non_null_count INTEGER;
BEGIN
  -- Idempotency guard: skip if already dropped.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'categorias_presupuesto' AND column_name = 'category_id'
  ) THEN
    RAISE NOTICE 'Migration 108 already applied; skipping.';
    RETURN;
  END IF;

  -- Preflight: confirm column is truly dead.
  SELECT COUNT(*) INTO non_null_count
  FROM categorias_presupuesto
  WHERE category_id IS NOT NULL;

  IF non_null_count > 0 THEN
    RAISE EXCEPTION
      'Migration 108 aborted. categorias_presupuesto.category_id has % non-NULL rows. The column is supposed to be unused — audit before drop.',
      non_null_count;
  END IF;

  RAISE NOTICE 'Preflight passed. Dropping category_id and dependents.';

  -- Drop the old unique constraint that references category_id.
  ALTER TABLE categorias_presupuesto
    DROP CONSTRAINT IF EXISTS categorias_presupuesto_proyecto_id_category_id_key;

  -- Drop the standalone index on category_id (if not auto-dropped).
  DROP INDEX IF EXISTS idx_categorias_presupuesto_category_id;

  -- Drop the column.
  ALTER TABLE categorias_presupuesto DROP COLUMN category_id;

  -- Add the equivalent unique constraint on the live column. Prevents
  -- duplicate budget category rows for the same (project, category).
  ALTER TABLE categorias_presupuesto
    ADD CONSTRAINT categorias_presupuesto_proyecto_id_proyecto_categoria_id_key
    UNIQUE (proyecto_id, proyecto_categoria_id);

  RAISE NOTICE 'Migration 108 complete.';
END $$;