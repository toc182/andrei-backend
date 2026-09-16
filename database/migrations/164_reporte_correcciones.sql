-- 164_reporte_correcciones.sql
-- La sección «Correcciones» del reporte diario tiene su propia lista.
--
-- Hasta ahora se armaba con TODAS las filas de audit_log con accion 'editar',
-- y eso incluía cada foto subida al enviar: la pantalla sube una foto por
-- petición, así que el reporte RD-PBR-260915 salió con once líneas «Cambio
-- registrado» y una sola corrección de verdad. Lo que pidió el dueño del
-- producto, literal: «la sección de correcciones debe quedar en blanco, y
-- solamente se debe llenar cuando hay un cambio después de haber enviado el
-- reporte».
--
-- audit_log sigue anotándolo todo, como exige CLAUDE.md. Esta tabla es solo lo
-- que se le muestra a la gente, en pantalla y en el PDF. El precedente es
-- correcciones_solicitud (061), la de las solicitudes de pago.
--
-- Una fila es un «Guardar cambios» sobre un reporte ya enviado, con todo lo que
-- ese guardado movió: los campos y las fotos.
--
--   clave            la que manda la pantalla para ese guardado. Sus reintentos
--                    y las copias repetidas de la misma petición la traen igual,
--                    así que caen en la misma fila en vez de abrir otra. NULL
--                    cuando no la manda nadie.
--   cambios          campo -> { label, antes, despues }, lo de reporteCambios.ts.
--   fotos_agregadas  [{ id, nombre }]. Con el nombre, porque la fila de la foto
--   fotos_quitadas   se borra al quitarla y después no queda de dónde leerlo.
--   pdf_version      la versión archivada en proyecto_reporte_pdfs que ya trae
--                    lo que dice esta fila. NULL = falta archivarla.
--
-- Una fila sin ningún cambio no se muestra.
CREATE TABLE IF NOT EXISTS proyecto_reporte_correcciones (
  id SERIAL PRIMARY KEY,
  reporte_id INTEGER NOT NULL REFERENCES proyecto_reportes(id),
  clave VARCHAR(64),
  creado_por INTEGER NOT NULL REFERENCES users(id),
  cambios JSONB NOT NULL DEFAULT '{}'::jsonb,
  fotos_agregadas JSONB NOT NULL DEFAULT '[]'::jsonb,
  fotos_quitadas JSONB NOT NULL DEFAULT '[]'::jsonb,
  pdf_version INTEGER,
  -- Con zona horaria, como audit_log: la hora se muestra en la de Panamá y no
  -- puede depender de en qué zona corra el servidor o la base.
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Los NULL no chocan entre sí, así que las filas sin clave conviven. El
  -- índice empieza por reporte_id y sirve también para leer la lista.
  CONSTRAINT uq_proyecto_reporte_correcciones_clave UNIQUE (reporte_id, clave)
);
