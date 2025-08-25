-- Migración: Actualizar campos de presupuesto en proyectos
-- Fecha: 2025-01-24
-- Descripción: Separar el campo presupuesto en: presupuesto_base, itbms, y monto_total

-- Agregar nuevos campos de forma segura
DO $$
BEGIN
    -- Add presupuesto_base column if it doesn't exist
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='proyectos' AND column_name='presupuesto_base') THEN
        ALTER TABLE proyectos ADD COLUMN presupuesto_base DECIMAL(15,2);
    END IF;
    
    -- Add itbms column if it doesn't exist
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='proyectos' AND column_name='itbms') THEN
        ALTER TABLE proyectos ADD COLUMN itbms DECIMAL(15,2);
    END IF;
    
    -- Add monto_total column if it doesn't exist
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='proyectos' AND column_name='monto_total') THEN
        ALTER TABLE proyectos ADD COLUMN monto_total DECIMAL(15,2);
    END IF;
END
$$;

-- Migrar datos existentes del campo monto_contrato_original al presupuesto_base
UPDATE proyectos 
SET presupuesto_base = monto_contrato_original,
    itbms = 0.00,
    monto_total = monto_contrato_original
WHERE monto_contrato_original IS NOT NULL;

-- El campo monto_contrato_original se mantiene por compatibilidad pero será deprecado
-- gradualmente. Por ahora, mantenemos ambos campos.

COMMENT ON COLUMN proyectos.presupuesto_base IS 'Presupuesto base del proyecto (sin ITBMS)';
COMMENT ON COLUMN proyectos.itbms IS 'ITBMS aplicado al proyecto (7%)';
COMMENT ON COLUMN proyectos.monto_total IS 'Monto total del proyecto (presupuesto_base + itbms)';