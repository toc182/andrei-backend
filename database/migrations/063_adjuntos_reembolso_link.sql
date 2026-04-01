-- 063_adjuntos_reembolso_link.sql
-- Link adjuntos to reembolsos (same pattern as gastos)
ALTER TABLE cajas_menudas_adjuntos ADD COLUMN IF NOT EXISTS solicitud_reembolso_id INTEGER REFERENCES solicitudes_pago(id);
