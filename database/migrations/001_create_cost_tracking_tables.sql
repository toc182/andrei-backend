-- ==========================================
-- COST TRACKING TABLES MIGRATION
-- Version: 001
-- Date: 2025-01-22
-- Description: Add cost tracking capabilities
-- ==========================================

-- 1. Project Budgets Table
CREATE TABLE IF NOT EXISTS project_budgets (
    id SERIAL PRIMARY KEY,
    proyecto_id INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
    monto_contrato_original DECIMAL(15,2) NOT NULL,
    monto_contrato_actual DECIMAL(15,2) NOT NULL DEFAULT 0,
    contingencia_porcentaje DECIMAL(5,2) DEFAULT 10.00,
    contingencia_monto DECIMAL(15,2) DEFAULT 0,
    presupuesto_aprobado DECIMAL(15,2) NOT NULL DEFAULT 0,
    notas TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by INTEGER REFERENCES users(id),
    updated_by INTEGER REFERENCES users(id),
    UNIQUE(proyecto_id)
);

-- 2. Expense Categories Table
CREATE TABLE IF NOT EXISTS expense_categories (
    id SERIAL PRIMARY KEY,
    nombre VARCHAR(100) NOT NULL UNIQUE,
    descripcion TEXT,
    codigo VARCHAR(20) UNIQUE,
    activo BOOLEAN DEFAULT true,
    color VARCHAR(7) DEFAULT '#007bff', -- Hex color for UI
    orden INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 3. Project Expenses Table
CREATE TABLE IF NOT EXISTS project_expenses (
    id SERIAL PRIMARY KEY,
    proyecto_id INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
    category_id INTEGER NOT NULL REFERENCES expense_categories(id),
    fecha DATE NOT NULL DEFAULT CURRENT_DATE,
    concepto VARCHAR(255) NOT NULL,
    descripcion TEXT,
    monto DECIMAL(12,2) NOT NULL,
    moneda VARCHAR(3) DEFAULT 'USD',
    tipo_gasto VARCHAR(20) DEFAULT 'real', -- 'real', 'compromiso', 'estimado'
    proveedor VARCHAR(255),
    numero_factura VARCHAR(100),
    numero_orden_compra VARCHAR(100),
    centro_costo VARCHAR(50),
    aprobado BOOLEAN DEFAULT false,
    aprobado_por INTEGER REFERENCES users(id),
    aprobado_fecha TIMESTAMP,
    observaciones TEXT,
    archivo_adjunto VARCHAR(500), -- URL del archivo
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by INTEGER NOT NULL REFERENCES users(id),
    updated_by INTEGER REFERENCES users(id)
);

-- 4. Budget Categories (presupuesto por categoría)
CREATE TABLE IF NOT EXISTS budget_categories (
    id SERIAL PRIMARY KEY,
    proyecto_id INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
    category_id INTEGER NOT NULL REFERENCES expense_categories(id),
    presupuesto_inicial DECIMAL(12,2) NOT NULL DEFAULT 0,
    presupuesto_actual DECIMAL(12,2) NOT NULL DEFAULT 0,
    notas TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(proyecto_id, category_id)
);

-- 5. Change Orders Table (órdenes de cambio)
CREATE TABLE IF NOT EXISTS change_orders (
    id SERIAL PRIMARY KEY,
    proyecto_id INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
    numero_orden VARCHAR(50) NOT NULL,
    fecha DATE NOT NULL DEFAULT CURRENT_DATE,
    descripcion TEXT NOT NULL,
    monto_cambio DECIMAL(12,2) NOT NULL,
    tipo_cambio VARCHAR(20) DEFAULT 'aumento', -- 'aumento', 'reduccion'
    estado VARCHAR(20) DEFAULT 'pendiente', -- 'pendiente', 'aprobado', 'rechazado'
    justificacion TEXT,
    aprobado_por INTEGER REFERENCES users(id),
    aprobado_fecha TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by INTEGER NOT NULL REFERENCES users(id),
    UNIQUE(proyecto_id, numero_orden)
);

-- Insert default expense categories
INSERT INTO expense_categories (nombre, descripcion, codigo, color, orden) VALUES
('Materiales', 'Materiales de construcción y suministros', 'MAT', '#28a745', 1),
('Mano de Obra', 'Costos de personal y mano de obra', 'MOB', '#007bff', 2),
('Equipos', 'Alquiler y operación de equipos', 'EQP', '#ffc107', 3),
('Subcontratistas', 'Servicios subcontratados', 'SUB', '#17a2b8', 4),
('Transporte', 'Transporte de materiales y personal', 'TRA', '#6f42c1', 5),
('Servicios', 'Servicios públicos y otros servicios', 'SER', '#fd7e14', 6),
('Administrativos', 'Gastos administrativos del proyecto', 'ADM', '#6c757d', 7),
('Imprevistos', 'Gastos no planificados', 'IMP', '#dc3545', 8)
ON CONFLICT (codigo) DO NOTHING;

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_project_budgets_proyecto ON project_budgets(proyecto_id);
CREATE INDEX IF NOT EXISTS idx_project_expenses_proyecto ON project_expenses(proyecto_id);
CREATE INDEX IF NOT EXISTS idx_project_expenses_category ON project_expenses(category_id);
CREATE INDEX IF NOT EXISTS idx_project_expenses_fecha ON project_expenses(fecha);
CREATE INDEX IF NOT EXISTS idx_budget_categories_proyecto ON budget_categories(proyecto_id);
CREATE INDEX IF NOT EXISTS idx_change_orders_proyecto ON change_orders(proyecto_id);

-- Create update timestamp triggers
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_project_budgets_updated_at BEFORE UPDATE ON project_budgets FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_project_expenses_updated_at BEFORE UPDATE ON project_expenses FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_budget_categories_updated_at BEFORE UPDATE ON budget_categories FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Add cost tracking fields to existing projects table (if not exists)
DO $$
BEGIN
    -- Add budget tracking to projects
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='proyectos' AND column_name='tiene_presupuesto') THEN
        ALTER TABLE proyectos ADD COLUMN tiene_presupuesto BOOLEAN DEFAULT false;
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='proyectos' AND column_name='moneda_proyecto') THEN
        ALTER TABLE proyectos ADD COLUMN moneda_proyecto VARCHAR(3) DEFAULT 'USD';
    END IF;
END
$$;