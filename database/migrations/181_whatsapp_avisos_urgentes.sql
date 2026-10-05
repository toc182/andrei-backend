-- 181_whatsapp_avisos_urgentes.sql
--
-- El WhatsApp de las solicitudes URGENTES: cuando una llega al turno de
-- alguien, le sale un mensaje con un boton «Aprobar» que abre la solicitud en
-- el sistema, donde se aprueba con la contraseña de siempre. Decision de Ivan
-- del 2026-10-05: solo las urgentes («me llegaria un monton de mensajes»), solo
-- a quien le toca firmar ahora, y la aprobacion no se hace en WhatsApp.
--
-- Una fila por aviso. Sirve para dos cosas: saber que salio y a quien, y que
-- el mismo turno no se avise dos veces (dos llamadas por el mismo cambio, o dos
-- servidores durante un despliegue). El turno se dice con tres datos:
--
--   turno   el lugar en la cadena de aprobadores (1, 2, 3...)
--   ronda   solicitudes_pago.updated_at en ese momento. Aprobar no lo cambia;
--           reenviar una rechazada si. Asi una solicitud rechazada y reenviada
--           vuelve a avisarle al primero, y dos llamadas por la misma
--           aprobacion no le avisan dos veces al siguiente.

CREATE TABLE IF NOT EXISTS whatsapp_avisos_urgentes (
  id SERIAL PRIMARY KEY,
  solicitud_pago_id INTEGER NOT NULL REFERENCES solicitudes_pago(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  turno INTEGER NOT NULL,
  ronda TIMESTAMP NOT NULL,
  telefono VARCHAR(20) NOT NULL,
  -- NULL mientras sale; false si Meta lo rechazo (el error queda en
  -- whatsapp_mensajes, con el resto de lo que se manda).
  salio BOOLEAN,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_whatsapp_aviso_urgente UNIQUE (solicitud_pago_id, user_id, turno, ronda)
);
