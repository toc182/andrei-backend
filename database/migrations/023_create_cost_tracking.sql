-- Migration: Create Cost Tracking Tables
-- Description: Creates tables for budget management and expense tracking
-- Date: 2025-12-02

-- Expense Categories Table
CREATE TABLE IF NOT EXISTS expense_categories (
  id SERIAL PRIMARY KEY,
  codigo VARCHAR(10) UNIQUE NOT NULL,
  nombre VARCHAR(100) NOT NULL,
  descripcion TEXT,
  color VARCHAR(7) DEFAULT '#808080',
  orden INTEGER DEFAULT 0,
  activo BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Project Budgets Table
CREATE TABLE IF NOT EXISTS project_budgets (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
  monto_contrato_original DECIMAL(15,2),
  monto_contrato_actual DECIMAL(15,2),
  presupuesto_aprobado DECIMAL(15,2),
  contingencia_porcentaje DECIMAL(5,2) DEFAULT 10.00,
  contingencia_monto DECIMAL(15,2),
  moneda VARCHAR(3) DEFAULT 'USD',
  fecha_aprobacion DATE,
  notas TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(project_id)
);

-- Budget Categories Table (budget allocation per category)
CREATE TABLE IF NOT EXISTS budget_categories (
  id SERIAL PRIMARY KEY,
  project_budget_id INTEGER NOT NULL REFERENCES project_budgets(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES expense_categories(id) ON DELETE RESTRICT,
  presupuesto_inicial DECIMAL(15,2) DEFAULT 0,
  presupuesto_actual DECIMAL(15,2) DEFAULT 0,
  notas TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(project_budget_id, category_id)
);

-- Project Expenses Table
CREATE TABLE IF NOT EXISTS project_expenses (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES expense_categories(id) ON DELETE RESTRICT,
  fecha DATE NOT NULL,
  concepto VARCHAR(255) NOT NULL,
  descripcion TEXT,
  monto DECIMAL(15,2) NOT NULL CHECK (monto >= 0),
  tipo_gasto VARCHAR(20) DEFAULT 'real' CHECK (tipo_gasto IN ('real', 'estimado', 'comprometido')),
  moneda VARCHAR(3) DEFAULT 'USD',
  referencia_externa VARCHAR(100),
  archivo_adjunto VARCHAR(255),
  aprobado BOOLEAN DEFAULT false,
  fecha_aprobacion DATE,
  aprobado_por INTEGER REFERENCES users(id),
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Insert default expense categories
INSERT INTO expense_categories (codigo, nombre, descripcion, color) VALUES
  ('MAT', 'Materiales', 'Materiales de construcción y suministros', '#e74c3c'),
  ('MO', 'Mano de Obra', 'Costos de personal y subcontratistas', '#3498db'),
  ('EQU', 'Equipos', 'Alquiler y operación de equipos', '#f39c12'),
  ('TRA', 'Transporte', 'Logística y transporte de materiales', '#9b59b6'),
  ('SER', 'Servicios', 'Servicios profesionales y técnicos', '#1abc9c'),
  ('ADM', 'Administrativos', 'Gastos administrativos y de oficina', '#34495e'),
  ('PER', 'Permisos', 'Permisos, licencias y trámites', '#e67e22'),
  ('OTR', 'Otros', 'Otros gastos no clasificados', '#95a5a6')
ON CONFLICT (codigo) DO NOTHING;

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_project_budgets_project_id ON project_budgets(project_id);
CREATE INDEX IF NOT EXISTS idx_budget_categories_project_budget_id ON budget_categories(project_budget_id);
CREATE INDEX IF NOT EXISTS idx_budget_categories_category_id ON budget_categories(category_id);
CREATE INDEX IF NOT EXISTS idx_project_expenses_project_id ON project_expenses(project_id);
CREATE INDEX IF NOT EXISTS idx_project_expenses_category_id ON project_expenses(category_id);
CREATE INDEX IF NOT EXISTS idx_project_expenses_fecha ON project_expenses(fecha);
CREATE INDEX IF NOT EXISTS idx_project_expenses_tipo_gasto ON project_expenses(tipo_gasto);

-- Create trigger function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_cost_tracking_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create triggers
CREATE TRIGGER update_expense_categories_updated_at
  BEFORE UPDATE ON expense_categories
  FOR EACH ROW
  EXECUTE FUNCTION update_cost_tracking_updated_at();

CREATE TRIGGER update_project_budgets_updated_at
  BEFORE UPDATE ON project_budgets
  FOR EACH ROW
  EXECUTE FUNCTION update_cost_tracking_updated_at();

CREATE TRIGGER update_budget_categories_updated_at
  BEFORE UPDATE ON budget_categories
  FOR EACH ROW
  EXECUTE FUNCTION update_cost_tracking_updated_at();

CREATE TRIGGER update_project_expenses_updated_at
  BEFORE UPDATE ON project_expenses
  FOR EACH ROW
  EXECUTE FUNCTION update_cost_tracking_updated_at();
