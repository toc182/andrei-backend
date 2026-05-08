-- 099_rename_requisiciones_project_id_to_proyecto_id.sql
-- DB Spanish standardization — Cycle 21 (FINAL CYCLE)
-- Column rename only on requisiciones table.
-- This is the last table with `project_id` in the schema.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'requisiciones' AND column_name = 'project_id' AND table_schema = 'public'
  ) THEN
    ALTER TABLE requisiciones RENAME COLUMN project_id TO proyecto_id;

    ALTER TABLE requisiciones
      RENAME CONSTRAINT requisiciones_project_id_fkey TO requisiciones_proyecto_id_fkey;

    ALTER INDEX idx_requisiciones_project RENAME TO idx_requisiciones_proyecto;
  END IF;

  RAISE NOTICE 'Renamed requisiciones.project_id -> requisiciones.proyecto_id (Cycle 21 — FINAL)';
END $$;
