-- 131_fix_plan_progreso_cuentas_1_2_gross.sql
--
-- Plan Progreso cuentas 1 and 2 were created before the ajustes feature
-- existed, so their monto_total was entered as "gross + ITBMS" (the old
-- billed-face-value interpretation). Migration 130 then added ITBMS back
-- as a +aumento ajuste line — which now double-counts the ITBMS.
--
-- Drop the embedded ITBMS off monto_total so it becomes the pre-ITBMS
-- gross, matching how cuentas 3+ are stored under the new feature.
--
-- Idempotent: each UPDATE is guarded by the exact current value we expect
-- (gross + ITBMS), so if the row has already been corrected — or doesn't
-- match for any other reason — the UPDATE is a safe no-op rather than
-- silently mangling data we don't recognise.

-- Cuenta 1: 2,035,235.23 (= 1,902,089.00 gross + 133,146.23 ITBMS) → 1,902,089.00
UPDATE cuentas
   SET monto_total = 1902089.00, updated_at = CURRENT_TIMESTAMP
 WHERE numero = 1
   AND activo = TRUE
   AND monto_total = 2035235.23
   AND proyecto_id = (SELECT id FROM proyectos WHERE nombre_corto = 'Plan Progreso');

-- Cuenta 2: 1,029,775.70 (= 962,407.20 gross + 67,368.50 ITBMS) → 962,407.20
UPDATE cuentas
   SET monto_total = 962407.20, updated_at = CURRENT_TIMESTAMP
 WHERE numero = 2
   AND activo = TRUE
   AND monto_total = 1029775.70
   AND proyecto_id = (SELECT id FROM proyectos WHERE nombre_corto = 'Plan Progreso');
