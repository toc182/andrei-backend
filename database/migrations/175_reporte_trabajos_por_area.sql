-- 175_reporte_trabajos_por_area.sql
--
-- «Trabajo ejecutado» deja de ser un solo texto y pasa a ser una lista de
-- puntos, cada uno con su area. Decision de Ivan del 2026-09-25: se escoge el
-- area y se escribe que se hizo en ella; varios puntos de la misma area salen
-- juntos debajo de su nombre.
--
-- Los reportes de antes se quedan como se enviaron: su que_se_hizo y su lista
-- de proyecto_reporte_areas no se tocan, y se siguen viendo e imprimiendo asi.
-- Un reporte nuevo trae puntos y que_se_hizo NULL; nunca las dos cosas.
-- proyecto_reporte_areas ya no se llena: las areas del dia son las que tienen
-- algun punto.

ALTER TABLE proyecto_reportes ALTER COLUMN que_se_hizo DROP NOT NULL;

-- area_id NULL es «General»: trabajo que no es de un area, como la limpieza
-- de toda la obra. No es una fila de proyecto_areas para que ninguna obra
-- cargue con un area de mentira en su lista.
CREATE TABLE IF NOT EXISTS proyecto_reporte_trabajos (
  id SERIAL PRIMARY KEY,
  reporte_id INTEGER NOT NULL REFERENCES proyecto_reportes(id) ON DELETE CASCADE,
  area_id INTEGER REFERENCES proyecto_areas(id),
  texto TEXT NOT NULL,
  orden INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_proyecto_reporte_trabajos_reporte_id
  ON proyecto_reporte_trabajos(reporte_id);
CREATE INDEX IF NOT EXISTS idx_proyecto_reporte_trabajos_area_id
  ON proyecto_reporte_trabajos(area_id);
