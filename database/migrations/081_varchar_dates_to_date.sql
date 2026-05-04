-- 081_varchar_dates_to_date.sql
-- H22 schema audit: convert VARCHAR(10) date columns back to DATE.
-- Migration 004 made these VARCHAR as a timezone workaround. Modern strategy:
-- columns are DATE in the schema (proper type, indexable, sortable, validated),
-- but every backend SELECT that returns these columns wraps them with TO_CHAR
-- so the wire format stays exactly as today (YYYY-MM-DD strings). No frontend impact.

-- Defensive validation: refuse to run if any value isn't YYYY-MM-DD.
DO $$
DECLARE
  bad_count int;
BEGIN
  SELECT
    (SELECT COUNT(*) FROM adendas WHERE fecha_solicitud IS NOT NULL AND fecha_solicitud !~ '^\d{4}-\d{2}-\d{2}$') +
    (SELECT COUNT(*) FROM adendas WHERE fecha_aprobacion IS NOT NULL AND fecha_aprobacion !~ '^\d{4}-\d{2}-\d{2}$') +
    (SELECT COUNT(*) FROM adendas WHERE nueva_fecha_fin IS NOT NULL AND nueva_fecha_fin !~ '^\d{4}-\d{2}-\d{2}$') +
    (SELECT COUNT(*) FROM proyectos WHERE fecha_inicio IS NOT NULL AND fecha_inicio !~ '^\d{4}-\d{2}-\d{2}$') +
    (SELECT COUNT(*) FROM proyectos WHERE fecha_fin_estimada IS NOT NULL AND fecha_fin_estimada !~ '^\d{4}-\d{2}-\d{2}$')
  INTO bad_count;

  IF bad_count > 0 THEN
    RAISE EXCEPTION 'Cannot convert VARCHAR dates to DATE: % rows have non-YYYY-MM-DD values. Investigate and clean up before retrying.', bad_count;
  END IF;
END $$;

-- Convert columns. CURRENT_DATE default on adendas.fecha_solicitud keeps working.
ALTER TABLE adendas
  ALTER COLUMN fecha_solicitud TYPE DATE USING fecha_solicitud::DATE,
  ALTER COLUMN fecha_aprobacion TYPE DATE USING fecha_aprobacion::DATE,
  ALTER COLUMN nueva_fecha_fin TYPE DATE USING nueva_fecha_fin::DATE;

ALTER TABLE proyectos
  ALTER COLUMN fecha_inicio TYPE DATE USING fecha_inicio::DATE,
  ALTER COLUMN fecha_fin_estimada TYPE DATE USING fecha_fin_estimada::DATE;
