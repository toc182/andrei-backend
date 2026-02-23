-- Migración 042: Crear módulo de Solicitudes de Pago

-- Agregar prefijo de numeración a proyectos
ALTER TABLE proyectos ADD COLUMN IF NOT EXISTS sp_prefijo VARCHAR(20);

-- Tabla principal de solicitudes de pago
CREATE TABLE IF NOT EXISTS solicitudes_pago (
  id SERIAL PRIMARY KEY,
  proyecto_id INTEGER REFERENCES proyectos(id),
  numero VARCHAR NOT NULL,
  fecha DATE NOT NULL DEFAULT CURRENT_DATE,
  proveedor VARCHAR NOT NULL,
  preparado_por INTEGER REFERENCES users(id),
  solicitado_por INTEGER REFERENCES users(id),
  requisicion_id INTEGER REFERENCES requisiciones(id),
  subtotal NUMERIC(12,2) DEFAULT 0,
  descuentos NUMERIC(12,2) DEFAULT 0,
  impuestos NUMERIC(12,2) DEFAULT 0,
  monto_total NUMERIC(12,2) DEFAULT 0,
  estado VARCHAR NOT NULL DEFAULT 'borrador',
  observaciones TEXT,
  beneficiario VARCHAR,
  banco VARCHAR,
  tipo_cuenta VARCHAR,
  numero_cuenta VARCHAR,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT solicitudes_pago_estado_check CHECK (estado IN ('borrador', 'pendiente', 'aprobada', 'rechazada', 'pagada'))
);

CREATE INDEX IF NOT EXISTS idx_sp_proyecto ON solicitudes_pago(proyecto_id);
CREATE INDEX IF NOT EXISTS idx_sp_numero ON solicitudes_pago(numero);
CREATE INDEX IF NOT EXISTS idx_sp_estado ON solicitudes_pago(estado);
CREATE INDEX IF NOT EXISTS idx_sp_preparado_por ON solicitudes_pago(preparado_por);

-- Items de la solicitud de pago
CREATE TABLE IF NOT EXISTS solicitud_pago_items (
  id SERIAL PRIMARY KEY,
  solicitud_pago_id INTEGER NOT NULL REFERENCES solicitudes_pago(id) ON DELETE CASCADE,
  cantidad NUMERIC(12,2) NOT NULL DEFAULT 1,
  unidad VARCHAR DEFAULT 'unidad',
  descripcion VARCHAR NOT NULL,
  descripcion_detallada TEXT,
  precio_unitario NUMERIC(12,2) NOT NULL,
  precio_total NUMERIC(12,2) NOT NULL,
  orden INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_spi_solicitud ON solicitud_pago_items(solicitud_pago_id);

-- Ajustes (impuestos y descuentos)
CREATE TABLE IF NOT EXISTS solicitud_pago_ajustes (
  id SERIAL PRIMARY KEY,
  solicitud_pago_id INTEGER NOT NULL REFERENCES solicitudes_pago(id) ON DELETE CASCADE,
  tipo VARCHAR NOT NULL,
  descripcion VARCHAR NOT NULL,
  porcentaje NUMERIC(8,4),
  monto NUMERIC(12,2) NOT NULL,
  orden INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT spa_tipo_check CHECK (tipo IN ('impuesto', 'descuento'))
);

CREATE INDEX IF NOT EXISTS idx_spa_solicitud ON solicitud_pago_ajustes(solicitud_pago_id);
