-- 192_caja_menuda_cancelada.sql
-- A caja whose opening request is rejected is cancelled (Ivan, 2026-11-19):
-- its amount goes to 0, nothing more can be registered in it, and it shows
-- under «Inactivas» with the closed ones. It stays in the system with its
-- rejected request, so who rejected it and why can still be seen.
ALTER TABLE cajas_menudas DROP CONSTRAINT IF EXISTS cajas_menudas_estado_check;
ALTER TABLE cajas_menudas
  ADD CONSTRAINT cajas_menudas_estado_check
  CHECK (estado IN ('abierta', 'cerrada', 'cancelada'));
