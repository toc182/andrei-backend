-- 113_money_precision.sql
-- H2 from schema audit: five money columns are defined as unbounded
-- `numeric`. The database accepts arbitrary scale, so a UI rounding to 2
-- decimals can disagree with the raw stored value. Tighten each column
-- to a fixed precision/scale. Postgres ROUNDS existing values to the new
-- scale silently — it does NOT error — but it can error on the precision
-- (total digits) if a value is too big. Self-verifying preflight catches
-- any current row that exceeds the new precision so the migration aborts
-- cleanly rather than corrupting data.
--
-- Target shapes:
--   solicitudes_pago.monto_total          numeric(12,2)  -- matches sibling cols
--   proyectos.monto_total                 numeric(15,2)  -- larger ceiling for project totals
--   proyectos.monto_contrato_original     numeric(15,2)
--   proyectos.itbms                       numeric(15,2)
--   oportunidades.valor_estimado          numeric(15,2)

DO $$
DECLARE
  overflow_count INTEGER;
BEGIN
  -- Preflight: count any value that would overflow its target precision.
  -- Max abs value for numeric(P, S) is 10^(P-S) - 10^-S, but we can
  -- approximate the safe range as |x| < 10^(P-S).
  SELECT COUNT(*) INTO overflow_count
  FROM solicitudes_pago
  WHERE ABS(monto_total) >= 10::numeric ^ 10;  -- 12 - 2 = 10
  IF overflow_count > 0 THEN
    RAISE EXCEPTION
      'Migration 113 aborted. solicitudes_pago has % rows whose monto_total would overflow numeric(12,2).',
      overflow_count;
  END IF;

  SELECT COUNT(*) INTO overflow_count
  FROM proyectos
  WHERE ABS(monto_total) >= 10::numeric ^ 13     -- 15 - 2 = 13
     OR ABS(monto_contrato_original) >= 10::numeric ^ 13
     OR ABS(itbms) >= 10::numeric ^ 13;
  IF overflow_count > 0 THEN
    RAISE EXCEPTION
      'Migration 113 aborted. proyectos has % rows where monto_total, monto_contrato_original, or itbms would overflow numeric(15,2).',
      overflow_count;
  END IF;

  SELECT COUNT(*) INTO overflow_count
  FROM oportunidades
  WHERE ABS(valor_estimado) >= 10::numeric ^ 13;
  IF overflow_count > 0 THEN
    RAISE EXCEPTION
      'Migration 113 aborted. oportunidades has % rows whose valor_estimado would overflow numeric(15,2).',
      overflow_count;
  END IF;

  RAISE NOTICE 'Preflight passed. Tightening five money columns to fixed precision/scale.';

  ALTER TABLE solicitudes_pago ALTER COLUMN monto_total TYPE numeric(12, 2);
  ALTER TABLE proyectos        ALTER COLUMN monto_total              TYPE numeric(15, 2);
  ALTER TABLE proyectos        ALTER COLUMN monto_contrato_original  TYPE numeric(15, 2);
  ALTER TABLE proyectos        ALTER COLUMN itbms                    TYPE numeric(15, 2);
  ALTER TABLE oportunidades    ALTER COLUMN valor_estimado           TYPE numeric(15, 2);

  RAISE NOTICE 'Migration 113 complete.';
END $$;
