-- 159_permisos_secciones.sql
-- Cuatro secciones que hasta ahora se le mostraban a cualquiera con cuenta:
-- Solicitudes de Pago, Requisiciones, Clientes y Control de Costos. No habia
-- forma de apagarlas para un usuario, y un ingeniero de campo no tiene por que
-- ver los montos ni los proveedores de un proyecto.
ALTER TABLE user_permissions ADD COLUMN IF NOT EXISTS solicitudes_ver BOOLEAN DEFAULT FALSE;
ALTER TABLE user_permissions ADD COLUMN IF NOT EXISTS requisiciones_ver BOOLEAN DEFAULT FALSE;
ALTER TABLE user_permissions ADD COLUMN IF NOT EXISTS clientes_ver BOOLEAN DEFAULT FALSE;
ALTER TABLE user_permissions ADD COLUMN IF NOT EXISTS costos_ver BOOLEAN DEFAULT FALSE;

-- Encendidas para todos los que YA existen. Si nacieran apagadas, todo el que
-- hoy trabaja con solicitudes o requisiciones perderia su seccion de un dia
-- para otro, y eso no es lo que se esta arreglando. Los usuarios que se creen
-- de aqui en adelante nacen sin ellas, que es la regla del resto del sistema.
UPDATE user_permissions
   SET solicitudes_ver = TRUE,
       requisiciones_ver = TRUE,
       clientes_ver = TRUE,
       costos_ver = TRUE
 WHERE solicitudes_ver IS NOT TRUE
    OR requisiciones_ver IS NOT TRUE
    OR clientes_ver IS NOT TRUE
    OR costos_ver IS NOT TRUE;
