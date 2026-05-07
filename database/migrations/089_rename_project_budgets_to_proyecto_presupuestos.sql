-- 089_rename_project_budgets_to_proyecto_presupuestos.sql
-- DB Spanish standardization — Cycle 10
-- Renames project_budgets table + 3 English columns (project_id, created_by, updated_by).

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'project_budgets' AND table_schema = 'public'
  ) THEN
    ALTER TABLE project_budgets RENAME COLUMN project_id TO proyecto_id;
    ALTER TABLE project_budgets RENAME COLUMN created_by TO creado_por;
    ALTER TABLE project_budgets RENAME COLUMN updated_by TO actualizado_por;

    ALTER TABLE project_budgets
      RENAME CONSTRAINT project_budgets_project_id_fkey TO proyecto_presupuestos_proyecto_id_fkey;
    ALTER TABLE project_budgets
      RENAME CONSTRAINT project_budgets_created_by_fkey TO proyecto_presupuestos_creado_por_fkey;
    ALTER TABLE project_budgets
      RENAME CONSTRAINT project_budgets_updated_by_fkey TO proyecto_presupuestos_actualizado_por_fkey;

    ALTER INDEX project_budgets_pkey            RENAME TO proyecto_presupuestos_pkey;
    ALTER INDEX project_budgets_project_id_key  RENAME TO proyecto_presupuestos_proyecto_id_key;
    ALTER INDEX idx_project_budgets_project_id  RENAME TO idx_proyecto_presupuestos_proyecto_id;

    ALTER SEQUENCE project_budgets_id_seq RENAME TO proyecto_presupuestos_id_seq;

    ALTER TRIGGER update_project_budgets_updated_at
      ON project_budgets
      RENAME TO update_proyecto_presupuestos_updated_at;

    ALTER TABLE project_budgets RENAME TO proyecto_presupuestos;
  END IF;

  RAISE NOTICE 'Renamed project_budgets -> proyecto_presupuestos (Cycle 10)';
END $$;
