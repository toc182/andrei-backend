-- 176_proyecto_equipos_empresa.sql
--
-- Cada maquina del reporte diario dice de quien es, igual que cada puesto de
-- Personal. Decision de Ivan del 2026-09-28: el dueno se fija una vez en la
-- lista del proyecto, no se escoge cada dia; por defecto la maquina es del
-- bloque propio (Pinellas, o el consorcio) y las empresas son las mismas de
-- Personal (proyecto_empresas).
--
-- empresa_id NULL es el bloque propio, como en proyecto_puestos. Las maquinas
-- que ya existian quedan todas en el bloque propio, asi que ningun reporte
-- viejo cambia.

ALTER TABLE proyecto_equipos
  ADD COLUMN IF NOT EXISTS empresa_id INTEGER REFERENCES proyecto_empresas(id) ON DELETE CASCADE;

-- Cada bloque es dueno de sus maquinas: el consorcio y un subcontratista
-- pueden tener cada uno su «Retroexcavadora». COALESCE porque un unico con
-- NULL no compara.
DROP INDEX IF EXISTS uq_proyecto_equipos_nombre;
CREATE UNIQUE INDEX IF NOT EXISTS uq_proyecto_equipos_empresa_nombre
  ON proyecto_equipos(proyecto_id, COALESCE(empresa_id, 0), lower(nombre))
  WHERE activo;
