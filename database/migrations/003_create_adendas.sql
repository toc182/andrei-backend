-- Migration: Create adendas table for project addendums
-- Created: 2025-08-29

-- Create adendas table
CREATE TABLE IF NOT EXISTS adendas (
    id SERIAL PRIMARY KEY,
    proyecto_id INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
    numero_adenda INTEGER NOT NULL,
    tipo VARCHAR(20) NOT NULL CHECK (tipo IN ('tiempo', 'costo', 'mixta')),
    estado VARCHAR(20) NOT NULL DEFAULT 'en_proceso' CHECK (estado IN ('en_proceso', 'aprobada', 'rechazada')),
    
    -- Cambios de tiempo
    nueva_fecha_fin DATE,
    dias_extension INTEGER,
    
    -- Cambios de costo  
    nuevo_monto DECIMAL(15,2),
    monto_adicional DECIMAL(15,2),
    
    -- Información adicional
    justificacion TEXT,
    fecha_solicitud DATE NOT NULL DEFAULT CURRENT_DATE,
    fecha_aprobacion DATE,
    observaciones TEXT,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    -- Constraints
    UNIQUE(proyecto_id, numero_adenda),
    
    -- Check constraints
    CONSTRAINT check_tiempo_fields CHECK (
        (tipo = 'tiempo' AND nueva_fecha_fin IS NOT NULL) OR
        (tipo = 'costo' AND (nuevo_monto IS NOT NULL OR monto_adicional IS NOT NULL)) OR
        (tipo = 'mixta' AND (nueva_fecha_fin IS NOT NULL OR nuevo_monto IS NOT NULL OR monto_adicional IS NOT NULL))
    )
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_adendas_proyecto_id ON adendas(proyecto_id);
CREATE INDEX IF NOT EXISTS idx_adendas_estado ON adendas(estado);
CREATE INDEX IF NOT EXISTS idx_adendas_tipo ON adendas(tipo);

-- Add trigger for updated_at
CREATE OR REPLACE FUNCTION update_adendas_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

DROP TRIGGER IF EXISTS trigger_adendas_updated_at ON adendas;
CREATE TRIGGER trigger_adendas_updated_at
    BEFORE UPDATE ON adendas
    FOR EACH ROW
    EXECUTE FUNCTION update_adendas_updated_at();

-- Insert sample data for testing (optional)
-- This will be commented out for production
/*
INSERT INTO adendas (proyecto_id, numero_adenda, tipo, estado, nueva_fecha_fin, dias_extension, justificacion) 
VALUES 
(1, 1, 'tiempo', 'aprobada', '2025-12-31', 90, 'Extensión debido a condiciones climáticas adversas'),
(1, 2, 'costo', 'en_proceso', NULL, NULL, 'Incremento por cambios en especificaciones técnicas');
*/