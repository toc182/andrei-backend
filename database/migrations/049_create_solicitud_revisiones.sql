-- Migration 049: Create solicitud_revisiones table
-- Date: 2026-03-05
-- Description: Tracks which approvers have reviewed a solicitud de pago.
-- Required by the pending_my_approval filter and approval workflow.

CREATE TABLE IF NOT EXISTS solicitud_revisiones (
    id SERIAL PRIMARY KEY,
    solicitud_pago_id INTEGER NOT NULL REFERENCES solicitudes_pago(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (solicitud_pago_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_solicitud_revisiones_solicitud ON solicitud_revisiones(solicitud_pago_id);
CREATE INDEX IF NOT EXISTS idx_solicitud_revisiones_user ON solicitud_revisiones(user_id);
