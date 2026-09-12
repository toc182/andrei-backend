-- 163_reporte_borrador.sql
-- Un reporte no existe hasta que está completo.
--
-- Decisión del dueño del producto, literal: «si las fotos no se suben, no hay
-- reporte, punto». Hasta ahora el reporte se creaba en cuanto el ingeniero
-- pulsaba Guardar y las fotos subían después; si la subida fallaba quedaba un
-- reporte a medias, visible para todos. El 2026-09-10 eso dejó tres copias del
-- mismo día en producción.
--
-- Ahora nace en borrador y solo pasa a existir cuando las fotos terminaron.
-- Mientras es borrador no se ve en NINGUNA parte: ni lista, ni detalle, ni
-- PDF, ni la cola de correo, ni el aviso de «ya reportaste esta fecha», ni el
-- desplegable de meses.
ALTER TABLE proyecto_reportes
  ADD COLUMN IF NOT EXISTS completo BOOLEAN NOT NULL DEFAULT TRUE;

-- El DEFAULT TRUE es deliberado y es la línea más importante del archivo: los
-- reportes que ya existen quedan completos y siguen viéndose. Si naciera en
-- FALSE, los 200 y pico reportes de producción desaparecerían de golpe.
-- Las filas nuevas pasan completo = FALSE de forma explícita desde el código.

-- El número pasa a asignarse AL COMPLETAR, no al crear.
--
-- Por qué: el número sale de contar los reportes que ya hay de ese proyecto y
-- esa fecha. Si un borrador abandonado se quedara con el suyo, el siguiente
-- intento del ingeniero saldría como «-2», que es exactamente el síntoma que
-- este cambio viene a eliminar. Un borrador no gasta número.
ALTER TABLE proyecto_reportes
  ALTER COLUMN numero DROP NOT NULL;

-- uq_proyecto_reportes_numero se queda como está: única sobre toda la tabla y
-- SIN predicado.
--
-- Da la tentación de volverla parcial (WHERE completo) ahora que hay filas sin
-- número, y sería un error. En Postgres los NULL no chocan entre sí en un
-- índice único, así que los borradores ya conviven sin tocar nada. Hacerla
-- parcial solo movería el choque de números del momento de guardar —donde el
-- ingeniero ve el error y puede reaccionar— al momento de completar, cuando ya
-- subió doce fotos con datos móviles desde la obra. Es la peor permuta posible.

-- Los borradores se buscan por dos motivos: para completarlos y para barrer los
-- que quedaron abandonados. Los dos preguntan lo mismo y son pocas filas.
CREATE INDEX IF NOT EXISTS idx_proyecto_reportes_borradores
  ON proyecto_reportes (created_at)
  WHERE completo = FALSE;
