-- 126_cuenta_numero_partial_unique_and_compact_plan_progreso.sql
--
-- 1) Swap UNIQUE (proyecto_id, numero) for a partial unique that only
--    constrains active rows. Soft-deleted cuentas no longer block
--    renumbering of subsequent active cuentas when a hole is closed.
-- 2) One-shot: close the existing gap in the Plan Progreso project
--    (Cuenta 4 was deleted, leaving Cuenta 3 + Cuenta 5). Other
--    projects are NOT touched.

ALTER TABLE cuentas DROP CONSTRAINT IF EXISTS cuentas_proyecto_id_numero_key;

CREATE UNIQUE INDEX IF NOT EXISTS cuentas_proyecto_id_numero_active_key
  ON cuentas (proyecto_id, numero) WHERE activo = TRUE;

DO $$
DECLARE
  v_proj_id INTEGER;
  v_lowest  INTEGER;
BEGIN
  SELECT id INTO v_proj_id
  FROM proyectos
  WHERE nombre ILIKE '%plan progreso%' AND activo = TRUE
  LIMIT 1;

  IF v_proj_id IS NULL THEN
    RAISE NOTICE 'Plan Progreso project not found; skipping gap compact.';
    RETURN;
  END IF;

  SELECT MIN(numero) INTO v_lowest
  FROM cuentas WHERE proyecto_id = v_proj_id AND activo = TRUE;

  IF v_lowest IS NULL THEN RETURN; END IF;

  -- Two-step renumber: park active cuentas at negative numbers, then
  -- assign sequential positives. Avoids transient unique-index conflicts
  -- if PG happens to update rows in an unfavourable order.
  UPDATE cuentas SET numero = -numero
  WHERE proyecto_id = v_proj_id AND activo = TRUE;

  WITH ordered AS (
    SELECT id, ROW_NUMBER() OVER (ORDER BY numero DESC) - 1 AS offset
    FROM cuentas
    WHERE proyecto_id = v_proj_id AND activo = TRUE
  )
  UPDATE cuentas c
  SET numero = v_lowest + ordered.offset
  FROM ordered
  WHERE c.id = ordered.id;
END $$;
