-- Flag para indicar que Pinellas paga esta solicitud
ALTER TABLE solicitudes_pago ADD COLUMN IF NOT EXISTS pinellas_paga BOOLEAN NOT NULL DEFAULT false;

-- Tabla de reembolsos a Pinellas
CREATE TABLE IF NOT EXISTS reembolsos_pinellas (
  id SERIAL PRIMARY KEY,
  solicitud_id INTEGER NOT NULL REFERENCES solicitudes_pago(id) ON DELETE CASCADE,
  comprobante_url TEXT,
  comprobante_nombre VARCHAR(255),
  fecha_reembolso DATE NOT NULL DEFAULT CURRENT_DATE,
  registrado_por INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(solicitud_id)
);
