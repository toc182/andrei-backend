-- 070_cuentas_ipt.sql

CREATE TABLE IF NOT EXISTS cuentas_ipt (
  id SERIAL PRIMARY KEY,
  cuenta_id INTEGER NOT NULL UNIQUE REFERENCES cuentas(id),
  estado VARCHAR(30) NOT NULL DEFAULT 'pendiente',
  observaciones_texto TEXT,
  fecha_firma_ministro DATE,
  firma_ministro_por INTEGER REFERENCES users(id),
  fecha_firma_mef DATE,
  firma_mef_por INTEGER REFERENCES users(id),
  fecha_firma_contralor DATE,
  firma_contralor_por INTEGER REFERENCES users(id),
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_cuentas_ipt_cuenta ON cuentas_ipt(cuenta_id);
