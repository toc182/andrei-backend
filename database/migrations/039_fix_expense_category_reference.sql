-- 039_fix_expense_category_reference.sql
-- Permite usar categorías custom de proyecto en gastos
-- Cambia la referencia de expense_categories a project_expense_categories

-- Agregar nueva columna que referencia project_expense_categories
ALTER TABLE project_expenses
ADD COLUMN IF NOT EXISTS project_category_id INTEGER REFERENCES project_expense_categories(id) ON DELETE RESTRICT;

-- Migrar datos existentes: encontrar el project_expense_categories.id correspondiente
UPDATE project_expenses pe
SET project_category_id = pec.id
FROM project_expense_categories pec
WHERE pe.project_id = pec.project_id
  AND pe.category_id = pec.category_id
  AND pe.project_category_id IS NULL;

-- Crear índice para mejor performance
CREATE INDEX IF NOT EXISTS idx_project_expenses_project_category ON project_expenses(project_category_id);

-- Comentario
COMMENT ON COLUMN project_expenses.project_category_id IS 'Referencia a categoría del proyecto (permite custom y globales)';
