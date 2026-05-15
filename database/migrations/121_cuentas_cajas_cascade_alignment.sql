-- 121_cuentas_cajas_cascade_alignment.sql
-- M6 from schema audit: children of cuentas and cajas_menudas use
-- ON DELETE NO ACTION while every other child family in the schema
-- uses CASCADE. Hard deletes on these parents (which the project
-- policy forbids anyway) would noisily fail instead of cleaning up
-- predictably. This migration aligns the six child FKs to CASCADE
-- so the schema is consistent. No data is touched.
--
-- Pattern: DROP CONSTRAINT, then ADD CONSTRAINT with ON DELETE CASCADE.
-- Each step is guarded so re-running on a partially-migrated DB is a
-- no-op.

DO $$
BEGIN
  ----------------------------------------------------------------
  -- cuentas children
  ----------------------------------------------------------------
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cuentas_adjuntos_cuenta_id_fkey') THEN
    ALTER TABLE cuentas_adjuntos DROP CONSTRAINT cuentas_adjuntos_cuenta_id_fkey;
  END IF;
  ALTER TABLE cuentas_adjuntos
    ADD CONSTRAINT cuentas_adjuntos_cuenta_id_fkey
    FOREIGN KEY (cuenta_id) REFERENCES cuentas(id) ON DELETE CASCADE;

  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cuentas_eventos_cuenta_id_fkey') THEN
    ALTER TABLE cuentas_eventos DROP CONSTRAINT cuentas_eventos_cuenta_id_fkey;
  END IF;
  ALTER TABLE cuentas_eventos
    ADD CONSTRAINT cuentas_eventos_cuenta_id_fkey
    FOREIGN KEY (cuenta_id) REFERENCES cuentas(id) ON DELETE CASCADE;

  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cuentas_ipt_cuenta_id_fkey') THEN
    ALTER TABLE cuentas_ipt DROP CONSTRAINT cuentas_ipt_cuenta_id_fkey;
  END IF;
  ALTER TABLE cuentas_ipt
    ADD CONSTRAINT cuentas_ipt_cuenta_id_fkey
    FOREIGN KEY (cuenta_id) REFERENCES cuentas(id) ON DELETE CASCADE;

  ----------------------------------------------------------------
  -- cajas_menudas children
  ----------------------------------------------------------------
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cajas_menudas_adjuntos_caja_menuda_id_fkey') THEN
    ALTER TABLE cajas_menudas_adjuntos DROP CONSTRAINT cajas_menudas_adjuntos_caja_menuda_id_fkey;
  END IF;
  ALTER TABLE cajas_menudas_adjuntos
    ADD CONSTRAINT cajas_menudas_adjuntos_caja_menuda_id_fkey
    FOREIGN KEY (caja_menuda_id) REFERENCES cajas_menudas(id) ON DELETE CASCADE;

  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cajas_menudas_gastos_caja_menuda_id_fkey') THEN
    ALTER TABLE cajas_menudas_gastos DROP CONSTRAINT cajas_menudas_gastos_caja_menuda_id_fkey;
  END IF;
  ALTER TABLE cajas_menudas_gastos
    ADD CONSTRAINT cajas_menudas_gastos_caja_menuda_id_fkey
    FOREIGN KEY (caja_menuda_id) REFERENCES cajas_menudas(id) ON DELETE CASCADE;

  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cajas_menudas_historial_monto_caja_menuda_id_fkey') THEN
    ALTER TABLE cajas_menudas_historial_monto DROP CONSTRAINT cajas_menudas_historial_monto_caja_menuda_id_fkey;
  END IF;
  ALTER TABLE cajas_menudas_historial_monto
    ADD CONSTRAINT cajas_menudas_historial_monto_caja_menuda_id_fkey
    FOREIGN KEY (caja_menuda_id) REFERENCES cajas_menudas(id) ON DELETE CASCADE;

  RAISE NOTICE 'Migration 121 complete. Six child FKs realigned to ON DELETE CASCADE.';
END $$;
