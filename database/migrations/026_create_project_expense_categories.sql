-- 026_create_project_expense_categories.sql
-- Categorías de gastos personalizables por proyecto
-- Permite activar/desactivar categorías globales y crear categorías custom

-- Tabla para categorías por proyecto
CREATE TABLE IF NOT EXISTS project_expense_categories (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
  category_id INTEGER REFERENCES expense_categories(id) ON DELETE SET NULL,
  -- Para categorías custom (cuando category_id es NULL)
  nombre VARCHAR(100),
  codigo VARCHAR(10),
  color VARCHAR(7) DEFAULT '#808080',
  -- Estado y orden
  activo BOOLEAN DEFAULT true,
  orden INTEGER DEFAULT 0,
  -- Timestamps
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  -- Constraint: o es referencia a global O tiene datos custom
  CONSTRAINT check_category_type CHECK (
    (category_id IS NOT NULL) OR
    (category_id IS NULL AND nombre IS NOT NULL AND codigo IS NOT NULL)
  ),
  -- Unique: una categoría global solo puede estar una vez por proyecto
  CONSTRAINT unique_project_global_category UNIQUE (project_id, category_id)
);

-- Índices para búsquedas rápidas
CREATE INDEX IF NOT EXISTS idx_project_expense_categories_project ON project_expense_categories(project_id);
CREATE INDEX IF NOT EXISTS idx_project_expense_categories_active ON project_expense_categories(project_id, activo);

-- Función para inicializar categorías de un proyecto con las 8 globales
CREATE OR REPLACE FUNCTION initialize_project_categories(p_project_id INTEGER)
RETURNS void AS $$
BEGIN
  -- Solo insertar si el proyecto no tiene categorías configuradas
  IF NOT EXISTS (SELECT 1 FROM project_expense_categories WHERE project_id = p_project_id) THEN
    INSERT INTO project_expense_categories (project_id, category_id, activo, orden)
    SELECT p_project_id, id, true, orden
    FROM expense_categories
    WHERE activo = true
    ORDER BY orden;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- Comentarios
COMMENT ON TABLE project_expense_categories IS 'Categorías de gastos personalizables por proyecto';
COMMENT ON COLUMN project_expense_categories.category_id IS 'Referencia a categoría global (NULL si es custom)';
COMMENT ON COLUMN project_expense_categories.nombre IS 'Nombre para categorías custom';
COMMENT ON COLUMN project_expense_categories.codigo IS 'Código para categorías custom';
COMMENT ON COLUMN project_expense_categories.activo IS 'Si la categoría está activa en este proyecto';
