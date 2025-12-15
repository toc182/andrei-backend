-- Migracion: Agregar campo solicitante a requisiciones
-- Fecha: 2025-12-09

-- Agregar columna solicitante_id a requisiciones
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'requisiciones' AND column_name = 'solicitante_id') THEN
        ALTER TABLE requisiciones ADD COLUMN solicitante_id INTEGER REFERENCES users(id);
    END IF;
END $$;

-- Indice para busquedas por solicitante
CREATE INDEX IF NOT EXISTS idx_requisiciones_solicitante ON requisiciones(solicitante_id);

-- Comentario
COMMENT ON COLUMN requisiciones.solicitante_id IS 'Usuario que solicita/crea la requisicion';
