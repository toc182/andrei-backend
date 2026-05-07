-- 087_fix_initialize_project_categories_function.sql
-- Hotfix: Cycle 7 renamed project_expense_categories -> proyecto_categorias_gastos
-- but the Postgres function initialize_project_categories had the old names
-- hardcoded in its body (Postgres doesn't auto-update function bodies on table rename).
-- This caused 500 errors on the categories list endpoint for projects with no
-- existing expense categories.

CREATE OR REPLACE FUNCTION initialize_project_categories(p_project_id integer)
RETURNS void AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM proyecto_categorias_gastos WHERE proyecto_id = p_project_id) THEN
    INSERT INTO proyecto_categorias_gastos (proyecto_id, categoria_id, activo, orden)
    SELECT p_project_id, id, true, orden
    FROM expense_categories
    WHERE activo = true
    ORDER BY orden;
  END IF;
END;
$$ LANGUAGE plpgsql;
