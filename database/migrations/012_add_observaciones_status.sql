-- Migración 012: Agregar campo observaciones_status a tabla equipos
-- Fecha: 2025-10-01

-- Agregar campo para observaciones específicas de status operativo
ALTER TABLE equipos ADD COLUMN observaciones_status TEXT;

-- Crear índice para búsquedas eficientes
CREATE INDEX idx_equipos_observaciones_status ON equipos(observaciones_status);