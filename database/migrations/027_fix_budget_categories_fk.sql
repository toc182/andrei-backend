-- 027_fix_budget_categories_fk.sql
-- Actualiza budget_categories para soportar categorías personalizadas por proyecto
-- El category_id ahora referencia a project_expense_categories en lugar de expense_categories

-- Primero eliminar la constraint existente
ALTER TABLE budget_categories
DROP CONSTRAINT IF EXISTS budget_categories_category_id_fkey;

ALTER TABLE budget_categories
DROP CONSTRAINT IF EXISTS budget_categories_new_category_id_fkey;

-- Agregar columna para referencia a project_expense_categories
ALTER TABLE budget_categories
ADD COLUMN IF NOT EXISTS project_category_id INTEGER;

-- Actualizar registros existentes: mapear category_id a project_expense_categories
-- Esto asume que project_expense_categories ya fue poblada con initialize_project_categories
UPDATE budget_categories bc
SET project_category_id = pec.id
FROM project_expense_categories pec
WHERE bc.project_id = pec.project_id
  AND bc.category_id = pec.category_id
  AND bc.project_category_id IS NULL;

-- Agregar foreign key a project_expense_categories
ALTER TABLE budget_categories
ADD CONSTRAINT budget_categories_project_category_fkey
FOREIGN KEY (project_category_id)
REFERENCES project_expense_categories(id) ON DELETE CASCADE;

-- Comentario
COMMENT ON COLUMN budget_categories.project_category_id IS 'Referencia a project_expense_categories (soporta categorías custom)';
