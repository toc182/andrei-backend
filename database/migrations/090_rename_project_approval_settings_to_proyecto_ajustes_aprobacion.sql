-- 090_rename_project_approval_settings_to_proyecto_ajustes_aprobacion.sql
-- DB Spanish standardization — Cycle 11
-- Table rename only. No column renames (proyecto_id, user_id, orden, activo all already Spanish/system-FK).

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'project_approval_settings' AND table_schema = 'public'
  ) THEN
    ALTER TABLE project_approval_settings
      RENAME CONSTRAINT project_approval_settings_proyecto_id_fkey TO proyecto_ajustes_aprobacion_proyecto_id_fkey;
    ALTER TABLE project_approval_settings
      RENAME CONSTRAINT project_approval_settings_user_id_fkey     TO proyecto_ajustes_aprobacion_user_id_fkey;

    ALTER INDEX project_approval_settings_pkey                       RENAME TO proyecto_ajustes_aprobacion_pkey;
    ALTER INDEX project_approval_settings_proyecto_id_orden_key      RENAME TO proyecto_ajustes_aprobacion_proyecto_id_orden_key;
    ALTER INDEX project_approval_settings_proyecto_id_user_id_key    RENAME TO proyecto_ajustes_aprobacion_proyecto_id_user_id_key;

    ALTER SEQUENCE project_approval_settings_id_seq RENAME TO proyecto_ajustes_aprobacion_id_seq;

    ALTER TABLE project_approval_settings RENAME TO proyecto_ajustes_aprobacion;
  END IF;

  RAISE NOTICE 'Renamed project_approval_settings -> proyecto_ajustes_aprobacion (Cycle 11)';
END $$;
