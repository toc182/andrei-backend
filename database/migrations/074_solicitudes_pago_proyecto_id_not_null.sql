-- 074_solicitudes_pago_proyecto_id_not_null.sql
-- C4 schema audit: enforce that every solicitud de pago must have a project.
-- The application validator already requires it; this closes the gap at the schema level.

ALTER TABLE solicitudes_pago ALTER COLUMN proyecto_id SET NOT NULL;
