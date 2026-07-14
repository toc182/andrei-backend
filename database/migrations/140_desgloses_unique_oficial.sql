-- 140_desgloses_unique_oficial.sql
-- Two concurrent FIRST saves could both pass the zero-row FOR UPDATE check and
-- create two active oficial desgloses (silent data loss: loadOficial's
-- ORDER BY id LIMIT 1 would hide the loser's document forever). The partial
-- unique index makes the one-active-oficial-per-project invariant a database
-- guarantee; routes/desgloses.ts maps 23505 on it to a 409.
CREATE UNIQUE INDEX IF NOT EXISTS uq_desgloses_oficial
  ON desgloses (proyecto_id) WHERE tipo = 'oficial' AND activo;
