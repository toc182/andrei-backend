-- Migración 016: Crear tabla asignaciones_equipos
-- Fecha: 2025-10-03

CREATE TABLE asignaciones_equipos (
    id SERIAL PRIMARY KEY,
    equipo_id INTEGER NOT NULL REFERENCES equipos(id) ON DELETE CASCADE,
    cliente_id INTEGER NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
    proyecto_id INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
    responsable_id VARCHAR(255),
    fecha_inicio DATE NOT NULL,
    fecha_fin DATE,
    tipo_uso VARCHAR(50) CHECK (tipo_uso IN ('propio', 'alquiler')),
    tipo_cobro VARCHAR(50) CHECK (tipo_cobro IN ('hora', 'dia', 'semana', 'mes', 'no_aplica')),
    tarifa DECIMAL(10,2),
    incluye_operador BOOLEAN DEFAULT FALSE,
    costo_operador DECIMAL(10,2),
    incluye_combustible BOOLEAN DEFAULT FALSE,
    costo_combustible DECIMAL(10,2),
    ajuste_monto DECIMAL(10,2),
    motivo_ajuste TEXT,
    estado VARCHAR(50) DEFAULT 'activa' CHECK (estado IN ('activa', 'finalizada', 'facturada')),
    observaciones TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Índices para mejorar performance
CREATE INDEX idx_asignaciones_equipos_equipo_id ON asignaciones_equipos(equipo_id);
CREATE INDEX idx_asignaciones_equipos_cliente_id ON asignaciones_equipos(cliente_id);
CREATE INDEX idx_asignaciones_equipos_proyecto_id ON asignaciones_equipos(proyecto_id);
CREATE INDEX idx_asignaciones_equipos_estado ON asignaciones_equipos(estado);
CREATE INDEX idx_asignaciones_equipos_fecha_inicio ON asignaciones_equipos(fecha_inicio);