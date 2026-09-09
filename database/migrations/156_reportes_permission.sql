-- 156_reportes_permission.sql
-- Permiso individual que gobierna la sección de Reportes diarios de obra.
-- Sigue el mismo patrón que desglose_ver: una sola llave da ver + crear +
-- editar en v1, y las rutas ADEMÁS pasan checkProjectAccess, porque los
-- reportes viven dentro de un proyecto. La misma llave gobierna el
-- mantenimiento de la lista de áreas del proyecto.
ALTER TABLE user_permissions ADD COLUMN IF NOT EXISTS reportes BOOLEAN DEFAULT FALSE;
