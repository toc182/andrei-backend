-- Add project types: licitaciones and oportunidades
-- These are separate entities that can become regular projects

-- Licitaciones table
CREATE TABLE licitaciones (
    id SERIAL PRIMARY KEY,
    numero_licitacion VARCHAR(100) NOT NULL UNIQUE,
    nombre VARCHAR(500) NOT NULL,
    entidad_licitante VARCHAR(200) NOT NULL,
    fecha_apertura DATE,
    fecha_cierre DATE NOT NULL,
    presupuesto_referencial NUMERIC,
    moneda VARCHAR(3) DEFAULT 'USD',
    plazo_ejecucion_dias INTEGER,
    estado_licitacion VARCHAR(50) DEFAULT 'activa',
    -- Estados: 'activa', 'presentada', 'ganada', 'perdida', 'cancelada'
    documentos_licitacion TEXT, -- URLs o descripción de documentos
    requisitos_tecnicos TEXT,
    ubicacion_proyecto TEXT,
    observaciones TEXT,
    fecha_presentacion TIMESTAMP,
    presentada_por INTEGER REFERENCES users(id),
    resultado VARCHAR(100), -- si ganada/perdida, detalles
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by INTEGER NOT NULL REFERENCES users(id)
);

-- Oportunidades table  
CREATE TABLE oportunidades (
    id SERIAL PRIMARY KEY,
    nombre_oportunidad VARCHAR(500) NOT NULL,
    cliente_potencial VARCHAR(200),
    contacto_referido VARCHAR(100),
    telefono_contacto VARCHAR(20),
    email_contacto VARCHAR(255),
    valor_estimado NUMERIC,
    moneda VARCHAR(3) DEFAULT 'USD',
    probabilidad_cierre INTEGER CHECK (probabilidad_cierre >= 0 AND probabilidad_cierre <= 100),
    estado_oportunidad VARCHAR(50) DEFAULT 'prospecto',
    -- Estados: 'prospecto', 'calificada', 'propuesta', 'negociacion', 'cerrada', 'perdida'
    fecha_contacto_inicial DATE DEFAULT CURRENT_DATE,
    fecha_estimada_cierre DATE,
    tipo_trabajo VARCHAR(100), -- ej: 'tuberias', 'edificacion', 'carreteras'
    notas_comerciales TEXT,
    siguiente_accion VARCHAR(255),
    fecha_siguiente_seguimiento DATE,
    origen VARCHAR(100), -- ej: 'referido', 'marketing', 'contacto_directo'
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by INTEGER NOT NULL REFERENCES users(id),
    assigned_to INTEGER REFERENCES users(id) -- quién está manejando la oportunidad
);

-- Update proyectos table to reference licitaciones and oportunidades
ALTER TABLE proyectos ADD COLUMN licitacion_id INTEGER REFERENCES licitaciones(id);
ALTER TABLE proyectos ADD COLUMN oportunidad_id INTEGER REFERENCES oportunidades(id);
ALTER TABLE proyectos ADD COLUMN tipo_origen VARCHAR(20) DEFAULT 'directo';
-- Valores: 'directo', 'licitacion', 'oportunidad'

-- Add indexes for performance
CREATE INDEX idx_proyectos_licitacion_id ON proyectos(licitacion_id);
CREATE INDEX idx_proyectos_oportunidad_id ON proyectos(oportunidad_id);
CREATE INDEX idx_licitaciones_estado ON licitaciones(estado_licitacion);
CREATE INDEX idx_oportunidades_estado ON oportunidades(estado_oportunidad);

-- Add some example states
COMMENT ON COLUMN licitaciones.estado_licitacion IS 'Estados: activa, presentada, ganada, perdida, cancelada';
COMMENT ON COLUMN oportunidades.estado_oportunidad IS 'Estados: prospecto, calificada, propuesta, negociacion, cerrada, perdida';