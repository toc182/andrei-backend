-- Migración 041: Simplificar roles de usuario a solo 'admin' y 'usuario'

-- Paso 1: Convertir todos los roles existentes que no sean 'admin' a 'usuario'
UPDATE users SET rol = 'usuario' WHERE rol NOT IN ('admin', 'usuario') OR rol IS NULL;

-- Paso 2: Cambiar el default de la columna
ALTER TABLE users ALTER COLUMN rol SET DEFAULT 'usuario';

-- Paso 3: Agregar constraint CHECK para solo permitir 'admin' y 'usuario'
ALTER TABLE users ADD CONSTRAINT users_rol_check CHECK (rol IN ('admin', 'usuario'));
