-- 075_solicitudes_pago_preparado_por_not_null.sql
-- C5 schema audit: enforce that every solicitud de pago records who prepared it.
-- preparado_por is set server-side from the authenticated user on every INSERT path;
-- this closes the gap at the schema level.

ALTER TABLE solicitudes_pago ALTER COLUMN preparado_por SET NOT NULL;
