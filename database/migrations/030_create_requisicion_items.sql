-- Migracion: Crear tabla de items de requisicion
-- Fecha: 2025-12-09

-- Tabla de items/detalle de requisiciones
CREATE TABLE IF NOT EXISTS requisicion_items (
    id SERIAL PRIMARY KEY,
    requisicion_id INTEGER NOT NULL REFERENCES requisiciones(id) ON DELETE CASCADE,
    descripcion VARCHAR(500) NOT NULL,
    cantidad DECIMAL(12,2) NOT NULL DEFAULT 1,
    unidad VARCHAR(50) DEFAULT 'unidad',
    precio_unitario DECIMAL(12,2) NOT NULL,
    subtotal DECIMAL(12,2) NOT NULL,
    aplica_itbms BOOLEAN DEFAULT false,
    itbms DECIMAL(12,2) DEFAULT 0,
    total DECIMAL(12,2) NOT NULL,
    categoria_id INTEGER REFERENCES project_expense_categories(id),
    notas TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indices para busquedas
CREATE INDEX IF NOT EXISTS idx_req_items_requisicion ON requisicion_items(requisicion_id);
CREATE INDEX IF NOT EXISTS idx_req_items_descripcion ON requisicion_items(descripcion);
CREATE INDEX IF NOT EXISTS idx_req_items_categoria ON requisicion_items(categoria_id);

-- Agregar campos de totales a requisiciones (si no existen)
DO $$
BEGIN
    -- Renombrar monto a monto_total si existe
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'requisiciones' AND column_name = 'monto') THEN
        ALTER TABLE requisiciones RENAME COLUMN monto TO monto_total;
    END IF;

    -- Agregar subtotal si no existe
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'requisiciones' AND column_name = 'subtotal') THEN
        ALTER TABLE requisiciones ADD COLUMN subtotal DECIMAL(12,2) DEFAULT 0;
    END IF;

    -- Agregar itbms si no existe
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'requisiciones' AND column_name = 'itbms') THEN
        ALTER TABLE requisiciones ADD COLUMN itbms DECIMAL(12,2) DEFAULT 0;
    END IF;
END $$;

-- Comentarios
COMMENT ON TABLE requisicion_items IS 'Items/detalle de cada requisicion';
COMMENT ON COLUMN requisicion_items.aplica_itbms IS 'Si el item incluye ITBMS (7%)';
COMMENT ON COLUMN requisicion_items.itbms IS 'Monto de ITBMS calculado (subtotal * 0.07)';
