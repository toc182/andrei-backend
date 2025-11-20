-- Migración: Agregar columna 'activo' a la tabla clientes
-- Fecha: 2025-11-20
-- Descripción: Agregar columna activo para permitir soft delete de clientes

-- Agregar columna activo (por defecto true para todos los clientes existentes)
ALTER TABLE clientes
ADD COLUMN IF NOT EXISTS activo BOOLEAN DEFAULT true NOT NULL;

-- Agregar índice para mejorar rendimiento de queries con filtro activo
CREATE INDEX IF NOT EXISTS idx_clientes_activo ON clientes(activo);

-- Comentario de la columna para documentación
COMMENT ON COLUMN clientes.activo IS 'Indica si el cliente está activo (true) o fue eliminado (soft delete, false)';
