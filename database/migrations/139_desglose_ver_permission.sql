-- 139_desglose_ver_permission.sql
-- Individual permission gating the Desglose section (contract prices are
-- sensitive). Mirrors cronogramas_ver: one key grants view+edit in v1; routes
-- ALSO pass checkProjectAccess because desgloses are project-scoped.
ALTER TABLE user_permissions ADD COLUMN IF NOT EXISTS desglose_ver BOOLEAN DEFAULT FALSE;
