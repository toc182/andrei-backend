-- 145_cuentas_desglose_id.sql
-- La cuenta detallada (con cuadro + avance por fila) se arma a partir de un
-- desglose tipo='cuentas'. Guardamos de cuál se armó, para saber cuál editar de
-- cara a la siguiente cuenta del proyecto.
--
-- NULL en las cuentas viejas: siguen funcionando con el escalar
-- avance_porcentaje de siempre y no tienen foto. Una cuenta con desglose_id
-- no-nulo tiene su foto congelada en cuenta_lineas (migración 144). Si el
-- desglose se borrara, la foto sigue siendo autosuficiente: ON DELETE SET NULL.
ALTER TABLE cuentas ADD COLUMN IF NOT EXISTS desglose_id INTEGER
  REFERENCES desgloses(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_cuentas_desglose ON cuentas (desglose_id);
