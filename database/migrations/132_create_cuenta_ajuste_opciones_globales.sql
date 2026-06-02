-- 132_create_cuenta_ajuste_opciones_globales.sql
--
-- Global ajuste options that appear in every project by default,
-- merged into the cuenta detail GET response alongside the
-- per-project options in cuenta_ajuste_opciones. Centrally managed,
-- read-only from the per-project flow. Initial seeds: ITBMS (aumento)
-- and Retención ITBMS 50% (disminucion).
--
-- No creado_por column because these are seeded by migration, not by
-- a user. No proyecto_id because they apply to every project.

CREATE TABLE IF NOT EXISTS cuenta_ajuste_opciones_globales (
  id SERIAL PRIMARY KEY,
  tipo VARCHAR(20) NOT NULL CHECK (tipo IN ('aumento', 'disminucion')),
  descripcion TEXT NOT NULL,
  orden INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tipo, descripcion)
);

INSERT INTO cuenta_ajuste_opciones_globales (tipo, descripcion, orden)
VALUES
  ('aumento', 'ITBMS', 0),
  ('disminucion', 'Retención ITBMS 50%', 1)
ON CONFLICT (tipo, descripcion) DO NOTHING;
