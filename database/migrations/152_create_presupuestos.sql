-- 152_create_presupuestos.sql
-- Hoja de Presupuesto: lo que se calcula que va a COSTAR el proyecto y el
-- precio que se le manda al cliente. Es otra cosa que `desgloses`, que es el
-- cuadro de precios del contrato; no quedan atados entre si.
--
-- Documento de guardado wholesale, igual que desgloses: el PUT borra y vuelve
-- a insertar todos los renglones en una transaccion y sella updated_at para el
-- control de concurrencia. Los totales NUNCA se guardan: se derivan al leer.
CREATE TABLE IF NOT EXISTS presupuestos (
  id SERIAL PRIMARY KEY,
  proyecto_id INTEGER NOT NULL REFERENCES proyectos(id),
  nombre VARCHAR(200) NOT NULL DEFAULT 'Presupuesto',
  -- Factor unico de toda la hoja: multiplica TODOS los renglones (items y
  -- Costos Generales) para que la suma de los renglones cuadre con el precio.
  factor NUMERIC(10,6) NOT NULL DEFAULT 1,
  itbms_tasa NUMERIC(6,3),
  activo BOOLEAN NOT NULL DEFAULT TRUE,
  creado_por INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Un solo presupuesto activo por proyecto. Es indice parcial, no constraint,
-- porque el borrado es suave (activo = FALSE) y los inactivos no compiten.
CREATE UNIQUE INDEX IF NOT EXISTS uq_presupuestos_proyecto
  ON presupuestos(proyecto_id) WHERE activo = TRUE;

CREATE TABLE IF NOT EXISTS presupuesto_renglones (
  id SERIAL PRIMARY KEY,
  presupuesto_id INTEGER NOT NULL REFERENCES presupuestos(id) ON DELETE CASCADE,
  parent_id INTEGER REFERENCES presupuesto_renglones(id) ON DELETE CASCADE,
  -- 'items' = el desglose de partidas; 'generales' = Costos Generales
  -- (supervision, campamento, seguros, la cuadrilla cuando no va por item).
  seccion VARCHAR(12) NOT NULL DEFAULT 'items' CHECK (seccion IN ('items', 'generales')),
  tipo VARCHAR(10) NOT NULL DEFAULT 'item' CHECK (tipo IN ('grupo', 'item')),
  codigo VARCHAR(60) NOT NULL DEFAULT '',
  descripcion TEXT NOT NULL DEFAULT '',
  unidad VARCHAR(30),
  cantidad NUMERIC(14,4),
  -- Cuando usa_calculo = FALSE el precio unitario se escribe a mano; cuando es
  -- TRUE sale del calculo de abajo y esta columna queda en NULL.
  precio_unitario NUMERIC(14,4),
  usa_calculo BOOLEAN NOT NULL DEFAULT FALSE,
  -- Tabla de calculo del renglon. Cada fila es una cosa real (un trabajador, un
  -- material, un equipo) y TODAS las columnas multiplican; casilla vacia = no
  -- multiplica. Las columnas las nombra el usuario, asi que su cantidad y sus
  -- nombres cambian por renglon: por eso va como documento y no como tablas.
  --   { "columnas": [{ "uid": str, "nombre": str }],
  --     "lineas":   [{ "uid": str, "concepto": str,
  --                    "clase": "mano_obra"|"material"|"equipo"|null,
  --                    "valores": { "<columnaUid>": number|null } }] }
  calculo JSONB,
  orden INTEGER NOT NULL,
  row_uid UUID NOT NULL DEFAULT gen_random_uuid()
);
CREATE INDEX IF NOT EXISTS idx_presupuesto_renglones_presupuesto
  ON presupuesto_renglones(presupuesto_id);
CREATE INDEX IF NOT EXISTS idx_presupuesto_renglones_parent
  ON presupuesto_renglones(parent_id);