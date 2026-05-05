-- 083_rename_budget_categories_to_categorias_presupuesto.sql
-- DB Spanish standardization — Cycle 1 of 21
-- Renames table budget_categories -> categorias_presupuesto
-- Renames column project_id -> proyecto_id (project_category_id deferred to coordinated cycle with project_expenses)
-- Cleans up legacy "_new" suffix on constraints/indexes/sequence (residue from migration 024)

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'budget_categories' AND table_schema = 'public'
  ) THEN
    -- 1. Rename column (table still has old name at this point)
    ALTER TABLE budget_categories RENAME COLUMN project_id TO proyecto_id;

    -- 2. Rename FK constraints (Spanish table prefix; project_category column stays English for now)
    ALTER TABLE budget_categories
      RENAME CONSTRAINT budget_categories_new_project_id_fkey
                     TO categorias_presupuesto_proyecto_id_fkey;
    ALTER TABLE budget_categories
      RENAME CONSTRAINT budget_categories_project_category_fkey
                     TO categorias_presupuesto_project_category_fkey;

    -- 3. Rename indexes
    ALTER INDEX budget_categories_new_pkey
      RENAME TO categorias_presupuesto_pkey;
    ALTER INDEX budget_categories_new_project_id_category_id_key
      RENAME TO categorias_presupuesto_proyecto_id_category_id_key;
    ALTER INDEX idx_budget_categories_project_id
      RENAME TO idx_categorias_presupuesto_proyecto_id;
    ALTER INDEX idx_budget_categories_category_id
      RENAME TO idx_categorias_presupuesto_category_id;

    -- 4. Rename sequence
    ALTER SEQUENCE budget_categories_new_id_seq
      RENAME TO categorias_presupuesto_id_seq;

    -- 5. Rename trigger
    ALTER TRIGGER update_budget_categories_updated_at ON budget_categories
      RENAME TO update_categorias_presupuesto_updated_at;

    -- 6. Finally, rename the table itself
    ALTER TABLE budget_categories RENAME TO categorias_presupuesto;

    RAISE NOTICE 'Renamed budget_categories -> categorias_presupuesto (Cycle 1 of DB Spanish standardization)';
  END IF;
END $$;
