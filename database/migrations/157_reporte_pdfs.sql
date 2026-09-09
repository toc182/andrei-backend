-- 157_reporte_pdfs.sql
-- Copia congelada de cada PDF de reporte que salió por correo.
--
-- Ver un reporte en pantalla lo vuelve a generar al vuelo, igual que hacen las
-- solicitudes de pago. Esto es otra cosa: el PDF del reporte SALE de la
-- empresa por correo, así que si el ingeniero lo corrige al día siguiente, la
-- copia que ya está en la bandeja de alguien y la que se generaría hoy dicen
-- cosas distintas. Sin una copia archivada no queda constancia de qué fue lo
-- que se envió.
--
-- Mismo patrón que las solicitudes, que archivan <numero>.pdf al pagarse y
-- <numero>-v2.pdf, -v3.pdf por cada corrección.
CREATE TABLE IF NOT EXISTS proyecto_reporte_pdfs (
  id SERIAL PRIMARY KEY,
  reporte_id INTEGER NOT NULL REFERENCES proyecto_reportes(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  r2_key VARCHAR(500) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_proyecto_reporte_pdfs_version UNIQUE (reporte_id, version)
);

CREATE INDEX IF NOT EXISTS idx_proyecto_reporte_pdfs_reporte_id
  ON proyecto_reporte_pdfs(reporte_id);
