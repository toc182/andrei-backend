-- 182_orden_compra_facturas.sql
--
-- La orden SI llega por partes, y cada parte es una FACTURA.
--
-- Ivan, 2026-10-05, armando una orden de verdad: el proveedor dio credito hasta
-- un limite, a 60 dias; la orden llego en dos dias distintos, en varios envios,
-- con unas cinco facturas. Eso deshace la regla del 02/10 («la orden llega
-- completa, en un solo paso»). Lo que decidio:
--
--   * Cada entrega se registra por su factura: numero, fecha, monto y el
--     archivo. Sin contar cantidades renglon por renglon.
--   * Los dias de credito corren desde la fecha de CADA factura, y cada factura
--     se paga por separado.
--   * El monto de la orden es referencial: lo que se debe es la suma de las
--     facturas (redondeos, material que falto).
--   * Como las facturas no tienen por que sumar la orden, el sistema no puede
--     saber solo cuando termino de llegar: alguien la marca como COMPLETA, y
--     desde ahi ya no admite facturas.
--
-- La factura vive en orden_compra_entregas: cada fila ya tenia su fecha, su
-- vencimiento congelado y su monto, y a ella ya se amarra el pago
-- (solicitud_pago_entregas). Aqui solo se le agrega el numero.
ALTER TABLE orden_compra_entregas ADD COLUMN IF NOT EXISTS numero_factura VARCHAR(100);

-- Una factura se registra por su total, que es lo que se paga. Su desglose
-- (subtotal, ITBMS) esta en el papel adjunto; inventarlo aqui con la tasa de la
-- orden seria guardar un numero que nadie escribio. Las recepciones de antes
-- conservan el suyo.
ALTER TABLE orden_compra_entregas ALTER COLUMN subtotal DROP NOT NULL;
ALTER TABLE orden_compra_entregas ALTER COLUMN itbms DROP NOT NULL;

-- Una factura mal digitada se ANULA y se registra de nuevo (Ivan, 2026-10-07):
-- solo mientras no tenga una solicitud de pago encima. No se borra: queda con
-- activo = false, y con quien, cuando y por que, para la historia de la orden.
ALTER TABLE orden_compra_entregas ADD COLUMN IF NOT EXISTS anulada_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE orden_compra_entregas ADD COLUMN IF NOT EXISTS anulada_por INTEGER REFERENCES users(id);
ALTER TABLE orden_compra_entregas ADD COLUMN IF NOT EXISTS anulada_motivo TEXT;

ALTER TABLE ordenes_compra ADD COLUMN IF NOT EXISTS completa_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE ordenes_compra ADD COLUMN IF NOT EXISTS completa_por INTEGER REFERENCES users(id);

-- Las que se recibieron con la regla del 02/10 llegaron completas por
-- definicion: quedan marcadas asi, con el momento y la persona de esa recepcion.
UPDATE ordenes_compra o
   SET completa_at = e.created_at,
       completa_por = e.registrada_por
  FROM (
    SELECT DISTINCT ON (orden_compra_id) orden_compra_id, created_at, registrada_por
      FROM orden_compra_entregas
     WHERE activo = true
     ORDER BY orden_compra_id, created_at DESC
  ) e
 WHERE e.orden_compra_id = o.id
   AND o.completa_at IS NULL;
