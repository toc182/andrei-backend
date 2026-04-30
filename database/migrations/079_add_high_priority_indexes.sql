-- 079_add_high_priority_indexes.sql
-- High-priority indexes from the schema-health audit (H9–H18).
-- Adds indexes on FK columns that are queried often but currently scan-full.
-- Idempotent: CREATE INDEX IF NOT EXISTS.

-- H9 — listing cajas by project
CREATE INDEX IF NOT EXISTS idx_cajas_menudas_proyecto_id
  ON cajas_menudas(proyecto_id);

-- H10 — "mis cajas" view
CREATE INDEX IF NOT EXISTS idx_cajas_menudas_responsable_id
  ON cajas_menudas(responsable_id);

-- H11 — loading adjuntos for a caja
CREATE INDEX IF NOT EXISTS idx_cajas_menudas_adjuntos_caja_menuda_id
  ON cajas_menudas_adjuntos(caja_menuda_id);

-- H12 — loading gastos for a caja
CREATE INDEX IF NOT EXISTS idx_cajas_menudas_gastos_caja_menuda_id
  ON cajas_menudas_gastos(caja_menuda_id);

-- H13 — loading monto-change history for a caja
CREATE INDEX IF NOT EXISTS idx_cajas_menudas_historial_monto_caja_menuda_id
  ON cajas_menudas_historial_monto(caja_menuda_id);

-- H14 — joining requisicion → solicitud_pago
CREATE INDEX IF NOT EXISTS idx_solicitudes_pago_requisicion_id
  ON solicitudes_pago(requisicion_id);

-- H15 — "mis solicitudes" filter
CREATE INDEX IF NOT EXISTS idx_solicitudes_pago_solicitado_por
  ON solicitudes_pago(solicitado_por);

-- H16 — "mis requisiciones" filter
CREATE INDEX IF NOT EXISTS idx_requisiciones_solicitado_por
  ON requisiciones(solicitado_por);

-- H17 — reports filtered by approver
CREATE INDEX IF NOT EXISTS idx_requisiciones_aprobado_por
  ON requisiciones(aprobado_por);

-- H18 — filtering requisitions by category
CREATE INDEX IF NOT EXISTS idx_requisiciones_categoria_id
  ON requisiciones(categoria_id);
