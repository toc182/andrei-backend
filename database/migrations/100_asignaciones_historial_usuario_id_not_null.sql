-- 100_asignaciones_historial_usuario_id_not_null.sql
-- H1 schema audit: enforce that every change-log row records who made the change.
-- The only INSERT site (routes/asignaciones.ts) always passes req.user.id behind
-- authenticateToken, so this closes the gap at the schema level.
-- Also folds in M10: index on usuario_id for "history by user" queries.

ALTER TABLE asignaciones_historial ALTER COLUMN usuario_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_asignaciones_historial_usuario_id
  ON asignaciones_historial(usuario_id);
