-- 088_rename_project_members_to_proyecto_miembros.sql
-- DB Spanish standardization — Cycle 9
-- Renames project_members table + 2 English columns.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'project_members' AND table_schema = 'public'
  ) THEN
    ALTER TABLE project_members RENAME COLUMN project_id          TO proyecto_id;
    ALTER TABLE project_members RENAME COLUMN external_contact_id TO contacto_externo_id;

    ALTER TABLE project_members
      RENAME CONSTRAINT project_members_project_id_fkey          TO proyecto_miembros_proyecto_id_fkey;
    ALTER TABLE project_members
      RENAME CONSTRAINT project_members_external_contact_id_fkey TO proyecto_miembros_contacto_externo_id_fkey;
    ALTER TABLE project_members
      RENAME CONSTRAINT project_members_user_id_fkey             TO proyecto_miembros_user_id_fkey;

    ALTER INDEX project_members_pkey                  RENAME TO proyecto_miembros_pkey;
    ALTER INDEX idx_project_members_project           RENAME TO idx_proyecto_miembros_proyecto_id;
    ALTER INDEX idx_project_members_user              RENAME TO idx_proyecto_miembros_user_id;
    ALTER INDEX idx_project_members_external          RENAME TO idx_proyecto_miembros_contacto_externo_id;
    ALTER INDEX idx_unique_user_per_project           RENAME TO idx_unique_user_per_proyecto;
    ALTER INDEX idx_unique_external_per_project       RENAME TO idx_unique_externo_per_proyecto;

    ALTER SEQUENCE project_members_id_seq RENAME TO proyecto_miembros_id_seq;

    ALTER TABLE project_members RENAME TO proyecto_miembros;
  END IF;

  RAISE NOTICE 'Renamed project_members -> proyecto_miembros (Cycle 9)';
END $$;
