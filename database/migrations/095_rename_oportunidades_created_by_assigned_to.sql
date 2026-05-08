-- 095_rename_oportunidades_created_by_assigned_to.sql
-- DB Spanish standardization — Cycle 17
-- Two column renames on oportunidades: created_by -> creado_por, assigned_to -> asignado_a.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'oportunidades' AND column_name = 'created_by' AND table_schema = 'public'
  ) THEN
    ALTER TABLE oportunidades RENAME COLUMN created_by  TO creado_por;
    ALTER TABLE oportunidades RENAME COLUMN assigned_to TO asignado_a;

    ALTER TABLE oportunidades
      RENAME CONSTRAINT oportunidades_created_by_fkey  TO oportunidades_creado_por_fkey;
    ALTER TABLE oportunidades
      RENAME CONSTRAINT oportunidades_assigned_to_fkey TO oportunidades_asignado_a_fkey;
  END IF;

  RAISE NOTICE 'Renamed oportunidades.created_by -> creado_por, assigned_to -> asignado_a (Cycle 17)';
END $$;
