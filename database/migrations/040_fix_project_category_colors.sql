-- 040_fix_project_category_colors.sql
-- Fix: project_expense_categories tenian color #808080 hardcodeado en vez de heredar
-- de expense_categories via COALESCE. Se pone NULL para que COALESCE funcione.

-- Limpiar colores #808080 en categorias que referencian una global
-- (asi COALESCE(pec.color, ec.color) devuelve el color correcto de la global)
UPDATE project_expense_categories
SET color = NULL
WHERE category_id IS NOT NULL AND color = '#808080';

-- Cambiar el DEFAULT de la columna para que nuevas filas queden NULL
ALTER TABLE project_expense_categories ALTER COLUMN color DROP DEFAULT;

-- Recrear la funcion para que no inserte color (queda NULL, hereda de la global)
CREATE OR REPLACE FUNCTION initialize_project_categories(p_project_id INTEGER)
RETURNS void AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM project_expense_categories WHERE project_id = p_project_id) THEN
    INSERT INTO project_expense_categories (project_id, category_id, activo, orden)
    SELECT p_project_id, id, true, orden
    FROM expense_categories
    WHERE activo = true
    ORDER BY orden;
  END IF;
END;
$$ LANGUAGE plpgsql;
