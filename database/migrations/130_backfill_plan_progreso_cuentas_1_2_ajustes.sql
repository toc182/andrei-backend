-- 130_backfill_plan_progreso_cuentas_1_2_ajustes.sql
--
-- Cuentas 1 and 2 of Plan Progreso were paid before the ajustes feature
-- existed, so the breakdown rows (ITBMS, Retención ITBMS, Retención por
-- garantía 10%) were never recorded. Insert them so the displayed
-- "Total a cobrar" matches the amount that was actually paid.
--
-- Idempotent: each cuenta is only touched if it currently has no ajustes,
-- so re-running this migration after the fact is a no-op. The wording and
-- ordering match the existing ajustes on cuentas 3+ of the same project.

WITH proj AS (
  SELECT id FROM proyectos WHERE nombre_corto = 'Plan Progreso'
),
cuenta_1 AS (
  SELECT c.id, c.creado_por
  FROM cuentas c
  JOIN proj ON proj.id = c.proyecto_id
  WHERE c.numero = 1 AND c.activo = TRUE
    AND NOT EXISTS (SELECT 1 FROM cuenta_ajustes WHERE cuenta_id = c.id)
),
cuenta_2 AS (
  SELECT c.id, c.creado_por
  FROM cuentas c
  JOIN proj ON proj.id = c.proyecto_id
  WHERE c.numero = 2 AND c.activo = TRUE
    AND NOT EXISTS (SELECT 1 FROM cuenta_ajustes WHERE cuenta_id = c.id)
)
INSERT INTO cuenta_ajustes (cuenta_id, tipo, descripcion, monto, orden, creado_por)
SELECT id, 'aumento',     'ITBMS',                          133146.23, 0, creado_por FROM cuenta_1
UNION ALL
SELECT id, 'disminucion', 'Retención itbms',                 66573.12, 1, creado_por FROM cuenta_1
UNION ALL
SELECT id, 'disminucion', 'Retención por garantía (10%)',   190208.90, 2, creado_por FROM cuenta_1
UNION ALL
SELECT id, 'aumento',     'ITBMS',                           67368.50, 0, creado_por FROM cuenta_2
UNION ALL
SELECT id, 'disminucion', 'Retención itbms',                 33684.25, 1, creado_por FROM cuenta_2
UNION ALL
SELECT id, 'disminucion', 'Retención por garantía (10%)',    96240.72, 2, creado_por FROM cuenta_2;
