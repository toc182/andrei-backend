-- 180_asistente_semanales.sql
--
-- Los reportes SEMANALES para el asistente de WhatsApp, igual que la 179 hizo
-- con los diarios. Ivan, 2026-10-02: que se le pueda preguntar por ellos.
--
-- Aqui va solo lo que el semanal tiene y el diario no: el resumen, el plan, las
-- metas y como quedaron, los problemas y las decisiones. Las cifras de la
-- semana (gente, horas de maquina, horas perdidas, lo que llego) NO: se cuentan
-- de las vistas de los diarios, que son los mismos reportes que el semanal
-- resumio —una semana enviada ya no admite cambios en sus diarios—. Asi hay una
-- sola manera de contar. Los pagos del semanal tampoco: de dinero el asistente
-- solo habla con las solicitudes de pago, que tienen sus propias reglas.
--
-- Las mismas reglas que la 179: solo lo enviado y no eliminado (un borrador no
-- existe para nadie mas que para quien lo escribe), y cada vista filtra por las
-- obras de asistente.acceso. Ver un semanal en la pantalla pide el mismo
-- permiso que un diario (reportes), asi que las obras son las mismas.

CREATE OR REPLACE VIEW asistente.semanales WITH (security_barrier) AS
SELECT s.id AS semanal_id,
       s.proyecto_id AS obra_id,
       o.obra,
       s.numero,
       s.semana_inicio,
       s.semana_fin,
       s.semana_iso,
       s.anio_iso,
       -- enviado_at es la hora del servidor de base, sin zona: se pasa al dia
       -- de Panama.
       (s.enviado_at::timestamptz AT TIME ZONE 'America/Panama')::date AS enviado_el,
       u.nombre AS escrito_por,
       s.resumen,
       s.lo_que_se_espera
  FROM proyecto_reportes_semanales s
  JOIN asistente.obras o ON o.obra_id = s.proyecto_id
  LEFT JOIN users u ON u.id = s.creado_por
 WHERE s.activo AND s.completo;

COMMENT ON VIEW asistente.semanales IS
  'Un reporte SEMANAL enviado por fila (los borradores y los eliminados no estan). Una obra tiene a lo sumo uno por semana, de lunes a domingo. Las cifras de la semana —gente, horas de maquina, horas perdidas, lo que llego— no estan aqui: se cuentan en las tablas de los diarios con fecha BETWEEN semana_inicio AND semana_fin, que son los diarios que resumio el semanal.';
COMMENT ON COLUMN asistente.semanales.numero IS 'RS-<codigo de la obra>-AAMMDD del lunes, por ejemplo RS-PBR-260921.';
COMMENT ON COLUMN asistente.semanales.semana_inicio IS 'El lunes de la semana que cuenta el reporte.';
COMMENT ON COLUMN asistente.semanales.semana_fin IS 'El domingo de esa semana.';
COMMENT ON COLUMN asistente.semanales.semana_iso IS
  'El numero de la semana en el año (semana ISO, la que empieza en lunes): «la semana 39» es semana_iso = 39.';
COMMENT ON COLUMN asistente.semanales.enviado_el IS 'El dia en que salio por correo (NULL si el correo todavia no ha salido).';
COMMENT ON COLUMN asistente.semanales.resumen IS
  'Lo que se logro en la semana, en texto. Lo redacta la IA a partir de los diarios y el ingeniero lo corrige (o lo escribe el).';
COMMENT ON COLUMN asistente.semanales.lo_que_se_espera IS
  'El plan de la semana siguiente, en texto, como lo escribio el ingeniero. Las metas de ese plan estan en semanal_metas.';

-- Las metas. Una meta vive en DOS semanales: se planea en uno para la semana
-- siguiente y se dice como quedo en el de esa semana. Lo que se marco en un
-- semanal que todavia es borrador no se ve: hasta que sale, la meta esta sin
-- marcar.
CREATE OR REPLACE VIEW asistente.semanal_metas WITH (security_barrier) AS
SELECT m.id AS meta_id,
       o.obra_id,
       o.obra,
       COALESCE(ev.semana_inicio, pl.semana_inicio + 7) AS semana_inicio,
       COALESCE(ev.semana_fin, pl.semana_fin + 7) AS semana_fin,
       pl.numero AS planeada_en,
       ev.numero AS evaluada_en,
       m.texto,
       m.cantidad,
       m.unidad,
       CASE WHEN ev.id IS NOT NULL THEN m.estado END AS estado,
       CASE WHEN ev.id IS NOT NULL THEN m.cantidad_hecha END AS cantidad_hecha,
       CASE WHEN ev.id IS NOT NULL THEN m.porcentaje END AS porcentaje,
       CASE WHEN ev.id IS NOT NULL THEN m.motivo END AS motivo
  FROM proyecto_reporte_semanal_metas m
  LEFT JOIN proyecto_reportes_semanales pl
         ON pl.id = m.reporte_plan_id AND pl.activo AND pl.completo
  LEFT JOIN proyecto_reportes_semanales ev
         ON ev.id = m.reporte_evaluacion_id AND ev.activo AND ev.completo
  JOIN asistente.obras o ON o.obra_id = COALESCE(ev.proyecto_id, pl.proyecto_id)
 WHERE pl.id IS NOT NULL OR ev.id IS NOT NULL;

COMMENT ON VIEW asistente.semanal_metas IS
  'Las metas de los semanales: una fila por meta. Una meta se planea en un semanal para la semana siguiente y en el semanal de esa semana se dice como quedo.';
COMMENT ON COLUMN asistente.semanal_metas.semana_inicio IS
  'El lunes de la semana en que habia que cumplirla.';
COMMENT ON COLUMN asistente.semanal_metas.planeada_en IS
  'El numero del semanal que la planeo. NULL = no estaba en el plan: la agregaron al decir como quedo la semana.';
COMMENT ON COLUMN asistente.semanal_metas.evaluada_en IS
  'El numero del semanal que dijo como quedo. NULL = todavia no se ha dicho (el semanal de esa semana no ha salido).';
COMMENT ON COLUMN asistente.semanal_metas.texto IS 'La meta, como la escribio el ingeniero.';
COMMENT ON COLUMN asistente.semanal_metas.cantidad IS
  'Cuanto habia que hacer, si la meta lo dice (con su unidad); muchas metas no llevan cantidad.';
COMMENT ON COLUMN asistente.semanal_metas.estado IS
  'completada, parcial o no_completada. NULL = sin marcar.';
COMMENT ON COLUMN asistente.semanal_metas.cantidad_hecha IS
  'Lo que se hizo de una meta parcial que lleva cantidad.';
COMMENT ON COLUMN asistente.semanal_metas.porcentaje IS
  'Cuanto se hizo de una meta parcial sin cantidad, de 0 a 100.';
COMMENT ON COLUMN asistente.semanal_metas.motivo IS
  'Por que no se completo, como lo escribio el ingeniero.';

CREATE OR REPLACE VIEW asistente.semanal_problemas WITH (security_barrier) AS
SELECT s.semanal_id, s.obra_id, s.obra, s.numero, s.semana_inicio, s.semana_fin,
       p.fecha,
       p.problema,
       p.accion,
       p.pendiente
  FROM asistente.semanales s
  JOIN proyecto_reporte_semanal_problemas p ON p.reporte_id = s.semanal_id;

COMMENT ON VIEW asistente.semanal_problemas IS
  'Los problemas que conto cada semanal: lo que estorbo el trabajo esa semana, con la accion a tomar. Una fila por problema.';
COMMENT ON COLUMN asistente.semanal_problemas.fecha IS 'El dia en que paso; NULL = de toda la semana.';
COMMENT ON COLUMN asistente.semanal_problemas.problema IS
  'Lo propone la IA a partir de los diarios y el ingeniero lo corrige.';
COMMENT ON COLUMN asistente.semanal_problemas.accion IS 'Lo que se va a hacer, como lo escribio el ingeniero.';
COMMENT ON COLUMN asistente.semanal_problemas.pendiente IS
  'true = al cerrar ESA semana seguia sin resolverse y habia que seguirlo. Un semanal posterior no lo cambia: para saber que esta pendiente hoy, mira el ultimo semanal de cada obra.';

CREATE OR REPLACE VIEW asistente.semanal_decisiones WITH (security_barrier) AS
SELECT s.semanal_id, s.obra_id, s.obra, s.numero, s.semana_inicio, s.semana_fin,
       d.texto
  FROM asistente.semanales s
  JOIN proyecto_reporte_semanal_decisiones d ON d.reporte_id = s.semanal_id;

COMMENT ON VIEW asistente.semanal_decisiones IS
  'Las decisiones que cada semanal le pidio a la oficina: una fila por decision, como la escribio el ingeniero.';

GRANT SELECT ON asistente.semanales, asistente.semanal_metas, asistente.semanal_problemas,
  asistente.semanal_decisiones TO asistente_lector;
