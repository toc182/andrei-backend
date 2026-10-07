-- 186_avance_fisico.sql
--
-- El avance físico de un proyecto es lo que tiene en cuentas: presentadas o no,
-- aprobadas o no, pagadas o no (Ivan, 2026-10-01). Las que siguen en borrador
-- también cuentan, pero aparte, para que la pantalla avise que incluye avance
-- todavía no presentado. Es UNA cuenta para todo el sistema: el Resumen del
-- proyecto, Cuentas y, más adelante, la curva S del reporte de avance la leen
-- de aquí. Nada se guarda.
--
-- cuenta_avance: una fila por cuenta activa.
--   avance_periodo   = el avance de esa cuenta.
--   avance_acumulado = el avance hasta esa cuenta, inclusive.
--   Cuenta a mano: el % escrito, y el acumulado es la suma en orden de número.
--   Cuenta con desglose: lo que dice su cuadro, a precisión completa —lo
--   ejecutado (este periodo, y el acumulado con lo de las cuentas anteriores de
--   cada fila) por su precio, entre el presupuesto de su foto—, igual que la
--   pantalla de la cuenta. La columna avance_porcentaje es un espejo redondeado
--   a dos decimales y sumar varios se desvía: aquí no se usa para esas.
--
-- proyecto_avance_fisico: una fila por proyecto con cuentas.
--   avance_acumulado     = el de la última cuenta.
--   avance_sin_presentar = lo que aportan las cuentas en borrador.
--   avance_presentado    = la diferencia.
--   cuenta_numero        = la última cuenta que aporta avance (NULL si ninguna).
--   cuentas_sin_presentar = los números de las cuentas en borrador que aportan.

CREATE OR REPLACE VIEW cuenta_avance AS
SELECT c.id AS cuenta_id,
       c.proyecto_id,
       c.numero,
       c.estado,
       c.estado <> 'borrador' AS presentada,
       c.periodo_inicio,
       c.periodo_fin,
       c.fecha_presentacion,
       CASE WHEN c.desglose_id IS NULL THEN COALESCE(c.avance_porcentaje, 0)
            WHEN d.presupuesto > 0 THEN d.periodo / d.presupuesto * 100
            ELSE 0
       END AS avance_periodo,
       CASE WHEN c.desglose_id IS NULL
              THEN SUM(COALESCE(c.avance_porcentaje, 0)) OVER (PARTITION BY c.proyecto_id ORDER BY c.numero)
            WHEN d.presupuesto > 0 THEN d.acumulado / d.presupuesto * 100
            ELSE 0
       END AS avance_acumulado
  FROM cuentas c
  LEFT JOIN LATERAL (
    SELECT SUM(cl.cantidad_ejecutada * COALESCE(cl.precio_unitario, 0)) AS periodo,
           SUM((cl.cantidad_ejecutada + COALESCE((
                  SELECT SUM(cl2.cantidad_ejecutada)
                    FROM cuenta_lineas cl2
                    JOIN cuentas c2 ON c2.id = cl2.cuenta_id
                   WHERE c2.proyecto_id = c.proyecto_id AND c2.activo AND c2.numero < c.numero
                     AND cl2.row_uid = cl.row_uid
                ), 0)) * COALESCE(cl.precio_unitario, 0)) AS acumulado,
           SUM(COALESCE(cl.cantidad_presupuesto, 0) * COALESCE(cl.precio_unitario, 0)) AS presupuesto
      FROM cuenta_lineas cl
     WHERE cl.cuenta_id = c.id AND c.desglose_id IS NOT NULL
  ) d ON TRUE
 WHERE c.activo;

COMMENT ON VIEW cuenta_avance IS
  'Avance físico por cuenta: el del periodo y el acumulado hasta ella. La única cuenta del avance físico.';

CREATE OR REPLACE VIEW proyecto_avance_fisico AS
SELECT ca.proyecto_id,
       u.avance_acumulado,
       u.avance_acumulado - COALESCE(SUM(ca.avance_periodo) FILTER (WHERE NOT ca.presentada), 0) AS avance_presentado,
       COALESCE(SUM(ca.avance_periodo) FILTER (WHERE NOT ca.presentada), 0) AS avance_sin_presentar,
       MAX(ca.numero) FILTER (WHERE ca.avance_periodo > 0) AS cuenta_numero,
       COALESCE(ARRAY_AGG(ca.numero ORDER BY ca.numero)
                  FILTER (WHERE NOT ca.presentada AND ca.avance_periodo > 0), '{}') AS cuentas_sin_presentar
  FROM cuenta_avance ca
  JOIN LATERAL (
    SELECT x.avance_acumulado FROM cuenta_avance x
     WHERE x.proyecto_id = ca.proyecto_id
     ORDER BY x.numero DESC
     LIMIT 1
  ) u ON TRUE
 GROUP BY ca.proyecto_id, u.avance_acumulado;

COMMENT ON VIEW proyecto_avance_fisico IS
  'Avance físico del proyecto según sus cuentas, con lo que está en cuentas en borrador aparte.';
