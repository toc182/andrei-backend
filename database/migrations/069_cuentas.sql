-- 069_cuentas.sql

ALTER TABLE proyectos ADD COLUMN IF NOT EXISTS tiene_ipt BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE user_permissions ADD COLUMN IF NOT EXISTS cuentas BOOLEAN DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS cuentas (
  id SERIAL PRIMARY KEY,
  proyecto_id INTEGER NOT NULL REFERENCES proyectos(id),
  numero INTEGER NOT NULL,
  es_final BOOLEAN NOT NULL DEFAULT FALSE,
  monto_total NUMERIC(14,2) NOT NULL,
  periodo_inicio DATE,
  periodo_fin DATE,
  avance_porcentaje NUMERIC(5,2),
  estado VARCHAR(30) NOT NULL DEFAULT 'borrador',
  fecha_primera_submision DATE,
  fecha_ultima_resubmision DATE,
  fecha_pagada DATE,
  observaciones_pago TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (proyecto_id, numero)
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_cuentas_final_por_proyecto
  ON cuentas (proyecto_id) WHERE es_final = TRUE AND active = TRUE;

CREATE TABLE IF NOT EXISTS cuentas_eventos (
  id SERIAL PRIMARY KEY,
  cuenta_id INTEGER NOT NULL REFERENCES cuentas(id),
  tipo VARCHAR(30) NOT NULL,
  estado_desde VARCHAR(30),
  estado_hacia VARCHAR(30),
  comentario TEXT,
  creado_por INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_cuentas_eventos_cuenta ON cuentas_eventos(cuenta_id, created_at);

CREATE TABLE IF NOT EXISTS cuentas_adjuntos (
  id SERIAL PRIMARY KEY,
  cuenta_id INTEGER NOT NULL REFERENCES cuentas(id),
  nombre_original VARCHAR(500) NOT NULL,
  r2_key VARCHAR(1000) NOT NULL,
  tipo_mime VARCHAR(100) NOT NULL,
  tamano INTEGER NOT NULL,
  subido_por INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_cuentas_adjuntos_cuenta ON cuentas_adjuntos(cuenta_id);
