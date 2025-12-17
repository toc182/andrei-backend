-- Migration: 035_create_project_todos.sql
-- Description: Create tables for project todos and todo categories
-- Date: 2025-12-15

-- Table for todo categories (predefined per project)
CREATE TABLE IF NOT EXISTS project_todo_categories (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
    nombre VARCHAR(100) NOT NULL,
    color VARCHAR(20) DEFAULT '#6b7280',
    activo BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(project_id, nombre)
);

-- Table for todos
CREATE TABLE IF NOT EXISTS project_todos (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
    titulo VARCHAR(255) NOT NULL,
    descripcion TEXT,
    category_id INTEGER REFERENCES project_todo_categories(id) ON DELETE SET NULL,
    asignado_a INTEGER REFERENCES project_members(id) ON DELETE SET NULL,
    fecha_limite DATE,
    prioridad VARCHAR(20) DEFAULT 'media' CHECK (prioridad IN ('alta', 'media', 'baja')),
    estado VARCHAR(20) DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'completado')),
    completado_at TIMESTAMP,
    completado_por INTEGER REFERENCES users(id),
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_project_todos_project ON project_todos(project_id);
CREATE INDEX IF NOT EXISTS idx_project_todos_estado ON project_todos(estado);
CREATE INDEX IF NOT EXISTS idx_project_todos_asignado ON project_todos(asignado_a);
CREATE INDEX IF NOT EXISTS idx_project_todos_prioridad ON project_todos(prioridad);
CREATE INDEX IF NOT EXISTS idx_project_todo_categories_project ON project_todo_categories(project_id);
