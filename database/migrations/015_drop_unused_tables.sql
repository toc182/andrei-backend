-- Migración 015: Eliminar todas las tablas vacías que no estamos usando
-- Fecha: 2025-10-01

-- Eliminar tablas vacías (0 registros)
DROP TABLE IF EXISTS budget_categories CASCADE;
DROP TABLE IF EXISTS change_orders CASCADE;
DROP TABLE IF EXISTS frentes_trabajo CASCADE;
DROP TABLE IF EXISTS licitaciones CASCADE;
DROP TABLE IF EXISTS materiales CASCADE;
DROP TABLE IF EXISTS metas_proyecto CASCADE;
DROP TABLE IF EXISTS oportunidades CASCADE;
DROP TABLE IF EXISTS project_budgets CASCADE;
DROP TABLE IF EXISTS project_expenses CASCADE;
DROP TABLE IF EXISTS proyecto_usuarios CASCADE;
DROP TABLE IF EXISTS reportes_diarios CASCADE;
DROP TABLE IF EXISTS tramos_proyecto CASCADE;