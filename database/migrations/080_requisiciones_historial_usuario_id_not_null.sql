-- 080_requisiciones_historial_usuario_id_not_null.sql
-- H2 schema audit: enforce that every requisicion history entry records who made the change.

ALTER TABLE requisiciones_historial ALTER COLUMN usuario_id SET NOT NULL;
