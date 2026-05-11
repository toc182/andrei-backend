-- 106_cuentas_ipt_firma_pair_checks.sql
-- M8 from schema audit: enforce that each firma pair on cuentas_ipt is
-- atomic. Either both (fecha_firma_X, firma_X_por) are NULL (signature
-- pending) or both are set (signature complete). The only writer
-- (routes/cuentas.ts:985-1011) already enforces this in code; this just
-- closes the gap at the schema level so no future code path can drift.
-- Phase 0: local DB has zero violation rows. ALTER TABLE will validate
-- against existing rows and fail loudly if production differs.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'cuentas_ipt_firma_ministro_pair'
  ) THEN
    ALTER TABLE cuentas_ipt ADD CONSTRAINT cuentas_ipt_firma_ministro_pair
      CHECK ((fecha_firma_ministro IS NULL) = (firma_ministro_por IS NULL));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'cuentas_ipt_firma_mef_pair'
  ) THEN
    ALTER TABLE cuentas_ipt ADD CONSTRAINT cuentas_ipt_firma_mef_pair
      CHECK ((fecha_firma_mef IS NULL) = (firma_mef_por IS NULL));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'cuentas_ipt_firma_contralor_pair'
  ) THEN
    ALTER TABLE cuentas_ipt ADD CONSTRAINT cuentas_ipt_firma_contralor_pair
      CHECK ((fecha_firma_contralor IS NULL) = (firma_contralor_por IS NULL));
  END IF;
END $$;