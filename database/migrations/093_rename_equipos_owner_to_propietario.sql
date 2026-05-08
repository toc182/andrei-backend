-- 093_rename_equipos_owner_to_propietario.sql
-- DB Spanish standardization — Cycle 15
-- Column rename only on equipos table. No table rename.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'equipos' AND column_name = 'owner' AND table_schema = 'public'
  ) THEN
    ALTER TABLE equipos RENAME COLUMN owner TO propietario;

    ALTER TABLE equipos RENAME CONSTRAINT equipos_owner_check TO equipos_propietario_check;

    ALTER INDEX idx_equipos_owner RENAME TO idx_equipos_propietario;
  END IF;

  RAISE NOTICE 'Renamed equipos.owner -> equipos.propietario (Cycle 15)';
END $$;
