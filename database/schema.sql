-- Tabla de usuarios
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  nombre VARCHAR(100) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password VARCHAR(255) NOT NULL,
  rol VARCHAR(50) DEFAULT 'operario' CHECK (rol IN ('admin', 'project_manager', 'supervisor', 'operario')),
activo BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Tabla de clientes
CREATE TABLE clientes (
  id SERIAL PRIMARY KEY,
  nombre VARCHAR(200) NOT NULL,
  contacto VARCHAR(100),
  telefono VARCHAR(20),
  email VARCHAR(255),
  direccion TEXT,
  activo BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Tabla de proyectos
CREATE TABLE proyectos (
  id SERIAL PRIMARY KEY,
  nombre VARCHAR(255) NOT NULL,
  descripcion TEXT,
  cliente_id INTEGER REFERENCES clientes(id),
  ubicacion TEXT,
  fecha_inicio DATE,
  fecha_fin_estimada DATE,
  fecha_fin_real DATE,
  presupuesto_inicial DECIMAL(15,2),
  presupuesto_actual DECIMAL(15,2),
  estado VARCHAR(50) DEFAULT 'planificacion' CHECK (estado IN ('planificacion', 'en_curso', 'pausado', 'completado', 'cancelado')),
manager_id INTEGER REFERENCES users(id),
  activo BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Tabla de materiales básica
CREATE TABLE materiales (
  id SERIAL PRIMARY KEY,
  nombre VARCHAR(255) NOT NULL,
  unidad VARCHAR(50) NOT NULL, -- m3, kg, unidad, etc.
  precio_unitario DECIMAL(10,2),
  stock_actual INTEGER DEFAULT 0,
  stock_minimo INTEGER DEFAULT 0,
  activo BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Tabla para asignar usuarios a proyectos
CREATE TABLE proyecto_usuarios (
  id SERIAL PRIMARY KEY,
  proyecto_id INTEGER REFERENCES proyectos(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  rol_proyecto VARCHAR(50) DEFAULT 'operario',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(proyecto_id, user_id)
);

-- Índices para mejorar rendimiento
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_proyectos_estado ON proyectos(estado);
CREATE INDEX idx_proyectos_manager ON proyectos(manager_id);
CREATE INDEX idx_proyecto_usuarios_proyecto ON proyecto_usuarios(proyecto_id);
CREATE INDEX idx_proyecto_usuarios_user ON proyecto_usuarios(user_id);

-- Insertar usuario admin por defecto (password: admin123)
INSERT INTO users (nombre, email, password, rol) VALUES
('Ivan - Administrador', 'ivan@pinellaspanama.com', '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', 'admin');