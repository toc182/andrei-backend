-- Migración: Crear tabla de requisiciones
-- Fecha: 2025-12-06

-- Tabla principal de requisiciones
CREATE TABLE IF NOT EXISTS requisiciones (
    id SERIAL PRIMARY KEY,
    numero VARCHAR(50) NOT NULL,
    fecha DATE NOT NULL DEFAULT CURRENT_DATE,
    project_id INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
    proveedor VARCHAR(255) NOT NULL,
    monto DECIMAL(12,2) NOT NULL,
    concepto TEXT,
    categoria_id INTEGER REFERENCES project_expense_categories(id),
    estado VARCHAR(50) NOT NULL DEFAULT 'pendiente',
    pdf_url TEXT,
    pdf_nombre VARCHAR(255),

    -- Campos de auditoría
    solicitado_por INTEGER REFERENCES users(id),
    aprobado_por INTEGER REFERENCES users(id),
    fecha_aprobacion TIMESTAMP,
    pagado_por INTEGER REFERENCES users(id),
    fecha_pago TIMESTAMP,

    -- Referencia al gasto creado (cuando se paga)
    expense_id INTEGER REFERENCES project_expenses(id),

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT estado_valido CHECK (estado IN ('pendiente', 'en_cotizacion', 'por_aprobar', 'aprobada', 'pagada', 'rechazada'))
);

-- Índices para búsquedas frecuentes
CREATE INDEX IF NOT EXISTS idx_requisiciones_project ON requisiciones(project_id);
CREATE INDEX IF NOT EXISTS idx_requisiciones_estado ON requisiciones(estado);
CREATE INDEX IF NOT EXISTS idx_requisiciones_fecha ON requisiciones(fecha);
CREATE INDEX IF NOT EXISTS idx_requisiciones_numero ON requisiciones(numero);

-- Tabla de historial de cambios de estado (para trazabilidad)
CREATE TABLE IF NOT EXISTS requisiciones_historial (
    id SERIAL PRIMARY KEY,
    requisicion_id INTEGER NOT NULL REFERENCES requisiciones(id) ON DELETE CASCADE,
    estado_anterior VARCHAR(50),
    estado_nuevo VARCHAR(50) NOT NULL,
    usuario_id INTEGER REFERENCES users(id),
    comentario TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_req_historial_requisicion ON requisiciones_historial(requisicion_id);

-- Comentario
COMMENT ON TABLE requisiciones IS 'Tabla principal de requisiciones de compra/servicio';
COMMENT ON TABLE requisiciones_historial IS 'Historial de cambios de estado de requisiciones';
