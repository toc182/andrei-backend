-- 142_desgloses_cuentas.sql
-- Desgloses de la sección Cuentas: además del único tipo='oficial' que vive en
-- Información (migración 138), un proyecto puede tener VARIOS desgloses de
-- trabajo con los que se arman las cuentas (el detallado que pide la institución
-- al arrancar, el que sale del diseño en un contrato de diseño-construcción, el
-- de sustento de avance...). Son tipo='cuentas'.
--
-- El índice único uq_desgloses_oficial (migración 140) NO estorba: su cláusula
-- WHERE sólo alcanza tipo='oficial', así que los tipo='cuentas' pueden ser
-- muchos por proyecto sin tocar esa garantía.
--
-- Reutilizamos `nombre` como la descripción que se ve en la tabla; no se agrega
-- una columna nueva para el mismo concepto.

-- Fecha que el usuario le asigna al desglose (no es created_at: puede ser
-- anterior a cuando se cargó al sistema).
ALTER TABLE desgloses ADD COLUMN IF NOT EXISTS fecha DATE;

-- Desglose del que se copió al crearlo; NULL = se creó en blanco. La copia es
-- una foto de una sola vez — después son documentos independientes —, así que
-- borrar el origen no debe borrar la copia: ON DELETE SET NULL.
ALTER TABLE desgloses ADD COLUMN IF NOT EXISTS copiado_de_id INTEGER
  REFERENCES desgloses(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_desgloses_proyecto_tipo
  ON desgloses (proyecto_id, tipo) WHERE activo = TRUE;

-- Comentarios de un desglose: hilo corrido, cada uno con autor y fecha.
-- Pertenecen al desglose donde se escribieron y NO se copian al duplicarlo.
CREATE TABLE IF NOT EXISTS desglose_comentarios (
  id SERIAL PRIMARY KEY,
  desglose_id INTEGER NOT NULL REFERENCES desgloses(id) ON DELETE CASCADE,
  texto TEXT NOT NULL,
  creado_por INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_desglose_comentarios_desglose
  ON desglose_comentarios (desglose_id);
CREATE INDEX IF NOT EXISTS idx_desglose_comentarios_creado_por
  ON desglose_comentarios (creado_por);
