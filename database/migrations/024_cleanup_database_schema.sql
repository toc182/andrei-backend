-- Migration 024: Database Schema Cleanup
-- Date: 2025-12-03
-- Description: Clean up duplications and unused tables based on user requirements
--
-- Changes:
-- 1. Rename proyectos.monto_contrato_original → monto_contrato
-- 2. Drop unused tables: tramos_proyecto, frentes_trabajo, reportes_diarios, metas_proyecto
-- 3. Clean project_budgets: remove duplicate and unused columns
-- 4. Keep budget_categories but clean it up (optional feature)
-- 5. Fix foreign key references

-- =========================================
-- STEP 1: Rename monto_contrato_original to monto_contrato in proyectos table
-- =========================================

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'proyectos'
        AND column_name = 'monto_contrato_original'
    ) THEN
        ALTER TABLE proyectos RENAME COLUMN monto_contrato_original TO monto_contrato;
        RAISE NOTICE 'Renamed proyectos.monto_contrato_original to monto_contrato';
    ELSE
        RAISE NOTICE 'Column monto_contrato already exists, skipping rename';
    END IF;
END $$;

-- =========================================
-- STEP 2: Drop unused tables (with CASCADE to remove dependencies)
-- =========================================

DROP TABLE IF EXISTS reportes_diarios CASCADE;
DROP TABLE IF EXISTS frentes_trabajo CASCADE;
DROP TABLE IF EXISTS tramos_proyecto CASCADE;
DROP TABLE IF EXISTS metas_proyecto CASCADE;

-- =========================================
-- STEP 3: Clean project_budgets table
-- =========================================

ALTER TABLE project_budgets
DROP COLUMN IF EXISTS monto_contrato_original,
DROP COLUMN IF EXISTS monto_contrato_actual,
DROP COLUMN IF EXISTS contingencia_porcentaje,
DROP COLUMN IF EXISTS contingencia_monto,
DROP COLUMN IF EXISTS presupuesto_aprobado,
DROP COLUMN IF EXISTS fecha_aprobacion;

-- Ensure project_budgets has proper structure
DO $$
BEGIN
    -- Add created_by if it doesn't exist
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'project_budgets' AND column_name = 'created_by'
    ) THEN
        ALTER TABLE project_budgets ADD COLUMN created_by INTEGER REFERENCES users(id);
    END IF;

    -- Add updated_by if it doesn't exist
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'project_budgets' AND column_name = 'updated_by'
    ) THEN
        ALTER TABLE project_budgets ADD COLUMN updated_by INTEGER REFERENCES users(id);
    END IF;
END $$;

-- Ensure UNIQUE constraint on project_id
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'project_budgets_project_id_key'
    ) THEN
        ALTER TABLE project_budgets ADD CONSTRAINT project_budgets_project_id_key UNIQUE (project_id);
    END IF;
END $$;

-- =========================================
-- STEP 4: Clean budget_categories table
-- =========================================

-- Fix budget_categories to reference project_id instead of project_budget_id
DO $$
BEGIN
    -- If budget_categories references project_budget_id, we need to restructure
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'budget_categories' AND column_name = 'project_budget_id'
    ) THEN
        -- Create temporary table with new structure
        CREATE TABLE budget_categories_new (
            id SERIAL PRIMARY KEY,
            project_id INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
            category_id INTEGER NOT NULL REFERENCES expense_categories(id) ON DELETE RESTRICT,
            presupuesto_inicial DECIMAL(15,2) DEFAULT 0,
            presupuesto_actual DECIMAL(15,2) DEFAULT 0,
            notas TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(project_id, category_id)
        );

        -- Migrate data (if any exists)
        INSERT INTO budget_categories_new (project_id, category_id, presupuesto_inicial, presupuesto_actual, notas, created_at, updated_at)
        SELECT
            pb.project_id,
            bc.category_id,
            bc.presupuesto_inicial,
            bc.presupuesto_actual,
            bc.notas,
            bc.created_at,
            bc.updated_at
        FROM budget_categories bc
        JOIN project_budgets pb ON bc.project_budget_id = pb.id
        ON CONFLICT (project_id, category_id) DO NOTHING;

        -- Drop old table
        DROP TABLE budget_categories CASCADE;

        -- Rename new table
        ALTER TABLE budget_categories_new RENAME TO budget_categories;

        -- Recreate trigger
        CREATE TRIGGER update_budget_categories_updated_at
            BEFORE UPDATE ON budget_categories
            FOR EACH ROW
            EXECUTE FUNCTION update_cost_tracking_updated_at();

        -- Recreate index
        CREATE INDEX IF NOT EXISTS idx_budget_categories_project_id ON budget_categories(project_id);
        CREATE INDEX IF NOT EXISTS idx_budget_categories_category_id ON budget_categories(category_id);

        RAISE NOTICE 'Restructured budget_categories to reference project_id directly';
    END IF;
END $$;

-- =========================================
-- STEP 5: Ensure project_expenses references project_id (not proyecto_id)
-- =========================================

DO $$
BEGIN
    -- Check if we need to rename proyecto_id to project_id
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'project_expenses' AND column_name = 'proyecto_id'
    ) THEN
        ALTER TABLE project_expenses RENAME COLUMN proyecto_id TO project_id;
        RAISE NOTICE 'Renamed project_expenses.proyecto_id to project_id';
    END IF;
END $$;

-- =========================================
-- STEP 6: Clean up change_orders table
-- =========================================

DO $$
BEGIN
    -- Check if we need to rename proyecto_id to project_id
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'change_orders' AND column_name = 'proyecto_id'
    ) THEN
        ALTER TABLE change_orders RENAME COLUMN proyecto_id TO project_id;
        RAISE NOTICE 'Renamed change_orders.proyecto_id to project_id';
    END IF;
END $$;
