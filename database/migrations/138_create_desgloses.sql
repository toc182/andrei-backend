-- 138_create_desgloses.sql
-- Desglose de precios: itemized contract price breakdown per project.
-- v1 keeps ONE active tipo='oficial' desglose per project (enforced in route
-- logic, not as a constraint — future versions add modificado/detallado).
-- Items are replaced wholesale on save (document-style, like cronograma_tareas);
-- the desgloses row itself soft-deletes via activo. Totals are never stored.
CREATE TABLE IF NOT EXISTS desgloses (
  id SERIAL PRIMARY KEY,
  proyecto_id INTEGER NOT NULL REFERENCES proyectos(id),
  nombre VARCHAR(200) NOT NULL DEFAULT 'Desglose oficial',
  tipo VARCHAR(30) NOT NULL DEFAULT 'oficial',
  activo BOOLEAN NOT NULL DEFAULT TRUE,
  creado_por INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_desgloses_proyecto ON desgloses(proyecto_id) WHERE activo = TRUE;

CREATE TABLE IF NOT EXISTS desglose_items (
  id SERIAL PRIMARY KEY,
  desglose_id INTEGER NOT NULL REFERENCES desgloses(id) ON DELETE CASCADE,
  parent_id INTEGER REFERENCES desglose_items(id) ON DELETE CASCADE,
  tipo VARCHAR(10) NOT NULL DEFAULT 'item' CHECK (tipo IN ('grupo', 'item')),
  item VARCHAR(60) NOT NULL DEFAULT '',
  descripcion TEXT NOT NULL DEFAULT '',
  unidad VARCHAR(30),
  cantidad NUMERIC(14,4),
  precio_unitario NUMERIC(14,4),
  orden INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_desglose_items_desglose ON desglose_items(desglose_id);
CREATE INDEX IF NOT EXISTS idx_desglose_items_parent ON desglose_items (parent_id);
