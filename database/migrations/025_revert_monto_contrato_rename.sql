-- Migration 025: Revert monto_contrato back to monto_contrato_original
-- Date: 2025-12-03
-- Description: Revert the column name change from migration 024

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'proyectos'
        AND column_name = 'monto_contrato'
    ) THEN
        ALTER TABLE proyectos RENAME COLUMN monto_contrato TO monto_contrato_original;
        RAISE NOTICE 'Renamed proyectos.monto_contrato back to monto_contrato_original';
    ELSE
        RAISE NOTICE 'Column monto_contrato_original already exists, skipping rename';
    END IF;
END $$;
