-- 162_reporte_envio_reintentos.sql
-- El envío del reporte deja de depender del navegador del ingeniero.
--
-- Hasta ahora el correo lo disparaba la pantalla al terminar de subir las
-- fotos, y esperaba a que saliera. Si eso fallaba —el 2026-09-10 falló, por un
-- PDF que no se podía generar— nadie lo reintentaba: el reporte se quedaba
-- guardado y sin salir, y al ingeniero se le decía que no se había podido
-- guardar, que era mentira. Mandó el mismo reporte tres veces.
--
-- Ahora el reporte se pone en cola y el servidor lo manda por su cuenta,
-- reintentando con esperas cada vez más largas. El ingeniero no espera ni se
-- entera de que existe un correo.
--
--   envio_proximo_intento  cuándo toca el siguiente intento.
--                          NULL = no está en cola.
--   envio_intentos         cuántos van. Llegado al tope se avisa al admin.
--   envio_ultimo_error     el motivo real del último fallo, para no volver a
--                          adivinar mirando logs.
--   envio_avisado          si ya se avisó al admin, para no avisar en cada
--                          pasada del cron.
--
-- Importante: la columna nace en NULL para todo lo que ya existe. Los reportes
-- viejos sin enviar —incluidos los tres repetidos del 2026-09-10— NO entran en
-- la cola por esta migración. Encolar hacia atrás mandaría correos que nadie
-- pidió; si alguno hay que mandarlo, se manda a mano desde su pantalla.
ALTER TABLE proyecto_reportes
  ADD COLUMN IF NOT EXISTS envio_proximo_intento TIMESTAMP;

ALTER TABLE proyecto_reportes
  ADD COLUMN IF NOT EXISTS envio_intentos INTEGER NOT NULL DEFAULT 0;

ALTER TABLE proyecto_reportes
  ADD COLUMN IF NOT EXISTS envio_ultimo_error TEXT;

ALTER TABLE proyecto_reportes
  ADD COLUMN IF NOT EXISTS envio_avisado BOOLEAN NOT NULL DEFAULT FALSE;

-- El cron pregunta siempre lo mismo: qué hay en cola y ya le tocaba. El índice
-- solo cubre esas filas, que son unas pocas y por poco rato.
CREATE INDEX IF NOT EXISTS idx_proyecto_reportes_envio_cola
  ON proyecto_reportes (envio_proximo_intento)
  WHERE envio_proximo_intento IS NOT NULL AND enviado_at IS NULL;
