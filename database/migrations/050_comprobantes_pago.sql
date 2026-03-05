-- Tabla para registrar comprobantes de pago
CREATE TABLE IF NOT EXISTS comprobantes_pago (
  id SERIAL PRIMARY KEY,
  solicitud_pago_id INT NOT NULL REFERENCES solicitudes_pago(id) ON DELETE CASCADE UNIQUE,
  fecha_pago DATE NOT NULL,
  registrado_por INT REFERENCES users(id),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Distinguir adjuntos normales de comprobantes
ALTER TABLE solicitud_pago_adjuntos ADD COLUMN IF NOT EXISTS tipo_adjunto VARCHAR(20) DEFAULT 'adjunto';

-- Permiso para registrar pagos
ALTER TABLE user_permissions ADD COLUMN IF NOT EXISTS registrar_pago BOOLEAN DEFAULT false;
