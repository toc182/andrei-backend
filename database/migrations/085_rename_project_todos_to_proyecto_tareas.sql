-- 085_rename_project_todos_to_proyecto_tareas.sql
-- DB Spanish standardization — Cycle 5 (todos mega-cycle)
-- Renames the 3 todos tables and all their English columns.

DO $$
BEGIN
  -- ============== TABLE 1: project_todo_categories -> proyecto_categorias_tareas ==============
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'project_todo_categories' AND table_schema = 'public'
  ) THEN
    ALTER TABLE project_todo_categories RENAME COLUMN project_id TO proyecto_id;

    ALTER TABLE project_todo_categories
      RENAME CONSTRAINT project_todo_categories_project_id_fkey
                     TO proyecto_categorias_tareas_proyecto_id_fkey;

    ALTER INDEX project_todo_categories_pkey
      RENAME TO proyecto_categorias_tareas_pkey;
    ALTER INDEX project_todo_categories_project_id_nombre_key
      RENAME TO proyecto_categorias_tareas_proyecto_id_nombre_key;
    ALTER INDEX idx_project_todo_categories_project
      RENAME TO idx_proyecto_categorias_tareas_proyecto_id;

    ALTER SEQUENCE project_todo_categories_id_seq
      RENAME TO proyecto_categorias_tareas_id_seq;

    ALTER TABLE project_todo_categories RENAME TO proyecto_categorias_tareas;
  END IF;

  -- ============== TABLE 2: project_todos -> proyecto_tareas ==============
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'project_todos' AND table_schema = 'public'
  ) THEN
    ALTER TABLE project_todos RENAME COLUMN project_id  TO proyecto_id;
    ALTER TABLE project_todos RENAME COLUMN category_id TO categoria_id;
    ALTER TABLE project_todos RENAME COLUMN created_by  TO creado_por;

    ALTER TABLE project_todos
      RENAME CONSTRAINT project_todos_project_id_fkey       TO proyecto_tareas_proyecto_id_fkey;
    ALTER TABLE project_todos
      RENAME CONSTRAINT project_todos_category_id_fkey      TO proyecto_tareas_categoria_id_fkey;
    ALTER TABLE project_todos
      RENAME CONSTRAINT project_todos_created_by_fkey       TO proyecto_tareas_creado_por_fkey;
    ALTER TABLE project_todos
      RENAME CONSTRAINT project_todos_asignado_a_fkey       TO proyecto_tareas_asignado_a_fkey;
    ALTER TABLE project_todos
      RENAME CONSTRAINT project_todos_completado_por_fkey   TO proyecto_tareas_completado_por_fkey;
    ALTER TABLE project_todos
      RENAME CONSTRAINT project_todos_estado_check          TO proyecto_tareas_estado_check;
    ALTER TABLE project_todos
      RENAME CONSTRAINT project_todos_prioridad_check       TO proyecto_tareas_prioridad_check;

    ALTER INDEX project_todos_pkey         RENAME TO proyecto_tareas_pkey;
    ALTER INDEX idx_project_todos_project  RENAME TO idx_proyecto_tareas_proyecto_id;
    ALTER INDEX idx_project_todos_asignado RENAME TO idx_proyecto_tareas_asignado_a;
    ALTER INDEX idx_project_todos_estado   RENAME TO idx_proyecto_tareas_estado;
    ALTER INDEX idx_project_todos_prioridad RENAME TO idx_proyecto_tareas_prioridad;

    ALTER SEQUENCE project_todos_id_seq RENAME TO proyecto_tareas_id_seq;

    ALTER TABLE project_todos RENAME TO proyecto_tareas;
  END IF;

  -- ============== TABLE 3: project_todo_comments -> proyecto_tareas_comentarios ==============
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'project_todo_comments' AND table_schema = 'public'
  ) THEN
    ALTER TABLE project_todo_comments RENAME COLUMN todo_id TO tarea_id;

    ALTER TABLE project_todo_comments
      RENAME CONSTRAINT project_todo_comments_todo_id_fkey  TO proyecto_tareas_comentarios_tarea_id_fkey;
    ALTER TABLE project_todo_comments
      RENAME CONSTRAINT project_todo_comments_user_id_fkey  TO proyecto_tareas_comentarios_user_id_fkey;

    ALTER INDEX project_todo_comments_pkey   RENAME TO proyecto_tareas_comentarios_pkey;
    ALTER INDEX idx_todo_comments_todo_id    RENAME TO idx_proyecto_tareas_comentarios_tarea_id;
    ALTER INDEX idx_todo_comments_created    RENAME TO idx_proyecto_tareas_comentarios_created_at;

    ALTER SEQUENCE project_todo_comments_id_seq RENAME TO proyecto_tareas_comentarios_id_seq;

    ALTER TABLE project_todo_comments RENAME TO proyecto_tareas_comentarios;
  END IF;

  RAISE NOTICE 'Renamed todos subsystem to Spanish (Cycle 5 of DB Spanish standardization)';
END $$;
