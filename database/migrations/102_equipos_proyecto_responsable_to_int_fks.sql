-- 102_equipos_proyecto_responsable_to_int_fks.sql
-- C2 + C3 schema audit: replace equipos.proyecto VARCHAR with proyecto_id INTEGER
-- FK to proyectos(id), and equipos.responsable VARCHAR with responsable_id INTEGER
-- FK to users(id). Production verified clean 2026-05-11: zero unmatched names,
-- zero ambiguous matches. Self-verifying preflight aborts if production drifts.

DO $$
DECLARE
  unmatched_proyectos INTEGER;
  unmatched_responsables INTEGER;
  expected_unmatched_proyectos CONSTANT INTEGER := 0;
  expected_unmatched_responsables CONSTANT INTEGER := 0;
  backfilled_proyectos INTEGER;
  backfilled_responsables INTEGER;
BEGIN
  -- Idempotency guard: skip if already migrated.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'equipos' AND column_name = 'proyecto_id'
  ) THEN
    RAISE NOTICE 'Migration 102 already applied; skipping.';
    RETURN;
  END IF;

  -- Preflight: confirm production matches Phase 0 verification.
  SELECT COUNT(*) INTO unmatched_proyectos
  FROM equipos e
  LEFT JOIN proyectos p ON p.nombre_corto = e.proyecto OR p.nombre = e.proyecto
  WHERE e.proyecto IS NOT NULL AND e.proyecto <> '' AND p.id IS NULL;

  SELECT COUNT(*) INTO unmatched_responsables
  FROM equipos e
  LEFT JOIN users u ON u.nombre = e.responsable
  WHERE e.responsable IS NOT NULL AND e.responsable <> '' AND u.id IS NULL;

  IF unmatched_proyectos <> expected_unmatched_proyectos THEN
    RAISE EXCEPTION
      'Migration 102 aborted. Expected % unmatched equipos.proyecto names, found %. Production data drifted since Phase 0 verification (2026-05-11) - re-audit before retry.',
      expected_unmatched_proyectos, unmatched_proyectos;
  END IF;

  IF unmatched_responsables <> expected_unmatched_responsables THEN
    RAISE EXCEPTION
      'Migration 102 aborted. Expected % unmatched equipos.responsable names, found %. Production data drifted - re-audit before retry.',
      expected_unmatched_responsables, unmatched_responsables;
  END IF;

  RAISE NOTICE 'Preflight passed. Proceeding with column additions and backfill.';

  -- C2: equipos.proyecto -> proyecto_id
  ALTER TABLE equipos ADD COLUMN proyecto_id INTEGER REFERENCES proyectos(id);

  UPDATE equipos e
  SET proyecto_id = p.id
  FROM proyectos p
  WHERE (p.nombre_corto = e.proyecto OR p.nombre = e.proyecto)
    AND e.proyecto IS NOT NULL AND e.proyecto <> '';

  GET DIAGNOSTICS backfilled_proyectos = ROW_COUNT;
  RAISE NOTICE 'C2: backfilled % equipos.proyecto_id rows.', backfilled_proyectos;

  DROP INDEX IF EXISTS idx_equipos_proyecto;
  ALTER TABLE equipos DROP COLUMN proyecto;
  CREATE INDEX idx_equipos_proyecto_id ON equipos(proyecto_id);

  -- C3: equipos.responsable -> responsable_id
  ALTER TABLE equipos ADD COLUMN responsable_id INTEGER REFERENCES users(id);

  UPDATE equipos e
  SET responsable_id = u.id
  FROM users u
  WHERE u.nombre = e.responsable
    AND e.responsable IS NOT NULL AND e.responsable <> '';

  GET DIAGNOSTICS backfilled_responsables = ROW_COUNT;
  RAISE NOTICE 'C3: backfilled % equipos.responsable_id rows.', backfilled_responsables;

  ALTER TABLE equipos DROP COLUMN responsable;
  CREATE INDEX idx_equipos_responsable_id ON equipos(responsable_id);

  RAISE NOTICE 'Migration 102 complete.';
END $$;