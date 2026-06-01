-- 128_create_cuenta_ajustes.sql
--
-- Per-cuenta adjustments (retentions, taxes, extras). The cuenta's
-- monto_total stays as the gross/billed amount. The list of ajustes
-- is applied on top to derive the "monto a pagar" — display-only for
-- now; resumen totals continue to use monto_total. Follows the same
-- shape as solicitud_pago_ajustes for consistency.

CREATE TABLE IF NOT EXISTS cuenta_ajustes (
  id SERIAL PRIMARY KEY,
  cuenta_id INTEGER NOT NULL REFERENCES cuentas(id) ON DELETE CASCADE,
  tipo VARCHAR(20) NOT NULL CHECK (tipo IN ('aumento', 'disminucion')),
  descripcion TEXT NOT NULL,
  monto NUMERIC(14,2) NOT NULL CHECK (monto >= 0),
  orden INTEGER NOT NULL DEFAULT 0,
  creado_por INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_cuenta_ajustes_cuenta
  ON cuenta_ajustes(cuenta_id, orden);
