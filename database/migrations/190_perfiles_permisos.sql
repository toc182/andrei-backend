-- 190_perfiles_permisos.sql
--
-- Perfiles de permisos: el juego de permisos de un puesto («Compras»,
-- «Ingeniero de campo»...), para asignarlo de una vez. Paso 1 de la
-- Administración nueva (Ivan, 2026-11-18): «el layout de cómo se ven y se
-- asignan los permisos no debería cambiar nada». Por eso un perfil NO es otra
-- fuente de permisos: el sistema sigue revisando las llaves de cada persona en
-- user_permissions, como siempre. Un perfil solo las llena (services/perfiles.ts):
-- asignarlo escribe sus llaves en la fila de la persona, y cambiarlo las reescribe
-- en todos los que lo tienen.
--
-- users.permission_profile_id NULL = «Personalizado» (las llaves de esa persona
-- no siguen a ningún perfil). Gerencia y el dueño no son perfiles: son los roles
-- co-admin y admin, que pasan todo, y nunca llevan perfil.
--
-- Tablas de sistema: nombres y llaves foráneas en inglés, como users y
-- user_permissions.

CREATE TABLE IF NOT EXISTS permission_profiles (
  id SERIAL PRIMARY KEY,
  nombre VARCHAR(80) NOT NULL,
  descripcion TEXT,
  -- Quitar un perfil es activo = false: sus personas pasan a «Personalizado»
  -- con las mismas llaves, y el perfil queda para la historia.
  activo BOOLEAN NOT NULL DEFAULT true,
  created_by INTEGER REFERENCES users(id),
  updated_by INTEGER REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Dos perfiles vivos con el mismo nombre no se distinguirían en la lista.
CREATE UNIQUE INDEX IF NOT EXISTS uq_permission_profiles_nombre
  ON permission_profiles (LOWER(nombre)) WHERE activo;

-- Una fila por llave que el perfil da. La lista de llaves que un perfil puede
-- llevar vive en services/perfiles.ts (LLAVES_DE_PERFIL); una llave que no está
-- aquí, el perfil no la da.
CREATE TABLE IF NOT EXISTS permission_profile_keys (
  profile_id INTEGER NOT NULL REFERENCES permission_profiles(id),
  permission_key VARCHAR(50) NOT NULL,
  PRIMARY KEY (profile_id, permission_key)
);

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS permission_profile_id INTEGER REFERENCES permission_profiles(id);

CREATE INDEX IF NOT EXISTS idx_users_permission_profile_id
  ON users (permission_profile_id) WHERE permission_profile_id IS NOT NULL;
