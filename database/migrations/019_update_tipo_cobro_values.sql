-- Migración 019: Actualizar valores de tipo_cobro
-- Fecha: 2025-10-08
-- Cambiar 'no_aplica' por 'costo_fijo'

-- Actualizar registros existentes que tengan 'no_aplica'
UPDATE asignaciones_equipos
SET tipo_cobro = 'costo_fijo'
WHERE tipo_cobro = 'no_aplica';

-- Eliminar el constraint anterior
ALTER TABLE asignaciones_equipos
DROP CONSTRAINT IF EXISTS asignaciones_equipos_tipo_cobro_check;

-- Crear nuevo constraint con 'costo_fijo' en lugar de 'no_aplica'
ALTER TABLE asignaciones_equipos
ADD CONSTRAINT asignaciones_equipos_tipo_cobro_check
CHECK (tipo_cobro IN ('hora', 'dia', 'semana', 'mes', 'costo_fijo'));

-- Comentario
COMMENT ON COLUMN asignaciones_equipos.tipo_cobro IS 'Tipo de cobro: hora, dia, semana, mes, costo_fijo';
