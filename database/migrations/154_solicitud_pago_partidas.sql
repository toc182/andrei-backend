-- 154_solicitud_pago_partidas.sql
-- A que PARTIDA del desglose pertenece cada pago. Sin esto el control de costos
-- solo puede comparar total contra total; con esto compara renglon por renglon.
--
-- Una factura puede cubrir varias partidas, asi que un pago tiene N filas aqui,
-- cada una con su monto. La suma de las filas de un pago tiene que dar el
-- monto_total de la solicitud (se valida en la ruta, no aqui: un pago sin
-- clasificar simplemente no tiene filas, y ese es un estado legitimo).
--
-- El ancla es (desglose_id, row_uid), NO desglose_items.id: replaceItems() en
-- routes/desgloses.ts borra y reinserta todos los items en cada guardado, asi
-- que los ids cambian. row_uid es el UUID estable que el cliente reenvia (ver
-- migracion 143) y es el mismo ancla que usa la foto de avance de una cuenta
-- (migracion 144).
--
-- DELIBERADAMENTE SIN FK sobre (desglose_id, row_uid), aunque exista el indice
-- unico que lo permitiria: una FK haria que borrar una fila del desglose
-- arrastrase o bloquease la clasificacion del gasto ya hecho. Lo acordado es lo
-- contrario — si una partida desaparece, sus pagos vuelven a la bandeja de
-- pendientes y una persona decide. Esa consulta se hace con un LEFT JOIN.
CREATE TABLE IF NOT EXISTS solicitud_pago_partidas (
  id SERIAL PRIMARY KEY,
  solicitud_pago_id INTEGER NOT NULL REFERENCES solicitudes_pago(id) ON DELETE CASCADE,
  desglose_id INTEGER NOT NULL REFERENCES desgloses(id),
  row_uid UUID NOT NULL,
  monto NUMERIC(14,2) NOT NULL,
  creado_por INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_solicitud_pago_partidas_solicitud
  ON solicitud_pago_partidas (solicitud_pago_id);

-- Para el camino contrario: cuanto se lleva gastado en una partida.
CREATE INDEX IF NOT EXISTS idx_solicitud_pago_partidas_fila
  ON solicitud_pago_partidas (desglose_id, row_uid);

-- Una sola linea por (pago, fila del desglose): repartir dos veces en la misma
-- partida es un monto solo, no dos filas.
CREATE UNIQUE INDEX IF NOT EXISTS uq_solicitud_pago_partidas_pago_fila
  ON solicitud_pago_partidas (solicitud_pago_id, desglose_id, row_uid);
