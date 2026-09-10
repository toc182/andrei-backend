-- 161_partidas_ancladas_al_presupuesto.sql
-- Las partidas del control de costos pasan a ser las del PRESUPUESTO oficial
-- del proyecto, no las del desglose del contrato.
--
-- Por que (Ivan, 2026-09-10): el desglose es el cuadro de precios del contrato
-- y puede tener 8 lineas. Con 8 lineas no se controla un costo. El detalle esta
-- en el presupuesto — Playa Blanca tiene 40 lineas de costo y ningun desglose.
--
-- Esto invierte la razon que traia la migracion 154, que anclaba al desglose
-- justamente para que mover la estrella no descolocase el gasto ya clasificado.
-- Se resuelve de otra manera: cada clasificacion ahora recuerda A QUE
-- PRESUPUESTO pertenece. Al cambiar de oficial, las lineas del anterior dejan
-- de casar y todo aparece en cero —que es lo pedido—, pero NO se borran: si se
-- vuelve a marcar el presupuesto anterior, la clasificacion reaparece.
--
-- desglose_id se queda como columna historica anulable. No cuesta nada y deja
-- el rastro de donde venia cada clasificacion.

-- Los indices se rehacen al final: el traslado de abajo reescribe row_uid, y el
-- unico viejo lo mira.
DROP INDEX IF EXISTS uq_solicitud_pago_partidas_pago_fila;
DROP INDEX IF EXISTS idx_solicitud_pago_partidas_fila;

ALTER TABLE solicitud_pago_partidas
  ADD COLUMN IF NOT EXISTS presupuesto_id INTEGER REFERENCES presupuestos(id);
ALTER TABLE solicitud_pago_partidas ALTER COLUMN desglose_id DROP NOT NULL;

-- Traslado. Una clasificacion apunta hoy a una fila del desglose; el renglon
-- equivalente del presupuesto oficial guarda ese mismo uid en
-- `desglose_row_uid`, porque se copia al armar el presupuesto desde el
-- desglose. Por eso el traslado es exacto y no hay que adivinar nada.
UPDATE solicitud_pago_partidas sp
   SET presupuesto_id = r.presupuesto_id,
       row_uid        = r.row_uid
  FROM presupuesto_renglones r
  JOIN presupuestos p ON p.id = r.presupuesto_id
 WHERE sp.presupuesto_id IS NULL
   AND r.desglose_row_uid = sp.row_uid
   AND p.activo AND p.es_principal
   AND p.proyecto_id = (SELECT d.proyecto_id FROM desgloses d WHERE d.id = sp.desglose_id);

-- Lo que no se pudo trasladar vuelve a "sin clasificar". Es la misma regla que
-- ya regia cuando una partida desaparecia: el pago vuelve a la bandeja de
-- pendientes y una persona decide, en vez de arrastrar un ancla que no apunta
-- a nada.
DELETE FROM solicitud_pago_partidas WHERE presupuesto_id IS NULL;

ALTER TABLE solicitud_pago_partidas ALTER COLUMN presupuesto_id SET NOT NULL;

-- Para el camino contrario: cuanto se lleva gastado en una partida.
CREATE INDEX IF NOT EXISTS idx_solicitud_pago_partidas_fila
  ON solicitud_pago_partidas (presupuesto_id, row_uid);

-- Una sola linea por (pago, renglon del presupuesto): repartir dos veces en la
-- misma partida es un monto solo, no dos filas.
CREATE UNIQUE INDEX IF NOT EXISTS uq_solicitud_pago_partidas_pago_fila
  ON solicitud_pago_partidas (solicitud_pago_id, presupuesto_id, row_uid);
