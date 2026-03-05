-- Migration 048: Recreate licitaciones and oportunidades tables
-- Date: 2026-03-05
-- Description: These tables were created in 002 but dropped in 015.
-- The foreign key columns in proyectos still exist, so we only recreate the tables.

-- Licitaciones table
CREATE TABLE IF NOT EXISTS licitaciones (
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
    documentos_licitacion TEXT,
    requisitos_tecnicos TEXT,
    ubicacion_proyecto TEXT,
    observaciones TEXT,
    fecha_presentacion TIMESTAMP,
    presentada_por INTEGER REFERENCES users(id),
    resultado VARCHAR(100),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by INTEGER NOT NULL REFERENCES users(id)
);

-- Oportunidades table
CREATE TABLE IF NOT EXISTS oportunidades (
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
    fecha_contacto_inicial DATE DEFAULT CURRENT_DATE,
    fecha_estimada_cierre DATE,
    tipo_trabajo VARCHAR(100),
    notas_comerciales TEXT,
    siguiente_accion VARCHAR(255),
    fecha_siguiente_seguimiento DATE,
    origen VARCHAR(100),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by INTEGER NOT NULL REFERENCES users(id),
    assigned_to INTEGER REFERENCES users(id)
);

-- Recreate foreign keys on proyectos if they were dropped by CASCADE
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'proyectos_licitacion_id_fkey'
    ) THEN
        IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'proyectos' AND column_name = 'licitacion_id'
        ) THEN
            ALTER TABLE proyectos ADD CONSTRAINT proyectos_licitacion_id_fkey
                FOREIGN KEY (licitacion_id) REFERENCES licitaciones(id);
        END IF;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'proyectos_oportunidad_id_fkey'
    ) THEN
        IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'proyectos' AND column_name = 'oportunidad_id'
        ) THEN
            ALTER TABLE proyectos ADD CONSTRAINT proyectos_oportunidad_id_fkey
                FOREIGN KEY (oportunidad_id) REFERENCES oportunidades(id);
        END IF;
    END IF;
END $$;

-- Recreate indexes
CREATE INDEX IF NOT EXISTS idx_licitaciones_estado ON licitaciones(estado_licitacion);
CREATE INDEX IF NOT EXISTS idx_oportunidades_estado ON oportunidades(estado_oportunidad);

COMMENT ON COLUMN licitaciones.estado_licitacion IS 'Estados: activa, presentada, ganada, perdida, sin_interes, cancelada';
COMMENT ON COLUMN oportunidades.estado_oportunidad IS 'Estados: prospecto, calificada, propuesta, negociacion, cerrada, perdida';
