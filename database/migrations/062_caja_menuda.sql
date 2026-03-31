-- 062_caja_menuda.sql

-- Permission column
ALTER TABLE user_permissions ADD COLUMN IF NOT EXISTS caja_menuda BOOLEAN DEFAULT FALSE;

-- Cajas menudas
CREATE TABLE IF NOT EXISTS cajas_menudas (
  id SERIAL PRIMARY KEY,
  proyecto_id INTEGER NOT NULL REFERENCES proyectos(id),
  responsable_id INTEGER NOT NULL REFERENCES users(id),
  nombre VARCHAR(200) NOT NULL,
  monto_asignado NUMERIC(12,2) NOT NULL,
  estado VARCHAR(20) DEFAULT 'abierta',
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Historial de cambios de monto
CREATE TABLE IF NOT EXISTS cajas_menudas_historial_monto (
  id SERIAL PRIMARY KEY,
  caja_menuda_id INTEGER NOT NULL REFERENCES cajas_menudas(id),
  monto_anterior NUMERIC(12,2) NOT NULL,
  monto_nuevo NUMERIC(12,2) NOT NULL,
  cambiado_por INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Gastos
CREATE TABLE IF NOT EXISTS cajas_menudas_gastos (
  id SERIAL PRIMARY KEY,
  caja_menuda_id INTEGER NOT NULL REFERENCES cajas_menudas(id),
  fecha DATE NOT NULL,
  proveedor VARCHAR(300) NOT NULL,
  descripcion VARCHAR(500) NOT NULL,
  monto NUMERIC(12,2) NOT NULL,
  itbms NUMERIC(12,2) DEFAULT 0,
  monto_total NUMERIC(12,2) NOT NULL,
  solicitud_reembolso_id INTEGER REFERENCES solicitudes_pago(id),
  registrado_por INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Adjuntos
CREATE TABLE IF NOT EXISTS cajas_menudas_adjuntos (
  id SERIAL PRIMARY KEY,
  caja_menuda_id INTEGER NOT NULL REFERENCES cajas_menudas(id),
  nombre_original VARCHAR(500) NOT NULL,
  r2_key VARCHAR(1000) NOT NULL,
  tipo_mime VARCHAR(100) NOT NULL,
  tamano INTEGER NOT NULL,
  subido_por INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
