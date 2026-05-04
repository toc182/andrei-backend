-- 082_cuentas_active_to_activo.sql
-- H19 schema audit: rename cuentas.active → activo for naming consistency.
-- Every other table in the system uses `activo` (Spanish); cuentas was the only
-- outlier with `active` (English). This makes it match.

ALTER TABLE cuentas RENAME COLUMN active TO activo;
