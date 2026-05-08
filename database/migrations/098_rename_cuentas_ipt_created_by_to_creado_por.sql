-- 098_rename_cuentas_ipt_created_by_to_creado_por.sql
-- DB Spanish standardization — Cycle 20
-- Column rename only on cuentas_ipt table.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'cuentas_ipt' AND column_name = 'created_by' AND table_schema = 'public'
  ) THEN
    ALTER TABLE cuentas_ipt RENAME COLUMN created_by TO creado_por;

    ALTER TABLE cuentas_ipt
      RENAME CONSTRAINT cuentas_ipt_created_by_fkey TO cuentas_ipt_creado_por_fkey;
  END IF;

  RAISE NOTICE 'Renamed cuentas_ipt.created_by -> cuentas_ipt.creado_por (Cycle 20)';
END $$;
