-- Migracion: Crear tabla project_members
-- Fecha: 2025-12-10
-- Descripcion: Tabla para gestionar miembros/involucrados de cada proyecto

-- Crear tabla project_members
CREATE TABLE IF NOT EXISTS project_members (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    rol_proyecto VARCHAR(50) DEFAULT 'miembro',
    activo BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(project_id, user_id)
);

-- Indices
CREATE INDEX IF NOT EXISTS idx_project_members_project ON project_members(project_id);
CREATE INDEX IF NOT EXISTS idx_project_members_user ON project_members(user_id);

-- Comentarios
COMMENT ON TABLE project_members IS 'Miembros/involucrados de cada proyecto';
COMMENT ON COLUMN project_members.rol_proyecto IS 'Rol dentro del proyecto: gerente, ingeniero, admin, miembro, etc.';
