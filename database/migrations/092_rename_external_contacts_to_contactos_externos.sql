-- 092_rename_external_contacts_to_contactos_externos.sql
-- DB Spanish standardization — Cycle 13
-- Renames external_contacts table + created_by column.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'external_contacts' AND table_schema = 'public'
  ) THEN
    ALTER TABLE external_contacts RENAME COLUMN created_by TO creado_por;

    ALTER TABLE external_contacts
      RENAME CONSTRAINT external_contacts_created_by_fkey TO contactos_externos_creado_por_fkey;

    ALTER INDEX external_contacts_pkey         RENAME TO contactos_externos_pkey;
    ALTER INDEX idx_external_contacts_activo   RENAME TO idx_contactos_externos_activo;
    ALTER INDEX idx_external_contacts_nombre   RENAME TO idx_contactos_externos_nombre;

    ALTER SEQUENCE external_contacts_id_seq RENAME TO contactos_externos_id_seq;

    ALTER TABLE external_contacts RENAME TO contactos_externos;
  END IF;

  RAISE NOTICE 'Renamed external_contacts -> contactos_externos (Cycle 13)';
END $$;
