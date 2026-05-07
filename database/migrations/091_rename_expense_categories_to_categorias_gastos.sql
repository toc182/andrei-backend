-- 091_rename_expense_categories_to_categorias_gastos.sql
-- DB Spanish standardization — Cycle 12
-- Table rename only. All columns already Spanish (codigo, nombre, descripcion, color, orden, activo).
-- Includes CREATE OR REPLACE FUNCTION for initialize_project_categories whose body references
-- the old table name (Postgres functions are stored as plain text and don't auto-update on rename).

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'expense_categories' AND table_schema = 'public'
  ) THEN
    ALTER INDEX expense_categories_pkey       RENAME TO categorias_gastos_pkey;
    ALTER INDEX expense_categories_codigo_key RENAME TO categorias_gastos_codigo_key;

    ALTER SEQUENCE expense_categories_id_seq RENAME TO categorias_gastos_id_seq;

    ALTER TRIGGER update_expense_categories_updated_at
      ON expense_categories
      RENAME TO update_categorias_gastos_updated_at;

    ALTER TABLE expense_categories RENAME TO categorias_gastos;
  END IF;

  RAISE NOTICE 'Renamed expense_categories -> categorias_gastos (Cycle 12)';
END $$;

-- Update stored function body to reference the new table name.
-- This is idempotent (CREATE OR REPLACE) so re-runs are safe.
CREATE OR REPLACE FUNCTION public.initialize_project_categories(p_project_id integer)
  RETURNS void
  LANGUAGE plpgsql
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM proyecto_categorias_gastos WHERE proyecto_id = p_project_id) THEN
    INSERT INTO proyecto_categorias_gastos (proyecto_id, categoria_id, activo, orden)
    SELECT p_project_id, id, true, orden
    FROM categorias_gastos
    WHERE activo = true
    ORDER BY orden;
  END IF;
END;
$function$;
