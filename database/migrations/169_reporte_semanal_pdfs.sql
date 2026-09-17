-- 169_reporte_semanal_pdfs.sql
-- Copia congelada de cada PDF de reporte semanal que salió por correo.
--
-- Mismo motivo que la 157 para los diarios: el PDF SALE de la empresa, así que
-- si el reporte se corrige después, la copia que ya está en la bandeja de
-- alguien y la que se generaría hoy dicen cosas distintas. Sin una copia
-- archivada no queda constancia de qué fue lo que se envió.
--
-- La versión 1 se archiva como <numero>.pdf; cada corrección deja -v2, -v3…
CREATE TABLE IF NOT EXISTS proyecto_reporte_semanal_pdfs (
  id SERIAL PRIMARY KEY,
  reporte_id INTEGER NOT NULL REFERENCES proyecto_reportes_semanales(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  r2_key VARCHAR(500) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_proyecto_reporte_semanal_pdfs_version UNIQUE (reporte_id, version)
);

CREATE INDEX IF NOT EXISTS idx_proyecto_reporte_semanal_pdfs_reporte
  ON proyecto_reporte_semanal_pdfs(reporte_id);
