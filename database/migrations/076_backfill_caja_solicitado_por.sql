-- 076_backfill_caja_solicitado_por.sql
-- Fix A from C6 audit: backfill solicitado_por on caja-menuda-derived solicitudes.
-- The INSERT paths now propagate caja.responsable_id, but existing rows have NULL.
-- This sets solicitado_por = caja.responsable_id for every apertura / aumento / reembolso
-- solicitud that traces back to a caja menuda.

UPDATE solicitudes_pago sp
SET solicitado_por = c.responsable_id
FROM (
  -- Apertura: original caja creation
  SELECT solicitud_apertura_id AS sol_id, responsable_id
  FROM cajas_menudas
  WHERE solicitud_apertura_id IS NOT NULL

  UNION

  -- Apertura: monto aumento solicitudes
  SELECT chm.solicitud_id AS sol_id, cm.responsable_id
  FROM cajas_menudas_historial_monto chm
  JOIN cajas_menudas cm ON cm.id = chm.caja_menuda_id
  WHERE chm.solicitud_id IS NOT NULL

  UNION

  -- Reembolso: linked from gastos
  SELECT DISTINCT cmg.solicitud_reembolso_id AS sol_id, cm.responsable_id
  FROM cajas_menudas_gastos cmg
  JOIN cajas_menudas cm ON cm.id = cmg.caja_menuda_id
  WHERE cmg.solicitud_reembolso_id IS NOT NULL

  UNION

  -- Reembolso: linked from adjuntos
  SELECT DISTINCT cma.solicitud_reembolso_id AS sol_id, cm.responsable_id
  FROM cajas_menudas_adjuntos cma
  JOIN cajas_menudas cm ON cm.id = cma.caja_menuda_id
  WHERE cma.solicitud_reembolso_id IS NOT NULL
) c
WHERE sp.id = c.sol_id
  AND sp.solicitado_por IS NULL;
