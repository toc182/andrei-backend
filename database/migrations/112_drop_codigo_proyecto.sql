-- 112_drop_codigo_proyecto.sql
-- L3 from schema audit: proyectos.codigo_proyecto is a half-built feature
-- column. NULL on every existing row, never populated, no UI input. All
-- frontend/backend code references have been removed in the same release.
-- Self-verifying — aborts if any row has a non-NULL codigo_proyecto so we
-- don't silently drop real data.

DO $$
DECLARE
  populated_count INTEGER;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'proyectos'
      AND column_name = 'codigo_proyecto'
  ) THEN
    SELECT COUNT(*) INTO populated_count
    FROM proyectos
    WHERE codigo_proyecto IS NOT NULL;

    IF populated_count > 0 THEN
      RAISE EXCEPTION
        'Migration 112 aborted. proyectos has % rows with a non-NULL codigo_proyecto. Resolve before dropping the column.',
        populated_count;
    END IF;

    RAISE NOTICE 'Preflight passed. Dropping proyectos.codigo_proyecto.';
    ALTER TABLE proyectos DROP COLUMN codigo_proyecto;
    RAISE NOTICE 'Migration 112 complete.';
  ELSE
    RAISE NOTICE 'Column already dropped — migration 112 is a no-op.';
  END IF;
END $$;
