-- 153_presupuestos_varios.sql
-- Un proyecto tiene VARIOS presupuestos, independientes entre si: uno antes de
-- la licitacion, otro despues de adjudicado, otro con los disenos listos. No
-- son versiones encadenadas. Uno se marca con estrella y es contra el que
-- compara el control de costos.
--
-- Ademas, la primera manera de armar un presupuesto: a partir del desglose
-- OFICIAL del proyecto. Las filas del desglose se COPIAN el dia que se arma
-- (precio incluido) y no se vuelven a mirar: si el desglose cambia despues, el
-- presupuesto no se mueve.

-- Ya no hay un solo presupuesto activo por proyecto.
DROP INDEX IF EXISTS uq_presupuestos_proyecto;

ALTER TABLE presupuestos ADD COLUMN IF NOT EXISTS origen VARCHAR(12) NOT NULL DEFAULT 'desglose';
ALTER TABLE presupuestos ADD COLUMN IF NOT EXISTS desglose_id INTEGER REFERENCES desgloses(id);
ALTER TABLE presupuestos ADD COLUMN IF NOT EXISTS es_principal BOOLEAN NOT NULL DEFAULT FALSE;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'presupuestos_origen_chk') THEN
    ALTER TABLE presupuestos
      ADD CONSTRAINT presupuestos_origen_chk CHECK (origen IN ('desglose', 'cero'));
  END IF;
END $$;

-- La estrella: como mucho un principal por proyecto entre los vivos.
CREATE UNIQUE INDEX IF NOT EXISTS uq_presupuestos_principal
  ON presupuestos(proyecto_id) WHERE es_principal AND activo;

CREATE INDEX IF NOT EXISTS idx_presupuestos_proyecto
  ON presupuestos(proyecto_id) WHERE activo;

-- Costo y precio son dos cosas distintas y van en columnas distintas:
--   costo_unitario   -> lo que la obra CUESTA. Es lo unico que escribe el
--                       usuario en esta manera de armar el presupuesto.
--   precio_unitario  -> lo que se COBRA. Copiado del desglose el dia que se
--                       armo; aqui no se edita.
ALTER TABLE presupuesto_renglones ADD COLUMN IF NOT EXISTS costo_unitario NUMERIC(14,4);

-- De cual fila del desglose salio este renglon. Sirve para, mas adelante,
-- avisar cuando el desglose cambio despues de armado el presupuesto.
ALTER TABLE presupuesto_renglones ADD COLUMN IF NOT EXISTS desglose_row_uid UUID;
