-- 119_rename_solicitud_id_to_solicitud_pago_id.sql
-- M5 from schema audit: three child tables of solicitudes_pago use the
-- shorter column name `solicitud_id` while every other child uses
-- `solicitud_pago_id`. Renames the column, the FK constraint, the UNIQUE
-- constraint (where present), and the supporting index on each of:
--   devoluciones_solicitud, reembolsos_pinellas, cajas_menudas_historial_monto.
-- Self-verifying — every step uses IF EXISTS so re-running on a fully or
-- partially renamed DB is a clean no-op.

DO $$
BEGIN
  ----------------------------------------------------------------
  -- devoluciones_solicitud
  ----------------------------------------------------------------
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='devoluciones_solicitud'
      AND column_name='solicitud_id'
  ) THEN
    ALTER TABLE devoluciones_solicitud RENAME COLUMN solicitud_id TO solicitud_pago_id;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='devoluciones_solicitud_solicitud_id_fkey') THEN
    ALTER TABLE devoluciones_solicitud
      RENAME CONSTRAINT devoluciones_solicitud_solicitud_id_fkey
                     TO devoluciones_solicitud_solicitud_pago_id_fkey;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='devoluciones_solicitud_solicitud_id_key') THEN
    ALTER TABLE devoluciones_solicitud
      RENAME CONSTRAINT devoluciones_solicitud_solicitud_id_key
                     TO devoluciones_solicitud_solicitud_pago_id_key;
  END IF;

  ----------------------------------------------------------------
  -- reembolsos_pinellas
  ----------------------------------------------------------------
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='reembolsos_pinellas'
      AND column_name='solicitud_id'
  ) THEN
    ALTER TABLE reembolsos_pinellas RENAME COLUMN solicitud_id TO solicitud_pago_id;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='reembolsos_pinellas_solicitud_id_fkey') THEN
    ALTER TABLE reembolsos_pinellas
      RENAME CONSTRAINT reembolsos_pinellas_solicitud_id_fkey
                     TO reembolsos_pinellas_solicitud_pago_id_fkey;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='reembolsos_pinellas_solicitud_id_key') THEN
    ALTER TABLE reembolsos_pinellas
      RENAME CONSTRAINT reembolsos_pinellas_solicitud_id_key
                     TO reembolsos_pinellas_solicitud_pago_id_key;
  END IF;

  ----------------------------------------------------------------
  -- cajas_menudas_historial_monto
  ----------------------------------------------------------------
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='cajas_menudas_historial_monto'
      AND column_name='solicitud_id'
  ) THEN
    ALTER TABLE cajas_menudas_historial_monto RENAME COLUMN solicitud_id TO solicitud_pago_id;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='cajas_menudas_historial_monto_solicitud_id_fkey') THEN
    ALTER TABLE cajas_menudas_historial_monto
      RENAME CONSTRAINT cajas_menudas_historial_monto_solicitud_id_fkey
                     TO cajas_menudas_historial_monto_solicitud_pago_id_fkey;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname='public' AND indexname='idx_cajas_menudas_historial_monto_solicitud_id'
  ) THEN
    ALTER INDEX idx_cajas_menudas_historial_monto_solicitud_id
      RENAME TO idx_cajas_menudas_historial_monto_solicitud_pago_id;
  END IF;

  RAISE NOTICE 'Migration 119 complete.';
END $$;
