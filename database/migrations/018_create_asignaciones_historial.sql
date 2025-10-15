-- Migración: Crear tabla de historial de cambios para asignaciones
-- Fecha: 2025-10-07

CREATE TABLE IF NOT EXISTS asignaciones_historial (
    id SERIAL PRIMARY KEY,
    asignacion_id INTEGER NOT NULL REFERENCES asignaciones_equipos(id) ON DELETE CASCADE,
    campo_modificado VARCHAR(100) NOT NULL,
    valor_anterior TEXT,
    valor_nuevo TEXT,
    usuario_id INTEGER REFERENCES users(id),
    fecha_cambio TIMESTAMP DEFAULT NOW(),
    observaciones TEXT
);

-- Índices para mejorar consultas
CREATE INDEX idx_asignaciones_historial_asignacion_id ON asignaciones_historial(asignacion_id);
CREATE INDEX idx_asignaciones_historial_fecha_cambio ON asignaciones_historial(fecha_cambio);
CREATE INDEX idx_asignaciones_historial_campo ON asignaciones_historial(campo_modificado);

-- Comentarios
COMMENT ON TABLE asignaciones_historial IS 'Historial de cambios en asignaciones de equipos';
COMMENT ON COLUMN asignaciones_historial.campo_modificado IS 'Nombre del campo que fue modificado';
COMMENT ON COLUMN asignaciones_historial.valor_anterior IS 'Valor antes del cambio';
COMMENT ON COLUMN asignaciones_historial.valor_nuevo IS 'Valor después del cambio';
