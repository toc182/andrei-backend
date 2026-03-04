-- 047_permissions_system.sql
-- Sistema de permisos individuales por usuario

-- 1. Agregar co-admin al constraint de rol
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_rol_check;
ALTER TABLE users ADD CONSTRAINT users_rol_check CHECK (rol IN ('admin', 'co-admin', 'usuario'));

-- 2. Tabla user_permissions
CREATE TABLE IF NOT EXISTS user_permissions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  acceso_global BOOLEAN DEFAULT false,
  proyectos_crear BOOLEAN DEFAULT false,
  proyectos_editar BOOLEAN DEFAULT false,
  proyectos_eliminar BOOLEAN DEFAULT false,
  clientes_agregar BOOLEAN DEFAULT false,
  clientes_editar BOOLEAN DEFAULT false,
  clientes_eliminar BOOLEAN DEFAULT false,
  solicitudes_editar_todas BOOLEAN DEFAULT false,
  requisiciones_editar_todas BOOLEAN DEFAULT false,
  equipos_ver BOOLEAN DEFAULT true,
  equipos_agregar BOOLEAN DEFAULT false,
  equipos_editar BOOLEAN DEFAULT false,
  equipos_eliminar BOOLEAN DEFAULT false,
  equipos_asignacion BOOLEAN DEFAULT false,
  equipos_uso BOOLEAN DEFAULT false,
  equipos_editar_asignacion BOOLEAN DEFAULT false,
  documentos_acceso BOOLEAN DEFAULT false,
  oportunidades_ver BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 3. Tabla user_project_access
CREATE TABLE IF NOT EXISTS user_project_access (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  proyecto_id INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, proyecto_id)
);

-- 4. Seed permisos para usuarios existentes
INSERT INTO user_permissions (user_id)
SELECT id FROM users WHERE rol = 'usuario'
ON CONFLICT (user_id) DO NOTHING;
