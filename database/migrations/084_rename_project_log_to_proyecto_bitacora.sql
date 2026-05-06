-- 084_rename_project_log_to_proyecto_bitacora.sql
-- DB Spanish standardization — Cycle 2 (bitácora mega-cycle)
-- Renames the 3 bitácora tables and all their English columns.
-- 3 tables, 10 columns, plus FKs, indexes, sequences, PK names — all idempotent.

DO $$
BEGIN
  -- ============== TABLE 1: project_log_entries -> proyecto_bitacora ==============
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'project_log_entries' AND table_schema = 'public'
  ) THEN
    -- Columns
    ALTER TABLE project_log_entries RENAME COLUMN project_id TO proyecto_id;
    ALTER TABLE project_log_entries RENAME COLUMN created_by TO creado_por;

    -- FK constraints
    ALTER TABLE project_log_entries
      RENAME CONSTRAINT project_log_entries_project_id_fkey TO proyecto_bitacora_proyecto_id_fkey;
    ALTER TABLE project_log_entries
      RENAME CONSTRAINT project_log_entries_created_by_fkey TO proyecto_bitacora_creado_por_fkey;

    -- Indexes
    ALTER INDEX project_log_entries_pkey RENAME TO proyecto_bitacora_pkey;
    ALTER INDEX idx_log_entries_project  RENAME TO idx_proyecto_bitacora_proyecto_id;
    ALTER INDEX idx_log_entries_created  RENAME TO idx_proyecto_bitacora_created_at;

    -- Sequence
    ALTER SEQUENCE project_log_entries_id_seq RENAME TO proyecto_bitacora_id_seq;

    -- Table
    ALTER TABLE project_log_entries RENAME TO proyecto_bitacora;
  END IF;

  -- ============== TABLE 2: project_log_comments -> proyecto_bitacora_comentarios ==============
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'project_log_comments' AND table_schema = 'public'
  ) THEN
    -- Columns
    ALTER TABLE project_log_comments RENAME COLUMN entry_id TO bitacora_id;
    ALTER TABLE project_log_comments RENAME COLUMN created_by TO creado_por;

    -- FK constraints
    ALTER TABLE project_log_comments
      RENAME CONSTRAINT project_log_comments_entry_id_fkey  TO proyecto_bitacora_comentarios_bitacora_id_fkey;
    ALTER TABLE project_log_comments
      RENAME CONSTRAINT project_log_comments_created_by_fkey TO proyecto_bitacora_comentarios_creado_por_fkey;

    -- Indexes
    ALTER INDEX project_log_comments_pkey RENAME TO proyecto_bitacora_comentarios_pkey;
    ALTER INDEX idx_log_comments_entry    RENAME TO idx_proyecto_bitacora_comentarios_bitacora_id;

    -- Sequence
    ALTER SEQUENCE project_log_comments_id_seq RENAME TO proyecto_bitacora_comentarios_id_seq;

    -- Table
    ALTER TABLE project_log_comments RENAME TO proyecto_bitacora_comentarios;
  END IF;

  -- ============== TABLE 3: project_log_attachments -> proyecto_bitacora_adjuntos ==============
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'project_log_attachments' AND table_schema = 'public'
  ) THEN
    -- Columns
    ALTER TABLE project_log_attachments RENAME COLUMN entry_id   TO bitacora_id;
    ALTER TABLE project_log_attachments RENAME COLUMN comment_id TO comentario_id;
    ALTER TABLE project_log_attachments RENAME COLUMN filename   TO nombre_archivo;
    ALTER TABLE project_log_attachments RENAME COLUMN filepath   TO ruta_archivo;
    ALTER TABLE project_log_attachments RENAME COLUMN mimetype   TO tipo_mime;
    ALTER TABLE project_log_attachments RENAME COLUMN size       TO tamano;

    -- FK constraints
    ALTER TABLE project_log_attachments
      RENAME CONSTRAINT project_log_attachments_entry_id_fkey   TO proyecto_bitacora_adjuntos_bitacora_id_fkey;
    ALTER TABLE project_log_attachments
      RENAME CONSTRAINT project_log_attachments_comment_id_fkey TO proyecto_bitacora_adjuntos_comentario_id_fkey;

    -- Indexes
    ALTER INDEX project_log_attachments_pkey RENAME TO proyecto_bitacora_adjuntos_pkey;
    ALTER INDEX idx_log_attachments_entry    RENAME TO idx_proyecto_bitacora_adjuntos_bitacora_id;
    ALTER INDEX idx_log_attachments_comment  RENAME TO idx_proyecto_bitacora_adjuntos_comentario_id;

    -- Sequence
    ALTER SEQUENCE project_log_attachments_id_seq RENAME TO proyecto_bitacora_adjuntos_id_seq;

    -- Table
    ALTER TABLE project_log_attachments RENAME TO proyecto_bitacora_adjuntos;
  END IF;

  RAISE NOTICE 'Renamed bitacora subsystem to Spanish (Cycle 2 of DB Spanish standardization)';
END $$;
