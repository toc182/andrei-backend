-- Migración 017: Crear tabla registro_uso_equipos
-- Fecha: 2025-10-03

CREATE TABLE registro_uso_equipos (
    id SERIAL PRIMARY KEY,
    asignacion_id INTEGER NOT NULL REFERENCES asignaciones_equipos(id) ON DELETE CASCADE,
    fecha_inicio DATE NOT NULL,
    fecha_fin DATE,
    cantidad DECIMAL(10,2),
    observaciones TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Índices para mejorar performance
CREATE INDEX idx_registro_uso_equipos_asignacion_id ON registro_uso_equipos(asignacion_id);
CREATE INDEX idx_registro_uso_equipos_fecha_inicio ON registro_uso_equipos(fecha_inicio);