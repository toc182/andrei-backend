-- 185_proyecto_contrato_vigente.sql
--
-- El contrato vigente de cada proyecto: el monto y la fecha de terminación con
-- las adendas aprobadas ya puestas. Es UNA cuenta para todo el sistema —la ficha
-- del proyecto, el resumen, la lista de proyectos, Cuentas y Control de Costos
-- la leen de aquí— para que ninguna pantalla diga un monto distinto de otra.
-- Nada se guarda: aprobar, corregir o borrar una adenda se nota al instante.
--
--   monto_vigente     = el monto del contrato (Monto Total, con ITBMS) más los
--                       montos de las adendas aprobadas (con signo; migración 184).
--   fecha_fin_vigente = la nueva fecha de la ÚLTIMA adenda aprobada que la
--                       cambia (por número, no la fecha más lejana: una adenda
--                       posterior puede acortar el plazo); sin ninguna, la fecha
--                       de terminación del proyecto.
--
-- Las adendas en proceso, rechazadas o borradas no cuentan.

CREATE OR REPLACE VIEW proyecto_contrato_vigente AS
SELECT p.id AS proyecto_id,
       COALESCE(p.monto_total, p.monto_contrato_original) AS monto_contrato,
       COALESCE(m.suma, 0)::numeric(15,2) AS monto_adendas,
       COALESCE(m.cuantas, 0) AS adendas_con_monto,
       CASE WHEN COALESCE(p.monto_total, p.monto_contrato_original) IS NULL AND m.cuantas IS NULL THEN NULL
            ELSE (COALESCE(p.monto_total, p.monto_contrato_original, 0) + COALESCE(m.suma, 0))::numeric(15,2)
       END AS monto_vigente,
       COALESCE(f.nueva_fecha_fin, p.fecha_fin_estimada) AS fecha_fin_vigente,
       f.numero_adenda AS adenda_fecha_numero
  FROM proyectos p
  LEFT JOIN LATERAL (
    SELECT SUM(a.monto) AS suma, COUNT(*)::int AS cuantas
      FROM adendas a
     WHERE a.proyecto_id = p.id AND a.activo AND a.estado = 'aprobada' AND a.monto IS NOT NULL
    HAVING COUNT(*) > 0
  ) m ON TRUE
  LEFT JOIN LATERAL (
    SELECT a.nueva_fecha_fin, a.numero_adenda
      FROM adendas a
     WHERE a.proyecto_id = p.id AND a.activo AND a.estado = 'aprobada' AND a.nueva_fecha_fin IS NOT NULL
     ORDER BY a.numero_adenda DESC
     LIMIT 1
  ) f ON TRUE;

COMMENT ON VIEW proyecto_contrato_vigente IS
  'Monto y fecha de terminación del contrato con las adendas aprobadas puestas. La única cuenta del contrato vigente.';
COMMENT ON COLUMN proyecto_contrato_vigente.adenda_fecha_numero IS
  'Número de la adenda que fijó fecha_fin_vigente; NULL si es la fecha original del proyecto.';
