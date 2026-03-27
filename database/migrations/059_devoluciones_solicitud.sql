-- 059_devoluciones_solicitud.sql
-- Track full refunds (devoluciones) on solicitudes de pago
CREATE TABLE IF NOT EXISTS devoluciones_solicitud (
    id SERIAL PRIMARY KEY,
    solicitud_id INTEGER NOT NULL REFERENCES solicitudes_pago(id),
    fecha_devolucion DATE NOT NULL,
    motivo TEXT NOT NULL,
    comprobante_url TEXT NOT NULL,
    comprobante_nombre TEXT NOT NULL,
    registrado_por INTEGER REFERENCES users(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(solicitud_id)
);
