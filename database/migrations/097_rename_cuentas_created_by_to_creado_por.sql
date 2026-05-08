-- 097_rename_cuentas_created_by_to_creado_por.sql
-- DB Spanish standardization — Cycle 19
-- Column rename only on cuentas table.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'cuentas' AND column_name = 'created_by' AND table_schema = 'public'
  ) THEN
    ALTER TABLE cuentas RENAME COLUMN created_by TO creado_por;

    ALTER TABLE cuentas
      RENAME CONSTRAINT cuentas_created_by_fkey TO cuentas_creado_por_fkey;
  END IF;

  RAISE NOTICE 'Renamed cuentas.created_by -> cuentas.creado_por (Cycle 19)';
END $$;
