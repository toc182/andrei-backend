CREATE TABLE IF NOT EXISTS solicitud_pago_adjuntos (
  id SERIAL PRIMARY KEY,
  solicitud_pago_id INTEGER NOT NULL REFERENCES solicitudes_pago(id) ON DELETE CASCADE,
  nombre_original VARCHAR(500) NOT NULL,
  r2_key VARCHAR(1000) NOT NULL,
  tipo_mime VARCHAR(100) NOT NULL,
  tamano INTEGER NOT NULL,
  subido_por INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_spadj_solicitud ON solicitud_pago_adjuntos(solicitud_pago_id);
