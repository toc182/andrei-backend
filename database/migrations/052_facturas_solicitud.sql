-- Tabla de facturas de solicitudes de pago
CREATE TABLE IF NOT EXISTS facturas_solicitud (
  id SERIAL PRIMARY KEY,
  solicitud_pago_id INTEGER NOT NULL REFERENCES solicitudes_pago(id) ON DELETE CASCADE UNIQUE,
  fecha_factura DATE NOT NULL,
  numero_factura VARCHAR(100),
  registrado_por INTEGER REFERENCES users(id),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_fs_solicitud ON facturas_solicitud(solicitud_pago_id);

-- Agregar 'facturada' al CHECK constraint de estados
ALTER TABLE solicitudes_pago DROP CONSTRAINT solicitudes_pago_estado_check;
ALTER TABLE solicitudes_pago ADD CONSTRAINT solicitudes_pago_estado_check
  CHECK (estado IN ('borrador', 'pendiente', 'aprobada', 'rechazada', 'pagada', 'facturada'));
