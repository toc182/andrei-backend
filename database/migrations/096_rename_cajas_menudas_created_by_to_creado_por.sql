-- 096_rename_cajas_menudas_created_by_to_creado_por.sql
-- DB Spanish standardization — Cycle 18
-- Column rename only on cajas_menudas table.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'cajas_menudas' AND column_name = 'created_by' AND table_schema = 'public'
  ) THEN
    ALTER TABLE cajas_menudas RENAME COLUMN created_by TO creado_por;

    ALTER TABLE cajas_menudas
      RENAME CONSTRAINT cajas_menudas_created_by_fkey TO cajas_menudas_creado_por_fkey;
  END IF;

  RAISE NOTICE 'Renamed cajas_menudas.created_by -> cajas_menudas.creado_por (Cycle 18)';
END $$;
