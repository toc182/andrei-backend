-- 086_rename_project_expenses_to_proyecto_gastos.sql
-- DB Spanish standardization — Cycle 7 (expenses mega-cycle + Cycle 1's deferred column)
-- Renames the 2 expense tables and finalizes the project_category_id rename
-- across both child tables (project_expenses + categorias_presupuesto).

DO $$
BEGIN
  -- ============== TABLE 1: project_expense_categories -> proyecto_categorias_gastos ==============
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'project_expense_categories' AND table_schema = 'public'
  ) THEN
    ALTER TABLE project_expense_categories RENAME COLUMN project_id  TO proyecto_id;
    ALTER TABLE project_expense_categories RENAME COLUMN category_id TO categoria_id;

    ALTER TABLE project_expense_categories
      RENAME CONSTRAINT project_expense_categories_project_id_fkey  TO proyecto_categorias_gastos_proyecto_id_fkey;
    ALTER TABLE project_expense_categories
      RENAME CONSTRAINT project_expense_categories_category_id_fkey TO proyecto_categorias_gastos_categoria_id_fkey;
    ALTER TABLE project_expense_categories
      RENAME CONSTRAINT check_category_type                         TO check_categoria_tipo;

    ALTER INDEX project_expense_categories_pkey
      RENAME TO proyecto_categorias_gastos_pkey;
    ALTER INDEX idx_project_expense_categories_project
      RENAME TO idx_proyecto_categorias_gastos_proyecto_id;
    ALTER INDEX idx_project_expense_categories_active
      RENAME TO idx_proyecto_categorias_gastos_active;
    ALTER INDEX unique_project_global_category
      RENAME TO unique_proyecto_categoria_global;

    ALTER SEQUENCE project_expense_categories_id_seq
      RENAME TO proyecto_categorias_gastos_id_seq;

    ALTER TABLE project_expense_categories RENAME TO proyecto_categorias_gastos;
  END IF;

  -- ============== TABLE 2: project_expenses -> proyecto_gastos ==============
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'project_expenses' AND table_schema = 'public'
  ) THEN
    ALTER TABLE project_expenses RENAME COLUMN project_id          TO proyecto_id;
    ALTER TABLE project_expenses RENAME COLUMN category_id         TO categoria_id;
    ALTER TABLE project_expenses RENAME COLUMN project_category_id TO proyecto_categoria_id;
    ALTER TABLE project_expenses RENAME COLUMN created_by          TO creado_por;

    ALTER TABLE project_expenses
      RENAME CONSTRAINT project_expenses_project_id_fkey          TO proyecto_gastos_proyecto_id_fkey;
    ALTER TABLE project_expenses
      RENAME CONSTRAINT project_expenses_category_id_fkey         TO proyecto_gastos_categoria_id_fkey;
    ALTER TABLE project_expenses
      RENAME CONSTRAINT project_expenses_project_category_id_fkey TO proyecto_gastos_proyecto_categoria_id_fkey;
    ALTER TABLE project_expenses
      RENAME CONSTRAINT project_expenses_created_by_fkey          TO proyecto_gastos_creado_por_fkey;
    ALTER TABLE project_expenses
      RENAME CONSTRAINT project_expenses_aprobado_por_fkey        TO proyecto_gastos_aprobado_por_fkey;
    ALTER TABLE project_expenses
      RENAME CONSTRAINT project_expenses_monto_check              TO proyecto_gastos_monto_check;
    ALTER TABLE project_expenses
      RENAME CONSTRAINT project_expenses_tipo_gasto_check         TO proyecto_gastos_tipo_gasto_check;

    ALTER INDEX project_expenses_pkey                  RENAME TO proyecto_gastos_pkey;
    ALTER INDEX idx_project_expenses_project_id        RENAME TO idx_proyecto_gastos_proyecto_id;
    ALTER INDEX idx_project_expenses_category_id       RENAME TO idx_proyecto_gastos_categoria_id;
    ALTER INDEX idx_project_expenses_project_category  RENAME TO idx_proyecto_gastos_proyecto_categoria_id;
    ALTER INDEX idx_project_expenses_fecha             RENAME TO idx_proyecto_gastos_fecha;
    ALTER INDEX idx_project_expenses_tipo_gasto        RENAME TO idx_proyecto_gastos_tipo_gasto;

    ALTER SEQUENCE project_expenses_id_seq RENAME TO proyecto_gastos_id_seq;

    ALTER TRIGGER update_project_expenses_updated_at ON project_expenses
      RENAME TO update_proyecto_gastos_updated_at;

    ALTER TABLE project_expenses RENAME TO proyecto_gastos;
  END IF;

  -- ============== CYCLE 1 DEFERRED: categorias_presupuesto.project_category_id ==============
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'categorias_presupuesto'
      AND column_name = 'project_category_id'
      AND table_schema = 'public'
  ) THEN
    ALTER TABLE categorias_presupuesto RENAME COLUMN project_category_id TO proyecto_categoria_id;
    ALTER TABLE categorias_presupuesto
      RENAME CONSTRAINT categorias_presupuesto_project_category_fkey
                     TO categorias_presupuesto_proyecto_categoria_fkey;
  END IF;

  RAISE NOTICE 'Renamed expenses subsystem to Spanish + closed Cycle 1 deferred column (Cycle 7 of DB Spanish standardization)';
END $$;
