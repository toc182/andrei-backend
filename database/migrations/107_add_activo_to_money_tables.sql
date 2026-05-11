-- 107_add_activo_to_money_tables.sql
-- M18 from schema audit: enable soft-delete on money/audit tables.
-- This migration is Phase 1 of Cycle F — schema only, no code change.
-- Adding the column with default true means every existing row is active.
-- Phase 2 (per-table) ships the SELECT filters and DELETE→UPDATE switches
-- in subsequent commits.
--
-- cuentas is intentionally NOT in this migration — it already has activo
-- from migration 082 (renamed from "active").

ALTER TABLE solicitudes_pago ADD COLUMN IF NOT EXISTS activo BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE cuentas_eventos  ADD COLUMN IF NOT EXISTS activo BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE cuentas_ipt      ADD COLUMN IF NOT EXISTS activo BOOLEAN NOT NULL DEFAULT true;
