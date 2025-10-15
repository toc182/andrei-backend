-- Migración: Eliminar tablas no utilizadas
-- Fecha: 2025-10-15
-- Descripción: Eliminar tablas de presupuestos, gastos, y gestión de obra que no se están utilizando

-- Eliminar tablas de presupuestos y gastos
DROP TABLE IF EXISTS project_expenses CASCADE;
DROP TABLE IF EXISTS expense_categories CASCADE;
DROP TABLE IF EXISTS project_budgets CASCADE;
DROP TABLE IF EXISTS budget_categories CASCADE;
DROP TABLE IF EXISTS change_orders CASCADE;

-- Eliminar tablas de gestión de obra
DROP TABLE IF EXISTS tramos_proyecto CASCADE;
DROP TABLE IF EXISTS frentes_trabajo CASCADE;
DROP TABLE IF EXISTS reportes_diarios CASCADE;
DROP TABLE IF EXISTS metas_proyecto CASCADE;

-- Eliminar tabla de materiales
DROP TABLE IF EXISTS materiales CASCADE;

-- Log de confirmación
DO $$
BEGIN
    RAISE NOTICE '✅ Tablas no utilizadas eliminadas exitosamente';
END $$;
