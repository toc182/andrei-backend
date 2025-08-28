-- Base tables migration - Clean start
-- This creates all core tables with consistent structure

-- Users table
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    nombre VARCHAR(100) NOT NULL,
    email VARCHAR(255) NOT NULL UNIQUE,
    password VARCHAR(255) NOT NULL,
    rol VARCHAR(50) DEFAULT 'operario',
    activo BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Clientes table (with abreviatura from start)
CREATE TABLE clientes (
    id SERIAL PRIMARY KEY,
    nombre VARCHAR(200) NOT NULL,
    abreviatura VARCHAR(25),
    contacto VARCHAR(100),
    telefono VARCHAR(20),
    email VARCHAR(255),
    direccion TEXT,
    activo BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Proyectos table (with all budget fields from start)
CREATE TABLE proyectos (
    id SERIAL PRIMARY KEY,
    nombre VARCHAR(500) NOT NULL,
    nombre_corto VARCHAR(255),
    cliente_id INTEGER REFERENCES clientes(id),
    fecha_inicio DATE,
    fecha_fin_estimada DATE,
    estado VARCHAR(50) DEFAULT 'planificacion',
    contratista VARCHAR(255),
    ingeniero_residente VARCHAR(255),
    codigo_proyecto VARCHAR(100),
    contrato VARCHAR(100),
    acto_publico VARCHAR(100),
    monto_contrato_original NUMERIC,
    presupuesto_base NUMERIC,
    itbms NUMERIC,
    monto_total NUMERIC,
    datos_adicionales JSONB DEFAULT '{}',
    tiene_presupuesto BOOLEAN DEFAULT false,
    moneda_proyecto VARCHAR(3) DEFAULT 'USD',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Expense categories
CREATE TABLE expense_categories (
    id SERIAL PRIMARY KEY,
    nombre VARCHAR(100) NOT NULL,
    descripcion TEXT,
    codigo VARCHAR(20),
    activo BOOLEAN DEFAULT true,
    color VARCHAR(7) DEFAULT '#007bff',
    orden INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Project expenses
CREATE TABLE project_expenses (
    id SERIAL PRIMARY KEY,
    proyecto_id INTEGER NOT NULL REFERENCES proyectos(id),
    category_id INTEGER NOT NULL REFERENCES expense_categories(id),
    fecha DATE DEFAULT CURRENT_DATE,
    concepto VARCHAR(255) NOT NULL,
    descripcion TEXT,
    monto NUMERIC NOT NULL,
    moneda VARCHAR(3) DEFAULT 'USD',
    tipo_gasto VARCHAR(20) DEFAULT 'real',
    proveedor VARCHAR(255),
    numero_factura VARCHAR(100),
    numero_orden_compra VARCHAR(100),
    centro_costo VARCHAR(50),
    aprobado BOOLEAN DEFAULT false,
    aprobado_por INTEGER REFERENCES users(id),
    aprobado_fecha TIMESTAMP,
    observaciones TEXT,
    archivo_adjunto VARCHAR(500),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by INTEGER NOT NULL REFERENCES users(id),
    updated_by INTEGER REFERENCES users(id)
);

-- Project budgets
CREATE TABLE project_budgets (
    id SERIAL PRIMARY KEY,
    proyecto_id INTEGER NOT NULL REFERENCES proyectos(id),
    monto_contrato_original NUMERIC NOT NULL,
    monto_contrato_actual NUMERIC DEFAULT 0,
    contingencia_porcentaje NUMERIC DEFAULT 10.00,
    contingencia_monto NUMERIC DEFAULT 0,
    presupuesto_aprobado NUMERIC DEFAULT 0,
    notas TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by INTEGER REFERENCES users(id),
    updated_by INTEGER REFERENCES users(id)
);

-- Budget categories
CREATE TABLE budget_categories (
    id SERIAL PRIMARY KEY,
    proyecto_id INTEGER NOT NULL REFERENCES proyectos(id),
    category_id INTEGER NOT NULL REFERENCES expense_categories(id),
    presupuesto_inicial NUMERIC NOT NULL DEFAULT 0,
    presupuesto_actual NUMERIC NOT NULL DEFAULT 0,
    notas TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Change orders
CREATE TABLE change_orders (
    id SERIAL PRIMARY KEY,
    proyecto_id INTEGER NOT NULL REFERENCES proyectos(id),
    numero_orden VARCHAR(50) NOT NULL,
    fecha DATE DEFAULT CURRENT_DATE,
    descripcion TEXT NOT NULL,
    monto_cambio NUMERIC NOT NULL,
    tipo_cambio VARCHAR(20) DEFAULT 'aumento',
    estado VARCHAR(20) DEFAULT 'pendiente',
    justificacion TEXT,
    aprobado_por INTEGER REFERENCES users(id),
    aprobado_fecha TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by INTEGER NOT NULL REFERENCES users(id)
);

-- Tramos proyecto
CREATE TABLE tramos_proyecto (
    id SERIAL PRIMARY KEY,
    proyecto_id INTEGER NOT NULL REFERENCES proyectos(id),
    nombre VARCHAR(100) NOT NULL,
    descripcion TEXT,
    longitud_total NUMERIC NOT NULL,
    tubos_requeridos INTEGER NOT NULL,
    longitud_por_tubo NUMERIC DEFAULT 5.8,
    activo BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Frentes trabajo
CREATE TABLE frentes_trabajo (
    id SERIAL PRIMARY KEY,
    proyecto_id INTEGER NOT NULL REFERENCES proyectos(id),
    tramo_id INTEGER NOT NULL REFERENCES tramos_proyecto(id),
    nombre VARCHAR(50) NOT NULL,
    descripcion TEXT,
    activo BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Reportes diarios
CREATE TABLE reportes_diarios (
    id SERIAL PRIMARY KEY,
    frente_id INTEGER NOT NULL REFERENCES frentes_trabajo(id),
    fecha DATE NOT NULL,
    tubos_instalados INTEGER DEFAULT 0,
    metros_instalados NUMERIC,
    observaciones TEXT,
    reportado_por VARCHAR(100),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Metas proyecto
CREATE TABLE metas_proyecto (
    id SERIAL PRIMARY KEY,
    proyecto_id INTEGER NOT NULL REFERENCES proyectos(id),
    descripcion VARCHAR(100) NOT NULL,
    porcentaje_meta INTEGER NOT NULL,
    fecha_meta DATE NOT NULL,
    tubos_meta INTEGER,
    metros_meta NUMERIC,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Materiales
CREATE TABLE materiales (
    id SERIAL PRIMARY KEY,
    nombre VARCHAR(255) NOT NULL,
    unidad VARCHAR(50) NOT NULL,
    precio_unitario NUMERIC,
    stock_actual INTEGER DEFAULT 0,
    stock_minimo INTEGER DEFAULT 0,
    activo BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Proyecto usuarios (many-to-many)
CREATE TABLE proyecto_usuarios (
    id SERIAL PRIMARY KEY,
    proyecto_id INTEGER REFERENCES proyectos(id),
    user_id INTEGER REFERENCES users(id),
    rol_proyecto VARCHAR(50) DEFAULT 'operario',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Insert default admin user
INSERT INTO users (nombre, email, password, rol) VALUES 
('Ivan Admin', 'admin@andrei.com', '$2a$10$mbMLuQcLnvbumzR4N4OFW.H11iQ6dWtKRVRv7xCUqbF8YEouDYDU6', 'admin');

-- Insert default expense categories
INSERT INTO expense_categories (nombre, descripcion, codigo, color, orden) VALUES
('Materiales', 'Gastos en materiales de construcción', 'MAT', '#e74c3c', 1),
('Mano de Obra', 'Gastos en personal y subcontratistas', 'MO', '#3498db', 2),
('Equipos', 'Alquiler y compra de equipos', 'EQ', '#f39c12', 3),
('Transporte', 'Gastos de transporte y logística', 'TR', '#9b59b6', 4),
('Servicios', 'Servicios profesionales y consultorías', 'SRV', '#2ecc71', 5),
('Administrativos', 'Gastos administrativos y oficina', 'ADM', '#95a5a6', 6),
('Permisos', 'Permisos y licencias gubernamentales', 'PER', '#e67e22', 7),
('Otros', 'Otros gastos no categorizados', 'OTR', '#34495e', 8);