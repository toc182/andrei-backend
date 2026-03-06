-- 053: Soporte para usuarios externos (referencia sin login)
-- tipo_usuario: 'interno' = usuario normal, 'externo' = solo referencia

-- Idempotente: solo agrega si no existe
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'tipo_usuario') THEN
    ALTER TABLE users ADD COLUMN tipo_usuario VARCHAR(20) DEFAULT 'interno' CHECK (tipo_usuario IN ('interno', 'externo'));
  END IF;
END $$;

-- Permitir email y password NULL para usuarios externos
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE users ALTER COLUMN password DROP NOT NULL;

-- Reemplazar unique constraint por unique parcial (solo emails no-null)
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_email_key;
DROP INDEX IF EXISTS users_email_unique;
CREATE UNIQUE INDEX users_email_unique ON users(email) WHERE email IS NOT NULL;
