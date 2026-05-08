-- 094_rename_licitaciones_created_by_to_creado_por.sql
-- DB Spanish standardization — Cycle 16
-- Column rename only on licitaciones table.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'licitaciones' AND column_name = 'created_by' AND table_schema = 'public'
  ) THEN
    ALTER TABLE licitaciones RENAME COLUMN created_by TO creado_por;

    ALTER TABLE licitaciones
      RENAME CONSTRAINT licitaciones_created_by_fkey TO licitaciones_creado_por_fkey;
  END IF;

  RAISE NOTICE 'Renamed licitaciones.created_by -> licitaciones.creado_por (Cycle 16)';
END $$;
