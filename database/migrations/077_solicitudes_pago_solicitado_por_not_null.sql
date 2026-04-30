-- 077_solicitudes_pago_solicitado_por_not_null.sql
-- C6 schema audit: enforce that every solicitud de pago records a requester.
-- Migration 076 already backfilled all caja-derived solicitudes via caja.responsable_id.
-- The only remaining NULL rows are 'regular' solicitudes saved with no selection.
-- Per product decision (2026-04-30), those rows are deleted.
--
-- Safety: only 'regular' rows are deleted. CASCADE handles items/adjuntos/ajustes/etc.
-- If any deleted row has a NO ACTION child (correcciones, devoluciones), the DELETE
-- fails and the migration rolls back — leaving NOT NULL un-applied. Investigate
-- before retrying.

DELETE FROM solicitudes_pago WHERE solicitado_por IS NULL AND tipo = 'regular';

ALTER TABLE solicitudes_pago ALTER COLUMN solicitado_por SET NOT NULL;
