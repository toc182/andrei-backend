-- 172_reporte_semanal_correcciones.sql
-- La sección «Correcciones» del reporte semanal.
--
-- Mismo trato que la 164 para el diario: audit_log sigue anotándolo todo, como
-- exige CLAUDE.md, y esta tabla es solo lo que se le muestra a la gente, en
-- pantalla y en el PDF. Una fila es un guardado sobre un reporte YA ENVIADO,
-- con lo que ese guardado movió.
--
--   cambios      lo que cambió, ya legible: [{ etiqueta, renglones }], que es
--                lo que dibujan la pantalla y el papel (reporteSemanalCambios.ts).
--                Se guarda ya armado y no en crudo porque el reporte semanal
--                compara listas enteras —metas, problemas, decisiones— y
--                rearmarlas después obligaría a guardar dos veces lo mismo.
--   pdf_version  la versión archivada en proyecto_reporte_semanal_pdfs que ya
--                dice lo que dice esta fila. NULL = falta archivarla.
--
-- Una fila sin ningún cambio no se guarda: un guardado que no movió nada no es
-- una corrección.
CREATE TABLE IF NOT EXISTS proyecto_reporte_semanal_correcciones (
  id SERIAL PRIMARY KEY,
  reporte_id INTEGER NOT NULL REFERENCES proyecto_reportes_semanales(id),
  creado_por INTEGER NOT NULL REFERENCES users(id),
  cambios JSONB NOT NULL DEFAULT '[]'::jsonb,
  pdf_version INTEGER,
  -- Con zona horaria, como audit_log: la hora se muestra en la de Panamá y no
  -- puede depender de en qué zona corra el servidor o la base.
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_semanal_correcciones_reporte
  ON proyecto_reporte_semanal_correcciones(reporte_id, created_at);
