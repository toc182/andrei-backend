-- 144_create_cuenta_lineas.sql
-- Foto CONGELADA de las líneas de una cuenta: el "Cuadro de Presentación de
-- Cuenta" (tipo ETESA). Al crear la cuenta se copian aquí las filas del desglose
-- del que se arma; la cuenta queda inmutable aunque después se edite el desglose
-- (decisión de negocio: una cuenta entregada nunca cambia retroactivamente).
-- El árbol se guarda por parent_row_uid (no por id) para que la foto sea
-- autosuficiente y sobreviva a la reasignación de ids del desglose.
--
-- cantidad_ejecutada es el ÚNICO dato de entrada del avance (la cantidad de ESTE
-- periodo). El % NUNCA se guarda: se calcula (ejecutado ÷ presupuesto) a la
-- precisión que se pida (2 dec por defecto, ampliable a ≥10). El "ejecutado
-- hasta el periodo anterior" tampoco se guarda: se suma cantidad_ejecutada de
-- las cuentas previas del proyecto que compartan el mismo row_uid.
--
-- Los montos de un `grupo` contenedor (con hijos) se derivan de sus hijos y van
-- nulos, igual que en el desglose (ver hasChildren/rowTotal en desgloseModel.ts).
CREATE TABLE IF NOT EXISTS cuenta_lineas (
  id SERIAL PRIMARY KEY,
  cuenta_id INTEGER NOT NULL REFERENCES cuentas(id) ON DELETE CASCADE,
  row_uid UUID NOT NULL,                 -- identidad de fila; encadena entre cuentas
  parent_row_uid UUID,                   -- árbol por uid; NULL = raíz
  tipo VARCHAR(10) NOT NULL DEFAULT 'item' CHECK (tipo IN ('grupo', 'item')),
  item VARCHAR(60) NOT NULL DEFAULT '',
  descripcion TEXT NOT NULL DEFAULT '',
  unidad VARCHAR(30),
  cantidad_presupuesto NUMERIC(14,4),    -- del desglose al momento de la foto
  precio_unitario NUMERIC(14,4),
  cantidad_ejecutada NUMERIC(14,4) NOT NULL DEFAULT 0,  -- este periodo (único input)
  orden INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cuenta_lineas_cuenta ON cuenta_lineas (cuenta_id, orden);
CREATE INDEX IF NOT EXISTS idx_cuenta_lineas_row_uid ON cuenta_lineas (row_uid);
-- Una sola línea por (cuenta, fila).
CREATE UNIQUE INDEX IF NOT EXISTS uq_cuenta_lineas_cuenta_row
  ON cuenta_lineas (cuenta_id, row_uid);
