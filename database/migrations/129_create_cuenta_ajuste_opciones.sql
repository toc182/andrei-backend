-- 129_create_cuenta_ajuste_opciones.sql
--
-- Per-project preset options for cuenta ajustes. Each option carries a
-- fixed tipo (aumento|disminucion) and descripcion. When the user adds
-- an ajuste to a cuenta, they pick from this list (or create a new
-- option inline, which lands here). Picking an option locks the row's
-- tipo to whatever the option declares.
--
-- cuenta_ajustes itself stays denormalized: it stores tipo + descripcion
-- + monto directly, so deleting an option later doesn't orphan historical
-- ajustes that referenced it.

CREATE TABLE IF NOT EXISTS cuenta_ajuste_opciones (
  id SERIAL PRIMARY KEY,
  proyecto_id INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
  tipo VARCHAR(20) NOT NULL CHECK (tipo IN ('aumento', 'disminucion')),
  descripcion TEXT NOT NULL,
  orden INTEGER NOT NULL DEFAULT 0,
  creado_por INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (proyecto_id, tipo, descripcion)
);

CREATE INDEX IF NOT EXISTS idx_cuenta_ajuste_opciones_proyecto
  ON cuenta_ajuste_opciones(proyecto_id, orden);
