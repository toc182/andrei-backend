-- Migration: Add tipo column to clientes table
-- Date: 2025-01-20
-- Description: Add tipo column with values 'estado' or 'privado'

-- Add tipo column if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'clientes' AND column_name = 'tipo'
    ) THEN
        ALTER TABLE clientes
        ADD COLUMN tipo VARCHAR(10) DEFAULT 'privado' CHECK (tipo IN ('estado', 'privado'));

        RAISE NOTICE 'Column tipo added to clientes table';
    ELSE
        RAISE NOTICE 'Column tipo already exists in clientes table';
    END IF;
END $$;
