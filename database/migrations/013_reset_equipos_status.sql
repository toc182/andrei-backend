-- Migración 013: Reset completo de status de equipos
-- Fecha: 2025-10-01

-- 1. Limpiar todos los campos de status y resetear a estado por defecto
UPDATE equipos
SET
    estado = 'standby',
    proyecto = NULL,
    responsable = NULL,
    rata_mes = NULL,
    observaciones_status = NULL,
    updated_at = CURRENT_TIMESTAMP
WHERE activo = true;

-- 2. Crear trigger para auto-agregar nuevos equipos con status por defecto
CREATE OR REPLACE FUNCTION set_default_equipment_status()
RETURNS TRIGGER AS $$
BEGIN
    -- Si es un INSERT y no se especificó estado, poner standby por defecto
    IF TG_OP = 'INSERT' AND (NEW.estado IS NULL OR NEW.estado = '') THEN
        NEW.estado = 'standby';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 3. Crear trigger que se ejecuta antes de INSERT
DROP TRIGGER IF EXISTS trigger_set_default_status ON equipos;
CREATE TRIGGER trigger_set_default_status
    BEFORE INSERT ON equipos
    FOR EACH ROW
    EXECUTE FUNCTION set_default_equipment_status();