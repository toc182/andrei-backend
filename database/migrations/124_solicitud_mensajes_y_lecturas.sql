-- 124_solicitud_mensajes_y_lecturas.sql
-- Adds a single optional "mensaje" per solicitud_pago plus per-user read
-- tracking. Invariant maintained in application code:
--   mensaje IS NULL <=> mensaje_updated_at IS NULL <=> mensaje_autor_id IS NULL

ALTER TABLE solicitudes_pago
  ADD COLUMN IF NOT EXISTS mensaje TEXT,
  ADD COLUMN IF NOT EXISTS mensaje_autor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS mensaje_updated_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_solicitudes_pago_mensaje_autor
  ON solicitudes_pago(mensaje_autor_id);

CREATE TABLE IF NOT EXISTS solicitud_mensaje_lecturas (
  solicitud_pago_id INTEGER NOT NULL REFERENCES solicitudes_pago(id) ON DELETE CASCADE,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  leido_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (solicitud_pago_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_solicitud_mensaje_lecturas_user
  ON solicitud_mensaje_lecturas(user_id);
