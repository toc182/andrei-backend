-- 172_whatsapp_borrador_enviado.sql
-- Cuando se le mando el PDF del borrador a la persona.
--
-- No es un dato de adorno: es lo que impide que el asistente mande el reporte
-- sin que nadie lo haya visto. La regla es «primero el borrador, despues la
-- persona dice algo, y solo entonces se puede enviar», y para comprobarla hace
-- falta saber cuando salio el borrador.
ALTER TABLE whatsapp_conversaciones
  ADD COLUMN IF NOT EXISTS borrador_enviado_at TIMESTAMP;
