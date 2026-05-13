-- 110_activo_not_null.sql
-- M7 from schema audit: ten tables have a nullable `activo` flag. A NULL
-- value silently fails `WHERE activo = TRUE` filters, hiding rows from the
-- UI even though they were never deactivated. All ten columns already have
-- DEFAULT true; this migration just locks the column. Local DB: zero NULLs
-- across all ten tables. Self-verifying — aborts cleanly if production has
-- any NULLs in any of the listed columns.

DO $$
DECLARE
  null_count INTEGER;
  tbl TEXT;
  tables TEXT[] := ARRAY[
    'categorias_gastos',
    'clientes',
    'contactos_externos',
    'equipos',
    'proyecto_ajustes_aprobacion',
    'proyecto_categorias_gastos',
    'proyecto_categorias_tareas',
    'proyecto_miembros',
    'proyectos',
    'users'
  ];
BEGIN
  -- Preflight: every target table must have zero NULL activo rows.
  FOREACH tbl IN ARRAY tables LOOP
    EXECUTE format('SELECT COUNT(*) FROM %I WHERE activo IS NULL', tbl)
      INTO null_count;
    IF null_count > 0 THEN
      RAISE EXCEPTION
        'Migration 110 aborted. Table % has % rows with NULL activo. Backfill before retry.',
        tbl, null_count;
    END IF;
  END LOOP;

  RAISE NOTICE 'Preflight passed. Locking activo NOT NULL on % tables.', array_length(tables, 1);

  FOREACH tbl IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE %I ALTER COLUMN activo SET NOT NULL', tbl);
  END LOOP;

  RAISE NOTICE 'Migration 110 complete.';
END $$;
