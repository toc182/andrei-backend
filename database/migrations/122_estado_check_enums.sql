-- 122_estado_check_enums.sql
-- L1 from schema audit: three tables have an `estado` column with no CHECK
-- constraint. The application validates the enum in code but the schema
-- doesn't, leaving the door open to a manual SQL session or buggy endpoint
-- writing any string. This migration adds three CHECK constraints — one
-- per table — using the canonical state lists derived from the route code
-- (cuentas.ts TRANSICIONES matrix, cajasMenudas.ts validation, equipos
-- frontend Select + TS union type).
--
-- Self-verifying — aborts cleanly if any current row holds a value that
-- isn't in the allow-list, so the migration can never corrupt state.

DO $$
DECLARE
  bad_count INTEGER;
BEGIN
  ----------------------------------------------------------------
  -- cuentas: 11 states from the TRANSICIONES matrix
  ----------------------------------------------------------------
  SELECT COUNT(*) INTO bad_count FROM cuentas
   WHERE estado IS NOT NULL
     AND estado NOT IN (
       'borrador', 'enviada', 'observaciones', 'aprobada', 'pagada',
       'enviada_institucion', 'observaciones_institucion', 'aprobada_institucion',
       'enviada_contraloria', 'observaciones_contraloria', 'aprobada_contraloria'
     );
  IF bad_count > 0 THEN
    RAISE EXCEPTION
      'Migration 122 aborted. cuentas has % rows with estado outside the allow-list. Reconcile before retry.',
      bad_count;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cuentas_estado_check') THEN
    ALTER TABLE cuentas
      ADD CONSTRAINT cuentas_estado_check
      CHECK (estado IN (
        'borrador', 'enviada', 'observaciones', 'aprobada', 'pagada',
        'enviada_institucion', 'observaciones_institucion', 'aprobada_institucion',
        'enviada_contraloria', 'observaciones_contraloria', 'aprobada_contraloria'
      ));
  END IF;

  ----------------------------------------------------------------
  -- cajas_menudas: 2 states
  ----------------------------------------------------------------
  SELECT COUNT(*) INTO bad_count FROM cajas_menudas
   WHERE estado IS NOT NULL
     AND estado NOT IN ('abierta', 'cerrada');
  IF bad_count > 0 THEN
    RAISE EXCEPTION
      'Migration 122 aborted. cajas_menudas has % rows with estado outside the allow-list. Reconcile before retry.',
      bad_count;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cajas_menudas_estado_check') THEN
    ALTER TABLE cajas_menudas
      ADD CONSTRAINT cajas_menudas_estado_check
      CHECK (estado IN ('abierta', 'cerrada'));
  END IF;

  ----------------------------------------------------------------
  -- equipos: 3 states
  ----------------------------------------------------------------
  SELECT COUNT(*) INTO bad_count FROM equipos
   WHERE estado IS NOT NULL
     AND estado NOT IN ('en_operacion', 'en_mantenimiento', 'standby');
  IF bad_count > 0 THEN
    RAISE EXCEPTION
      'Migration 122 aborted. equipos has % rows with estado outside the allow-list. Reconcile before retry.',
      bad_count;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'equipos_estado_check') THEN
    ALTER TABLE equipos
      ADD CONSTRAINT equipos_estado_check
      CHECK (estado IN ('en_operacion', 'en_mantenimiento', 'standby'));
  END IF;

  RAISE NOTICE 'Migration 122 complete. Three estado CHECK constraints installed.';
END $$;
