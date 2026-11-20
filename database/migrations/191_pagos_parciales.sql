-- 191_pagos_parciales.sql
--
-- Pagos parciales (tema 19, Ivan 2026-11-17/18): una solicitud regular se puede
-- pagar en partes. Cada pago lleva su monto y su comprobante; mientras queda
-- saldo la solicitud está «abonada», y cuando el saldo llega a cero pasa sola a
-- pagada (o a facturada, si la factura ya se había subido).
--
-- comprobantes_pago deja de ser «el pago de la solicitud» y pasa a ser «un
-- pago»: una fila por pago. Las filas que ya existen eran siempre el pago
-- completo, así que su monto es el total de su solicitud y ninguna cuenta
-- cambia: lo pagado de cada solicitud ya pagada sigue siendo su total.
--
-- Un pago no se borra nunca. Un admin lo anula con un motivo (activo = false) y
-- queda en el historial; un pago anulado no cuenta en nada.

-- 1. El estado nuevo.
ALTER TABLE solicitudes_pago DROP CONSTRAINT IF EXISTS solicitudes_pago_estado_check;
ALTER TABLE solicitudes_pago ADD CONSTRAINT solicitudes_pago_estado_check
  CHECK (estado IN ('borrador', 'pendiente', 'aprobada', 'rechazada', 'abonada',
                    'pagada', 'facturada', 'devolucion', 'reembolsada', 'transferida'));

-- 2. Una fila por pago, con su monto.
ALTER TABLE comprobantes_pago DROP CONSTRAINT IF EXISTS comprobantes_pago_solicitud_pago_id_key;
CREATE INDEX IF NOT EXISTS idx_comprobantes_pago_solicitud ON comprobantes_pago(solicitud_pago_id);

ALTER TABLE comprobantes_pago ADD COLUMN IF NOT EXISTS monto NUMERIC(12,2);
UPDATE comprobantes_pago cp
   SET monto = sp.monto_total
  FROM solicitudes_pago sp
 WHERE sp.id = cp.solicitud_pago_id
   AND cp.monto IS NULL;
ALTER TABLE comprobantes_pago ALTER COLUMN monto SET NOT NULL;
ALTER TABLE comprobantes_pago DROP CONSTRAINT IF EXISTS comprobantes_pago_monto_check;
ALTER TABLE comprobantes_pago ADD CONSTRAINT comprobantes_pago_monto_check CHECK (monto > 0);

-- 3. Anular un pago, con quién, cuándo y por qué.
ALTER TABLE comprobantes_pago ADD COLUMN IF NOT EXISTS activo BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE comprobantes_pago ADD COLUMN IF NOT EXISTS anulado_por INTEGER REFERENCES users(id);
ALTER TABLE comprobantes_pago ADD COLUMN IF NOT EXISTS anulado_at TIMESTAMPTZ;
ALTER TABLE comprobantes_pago ADD COLUMN IF NOT EXISTS motivo_anulacion TEXT;
CREATE INDEX IF NOT EXISTS idx_comprobantes_pago_anulado_por ON comprobantes_pago(anulado_por);
ALTER TABLE comprobantes_pago DROP CONSTRAINT IF EXISTS comprobantes_pago_anulacion_check;
ALTER TABLE comprobantes_pago ADD CONSTRAINT comprobantes_pago_anulacion_check CHECK (
  CASE WHEN activo
       THEN anulado_por IS NULL AND anulado_at IS NULL AND motivo_anulacion IS NULL
       ELSE anulado_por IS NOT NULL AND anulado_at IS NOT NULL AND btrim(COALESCE(motivo_anulacion, '')) <> ''
  END
);

COMMENT ON TABLE comprobantes_pago IS
  'Un pago de una solicitud (migración 191): fecha, monto y quién lo registró. Una solicitud regular '
  'puede tener varios (pagos parciales); las de caja menuda, uno. Nunca se borra: se anula con motivo '
  '(activo = false) y deja de contar. Lo pagado y el saldo se leen de la vista solicitud_pago_saldo.';

-- 4. Cada archivo de comprobante sabe de qué pago es, y solo los comprobantes
--    tienen pago. Hoy cada solicitud tiene a lo sumo un pago, así que el enlace
--    de los archivos que ya existen es directo. Si se quita el pago (solo pasa al
--    retirar una solicitud entera, services/solicitudRetiro.ts), se van con él.
ALTER TABLE solicitud_pago_adjuntos
  ADD COLUMN IF NOT EXISTS comprobante_pago_id INTEGER REFERENCES comprobantes_pago(id) ON DELETE CASCADE;
UPDATE solicitud_pago_adjuntos a
   SET comprobante_pago_id = cp.id
  FROM comprobantes_pago cp
 WHERE cp.solicitud_pago_id = a.solicitud_pago_id
   AND a.tipo_adjunto = 'comprobante'
   AND a.comprobante_pago_id IS NULL;
-- Un archivo marcado comprobante en una solicitud sin pago registrado no es el
-- comprobante de ningún pago: queda como adjunto corriente, a la vista, sin
-- perderse. En producción no hay ninguno (2026-11-18); en bases locales, sí.
UPDATE solicitud_pago_adjuntos
   SET tipo_adjunto = 'adjunto'
 WHERE tipo_adjunto = 'comprobante'
   AND comprobante_pago_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_spadj_comprobante_pago ON solicitud_pago_adjuntos(comprobante_pago_id);
ALTER TABLE solicitud_pago_adjuntos DROP CONSTRAINT IF EXISTS solicitud_pago_adjuntos_comprobante_pago_check;
ALTER TABLE solicitud_pago_adjuntos ADD CONSTRAINT solicitud_pago_adjuntos_comprobante_pago_check
  CHECK ((tipo_adjunto IS NOT DISTINCT FROM 'comprobante') = (comprobante_pago_id IS NOT NULL));

-- 5. Lo pagado y el saldo de cada solicitud. Es la ÚNICA cuenta: toda pantalla,
--    papel, reporte o mensaje que diga cuánto se ha pagado o cuánto falta la lee
--    de aquí. Solo cuentan los pagos activos.
CREATE OR REPLACE VIEW solicitud_pago_saldo AS
SELECT sp.id AS solicitud_pago_id,
       sp.monto_total,
       COALESCE(p.pagado, 0)::numeric(12,2) AS pagado,
       (sp.monto_total - COALESCE(p.pagado, 0))::numeric(12,2) AS saldo,
       COALESCE(p.pagos, 0) AS pagos,
       p.ultima_fecha_pago
  FROM solicitudes_pago sp
  LEFT JOIN (
    SELECT solicitud_pago_id, SUM(monto) AS pagado, COUNT(*)::int AS pagos, MAX(fecha_pago) AS ultima_fecha_pago
      FROM comprobantes_pago
     WHERE activo
     GROUP BY solicitud_pago_id
  ) p ON p.solicitud_pago_id = sp.id;

COMMENT ON VIEW solicitud_pago_saldo IS
  'Lo pagado y el saldo de cada solicitud de pago (migración 191): la suma de sus pagos activos en '
  'comprobantes_pago. Única cuenta del sistema; no sumar pagos en otro lado.';

-- 6. Lo que cuenta como GASTO del proyecto: solo lo pagado (Ivan, 2026-11-18).
--    Control de Costos, el reporte semanal, las órdenes de compra y el asistente
--    de pagos leen de aquí, para que ninguno cuente distinto.
--
--    Cuentan las solicitudes abonadas, pagadas y facturadas: las regulares que
--    ya tienen plata afuera. No cuentan la devolución (el proveedor devolvió la
--    plata) ni las de caja menuda (reembolsada, transferida), que solo mueven
--    plata hacia la caja.
CREATE OR REPLACE VIEW solicitud_pago_gasto AS
SELECT s.id AS solicitud_pago_id,
       s.proyecto_id,
       s.categoria_id,
       s.monto_total,
       v.pagado,
       v.ultima_fecha_pago
  FROM solicitudes_pago s
  JOIN solicitud_pago_saldo v ON v.solicitud_pago_id = s.id
 WHERE s.activo
   AND s.estado IN ('abonada', 'pagada', 'facturada')
   AND v.pagos > 0;

COMMENT ON VIEW solicitud_pago_gasto IS
  'Cada solicitud de pago que cuenta como gasto del proyecto (abonada, pagada o facturada) con lo '
  'pagado hasta hoy (migración 191). Lo que cuenta es lo pagado, no el total de la solicitud.';

--    Cada pago en su fecha: la curva de Control de Costos y los pagos de la
--    semana van por aquí, no por la fecha del último pago de la solicitud.
CREATE OR REPLACE VIEW comprobante_pago_gasto AS
SELECT cp.id AS comprobante_pago_id,
       cp.solicitud_pago_id,
       g.proyecto_id,
       g.categoria_id,
       cp.fecha_pago,
       cp.monto
  FROM comprobantes_pago cp
  JOIN solicitud_pago_gasto g ON g.solicitud_pago_id = cp.solicitud_pago_id
 WHERE cp.activo;

COMMENT ON VIEW comprobante_pago_gasto IS
  'Cada pago activo que cuenta como gasto del proyecto, en su fecha y por su monto (migración 191).';

--    La parte ya pagada de un pedazo de la solicitud —lo que se le asignó a una
--    partida del presupuesto o a una factura de una orden de compra— en
--    proporción a lo pagado. Pagada completa, la parte entera, exacta; abonada,
--    la proporción a toda precisión (se redondea solo al mostrarla).
CREATE OR REPLACE FUNCTION parte_pagada(parte NUMERIC, pagado NUMERIC, total NUMERIC)
RETURNS NUMERIC
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
           WHEN pagado >= total THEN parte
           WHEN total > 0 THEN parte * pagado / total
           ELSE 0
         END
$$;

COMMENT ON FUNCTION parte_pagada(NUMERIC, NUMERIC, NUMERIC) IS
  'La parte ya pagada de un pedazo de una solicitud (partida, factura de orden de compra), en '
  'proporción a lo pagado de la solicitud (migración 191).';
