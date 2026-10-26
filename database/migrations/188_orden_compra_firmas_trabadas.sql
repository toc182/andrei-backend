-- 188_orden_compra_firmas_trabadas.sql
--
-- Ordenes de compra que se quedaron esperando una firma que nadie puede dar
-- (Ivan, 2026-10-26: OC-PBR-002 tenia 1 de 2 firmas, el proyecto quedo con un
-- solo aprobador —el que ya habia firmado— y la orden no avanzaba ni le tocaba
-- a nadie). Pasaba porque cambiar los aprobadores de un proyecto devolvia a cero
-- sus solicitudes de pago pero no sus ordenes; desde esta version las devuelve
-- a cero tambien (routes/approvalSettings.ts).
--
-- Aqui se destraban las que ya quedaron asi. Una orden que espera firmas esta
-- trabada cuando sus firmas no son el principio de la cadena actual de su
-- proyecto: firmo alguien que ya no esta en ese puesto, o ya firmaron todos los
-- de la cadena y sigue esperando. Vuelve a esperar todas sus firmas, como si le
-- hubieran cambiado los aprobadores con la ruta, y lo que pierde queda en el
-- rastro. El rastro exige una persona (migracion 078): se anota a quien cambio
-- por ultima vez los aprobadores del proyecto, que es lo que la dejo trabada, y
-- si no hay registro de eso, a quien creo la orden.
--
-- Solo las que esperan firmas: una ya aprobada no esta trabada. Correrla otra
-- vez no hace nada.

WITH cadena AS (
  SELECT proyecto_id, user_id,
         ROW_NUMBER() OVER (PARTITION BY proyecto_id ORDER BY orden, id) AS n
    FROM proyecto_ajustes_aprobacion
   WHERE activo = true
),
firmas AS (
  SELECT a.orden_compra_id, a.user_id, a.orden, a.accion, a.fecha,
         ROW_NUMBER() OVER (PARTITION BY a.orden_compra_id ORDER BY a.orden, a.id) AS n
    FROM orden_compra_aprobaciones a
    JOIN ordenes_compra o ON o.id = a.orden_compra_id
   WHERE o.estado = 'pendiente' AND o.activo = true
),
trabadas AS (
  SELECT o.id, o.numero,
         COALESCE(
           (SELECT al.user_id FROM audit_log al
             WHERE al.accion = 'editar_aprobadores' AND al.entidad = 'proyecto'
               AND al.entidad_id = o.proyecto_id
             ORDER BY al.id DESC LIMIT 1),
           o.creado_por
         ) AS anotado_por
    FROM ordenes_compra o
   WHERE o.estado = 'pendiente' AND o.activo = true
     AND EXISTS (SELECT 1 FROM firmas f WHERE f.orden_compra_id = o.id)
     AND (
       -- firmo alguien que no es quien esta en ese puesto de la cadena
       EXISTS (
         SELECT 1 FROM firmas f
           LEFT JOIN cadena c ON c.proyecto_id = o.proyecto_id AND c.n = f.n
          WHERE f.orden_compra_id = o.id
            AND (c.user_id IS NULL OR c.user_id <> f.user_id)
       )
       -- o ya firmaron todos y la orden sigue esperando
       OR (SELECT count(*) FROM firmas f WHERE f.orden_compra_id = o.id)
          >= (SELECT count(*) FROM cadena c WHERE c.proyecto_id = o.proyecto_id)
     )
),
anotadas AS (
  INSERT INTO audit_log (user_id, accion, entidad, entidad_id, detalles)
  SELECT t.anotado_por, 'reiniciar_firmas', 'orden_compra', t.id,
         jsonb_build_object(
           'numero', t.numero,
           'motivo', 'Sus firmas no correspondian a los aprobadores actuales del proyecto (migracion 188)',
           'firmas', (
             SELECT jsonb_agg(jsonb_build_object(
                      'user_id', f.user_id, 'orden', f.orden, 'accion', f.accion, 'fecha', f.fecha
                    ) ORDER BY f.n)
               FROM firmas f WHERE f.orden_compra_id = t.id
           )
         )
    FROM trabadas t
  RETURNING entidad_id
)
DELETE FROM orden_compra_aprobaciones a
 USING trabadas t
 WHERE a.orden_compra_id = t.id;
