-- 061_create_correcciones_solicitud.sql
-- Correction log for solicitudes de pago (Issue #12)

CREATE TABLE IF NOT EXISTS correcciones_solicitud (
  id SERIAL PRIMARY KEY,
  solicitud_pago_id INTEGER NOT NULL REFERENCES solicitudes_pago(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  motivo TEXT NOT NULL,
  cambios JSONB NOT NULL,
  version_pdf VARCHAR(500),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_correcciones_solicitud_pago_id
  ON correcciones_solicitud(solicitud_pago_id);
