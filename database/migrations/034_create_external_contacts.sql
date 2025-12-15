-- Migration 034: Create external_contacts table and modify project_members
-- Fecha: 2025-12-13
-- Descripcion: Sistema de contactos externos (personas sin cuenta) y soporte en project_members

-- =====================================================
-- FASE 1.1: Crear tabla external_contacts
-- =====================================================
-- Personas que no tienen cuenta en el sistema pero pueden ser asignadas a proyectos
-- Ejemplo: trabajadores de campo sin acceso a internet

CREATE TABLE IF NOT EXISTS external_contacts (
    id SERIAL PRIMARY KEY,
    nombre VARCHAR(100) NOT NULL,
    cargo VARCHAR(100),
    telefono VARCHAR(50),
    email VARCHAR(100),
    notas TEXT,
    activo BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by INTEGER REFERENCES users(id)
);

-- Indices para busquedas
CREATE INDEX IF NOT EXISTS idx_external_contacts_nombre ON external_contacts(nombre);
CREATE INDEX IF NOT EXISTS idx_external_contacts_activo ON external_contacts(activo);

-- Comentarios
COMMENT ON TABLE external_contacts IS 'Contactos externos sin cuenta en el sistema, asignables a proyectos';
COMMENT ON COLUMN external_contacts.nombre IS 'Nombre completo del contacto';
COMMENT ON COLUMN external_contacts.cargo IS 'Cargo o posicion del contacto';
COMMENT ON COLUMN external_contacts.telefono IS 'Numero de telefono';
COMMENT ON COLUMN external_contacts.email IS 'Email opcional (no es usuario del sistema)';
COMMENT ON COLUMN external_contacts.notas IS 'Notas adicionales sobre el contacto';

-- =====================================================
-- FASE 1.2: Modificar project_members para soportar externos
-- =====================================================

-- Agregar campo tipo_miembro para distinguir usuarios del sistema vs externos
ALTER TABLE project_members
ADD COLUMN IF NOT EXISTS tipo_miembro VARCHAR(20) DEFAULT 'usuario';

-- Agregar referencia a external_contacts (nullable)
ALTER TABLE project_members
ADD COLUMN IF NOT EXISTS external_contact_id INTEGER REFERENCES external_contacts(id) ON DELETE CASCADE;

-- Hacer user_id nullable (porque externos no tienen user_id)
ALTER TABLE project_members
ALTER COLUMN user_id DROP NOT NULL;

-- Indice para external_contact_id
CREATE INDEX IF NOT EXISTS idx_project_members_external ON project_members(external_contact_id);

-- Actualizar constraint UNIQUE para permitir externos
-- Primero eliminamos el constraint existente
ALTER TABLE project_members DROP CONSTRAINT IF EXISTS project_members_project_id_user_id_key;

-- Crear nuevos constraints para evitar duplicados
-- Un usuario del sistema solo puede estar una vez por proyecto
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_user_per_project
ON project_members(project_id, user_id)
WHERE user_id IS NOT NULL AND tipo_miembro = 'usuario';

-- Un contacto externo solo puede estar una vez por proyecto
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_external_per_project
ON project_members(project_id, external_contact_id)
WHERE external_contact_id IS NOT NULL AND tipo_miembro = 'externo';

-- Comentarios actualizados
COMMENT ON COLUMN project_members.tipo_miembro IS 'Tipo de miembro: usuario (del sistema) o externo (sin cuenta)';
COMMENT ON COLUMN project_members.external_contact_id IS 'Referencia a external_contacts si tipo_miembro = externo';

-- Actualizar registros existentes para marcarlos como tipo usuario
UPDATE project_members SET tipo_miembro = 'usuario' WHERE tipo_miembro IS NULL;
