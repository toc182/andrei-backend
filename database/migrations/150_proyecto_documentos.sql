-- 150_proyecto_documentos.sql
--
-- Los archivos del proyecto: el contrato, la orden de proceder y todo lo que
-- hasta ahora vivia fuera del sistema. Se guardan en R2 igual que el resto de
-- adjuntos; aqui solo queda la ficha (nombre, clave en R2, quien lo subio).
--
-- Misma forma que solicitud_pago_adjuntos (045), que es la plantilla que ya
-- copiaron cuentas (069), cajas menudas (062) y cotizaciones (134). Tabla
-- propia con FK a un solo padre, no una tabla polimorfica: el unico caso
-- polimorfico del esquema es audit_log y es deliberado.
--
-- Sin columna de tipo/categoria a proposito: es una lista simple. Marcar cual
-- es el contrato y cual la orden de proceder es otra decision y otra migracion.
--
-- ON DELETE CASCADE borra las filas cuando se borra el proyecto, pero NO los
-- objetos en R2 -- por eso la ruta de borrar proyecto ahora recoge las claves
-- y las borra de R2 antes de tocar la fila (mismo patron que solicitudesPago).
CREATE TABLE IF NOT EXISTS proyecto_documentos (
  id SERIAL PRIMARY KEY,
  proyecto_id INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
  nombre_original VARCHAR(500) NOT NULL,
  r2_key VARCHAR(1000) NOT NULL,
  tipo_mime VARCHAR(100) NOT NULL,
  tamano INTEGER NOT NULL,
  subido_por INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_proyecto_documentos_proyecto
  ON proyecto_documentos(proyecto_id);
