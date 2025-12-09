-- 028_make_category_id_nullable.sql
-- Hace category_id nullable en budget_categories porque ahora usamos project_category_id
-- category_id era la referencia directa a expense_categories (global)
-- project_category_id es la nueva referencia a project_expense_categories (por proyecto)

-- Eliminar la constraint NOT NULL de category_id
ALTER TABLE budget_categories
ALTER COLUMN category_id DROP NOT NULL;

-- Agregar comentario explicativo
COMMENT ON COLUMN budget_categories.category_id IS 'DEPRECATED: Referencia antigua a expense_categories. Usar project_category_id';
COMMENT ON COLUMN budget_categories.project_category_id IS 'Referencia a project_expense_categories (soporta categorías globales y custom por proyecto)';
