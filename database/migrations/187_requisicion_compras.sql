-- 187_requisicion_compras.sql
--
-- La solicitud de pago o la orden de compra que nace de una requisicion
-- (Ivan, 2026-10-05; plan aprobado el 2026-10-07). Compras escoge las lineas que
-- compra y a que cotizacion le compra; la solicitud o la orden se abre ya llena
-- y, al guardarse, queda amarrada a esas lineas.
--
--   * Una requisicion se compra a veces a proveedores distintos: una linea puede
--     ir en una solicitud y otra linea en otra, o la misma linea en dos (Parcial).
--     Por eso el amarre es por LINEA, no por requisicion.
--   * La cotizacion «ganadora» es la que una solicitud u orden dice que compro.
--     No se toca la regla de «una elegida» de Cotizaciones: alli se lee de aqui.

-- ---------------------------------------------------------------------------
-- 1. Que linea se compro en que solicitud u orden
-- ---------------------------------------------------------------------------
-- Una fila por linea y por solicitud (o por orden). Si la solicitud se elimina,
-- la fila se queda: el amarre es historia, y las pantallas leen solo las
-- solicitudes activas.
CREATE TABLE IF NOT EXISTS requisicion_linea_compras (
  id SERIAL PRIMARY KEY,
  linea_id INTEGER NOT NULL REFERENCES requisicion_lineas(id),
  solicitud_pago_id INTEGER REFERENCES solicitudes_pago(id),
  orden_compra_id INTEGER REFERENCES ordenes_compra(id),
  creado_por INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT requisicion_linea_compras_un_destino
    CHECK ((solicitud_pago_id IS NULL) <> (orden_compra_id IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_requisicion_linea_compras_linea ON requisicion_linea_compras(linea_id);
CREATE INDEX IF NOT EXISTS idx_requisicion_linea_compras_solicitud ON requisicion_linea_compras(solicitud_pago_id);
CREATE INDEX IF NOT EXISTS idx_requisicion_linea_compras_orden ON requisicion_linea_compras(orden_compra_id);
CREATE INDEX IF NOT EXISTS idx_requisicion_linea_compras_creado_por ON requisicion_linea_compras(creado_por);

-- ---------------------------------------------------------------------------
-- 2. A que cotizacion se le compro
-- ---------------------------------------------------------------------------
-- solicitudes_pago.requisicion_id ya existe (lo dejo la 183 apuntando a la
-- requisicion nueva). La orden no tenia nada: se le agrega lo mismo.
ALTER TABLE solicitudes_pago
  ADD COLUMN IF NOT EXISTS requisicion_cotizacion_id INTEGER REFERENCES requisicion_cotizaciones(id);
CREATE INDEX IF NOT EXISTS idx_solicitudes_pago_requisicion_cotizacion
  ON solicitudes_pago(requisicion_cotizacion_id);

ALTER TABLE ordenes_compra
  ADD COLUMN IF NOT EXISTS requisicion_id INTEGER REFERENCES requisiciones(id);
ALTER TABLE ordenes_compra
  ADD COLUMN IF NOT EXISTS requisicion_cotizacion_id INTEGER REFERENCES requisicion_cotizaciones(id);
CREATE INDEX IF NOT EXISTS idx_ordenes_compra_requisicion ON ordenes_compra(requisicion_id);
CREATE INDEX IF NOT EXISTS idx_ordenes_compra_requisicion_cotizacion
  ON ordenes_compra(requisicion_cotizacion_id);
