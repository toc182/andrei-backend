-- 171_whatsapp_conversaciones.sql
-- La conversacion: en que anda cada persona con el asistente y que lleva dicho.
--
-- Hace falta porque WhatsApp no tiene pantallas ni sesion: lo unico que llega
-- es un mensaje suelto de un numero. Todo lo que en el sistema seria «estoy en
-- la pantalla de reporte nuevo, con estos campos llenos» vive aqui.

CREATE TABLE IF NOT EXISTS whatsapp_conversaciones (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  telefono VARCHAR(20) NOT NULL,
  -- 'libre' = todavia no pidio nada concreto; 'reporte_diario' = esta armando
  -- el reporte del dia. Los modos que vengan despues (recordatorios, etc.)
  -- entran aqui sin tocar la tabla.
  modo VARCHAR(30) NOT NULL DEFAULT 'libre',
  proyecto_id INTEGER REFERENCES proyectos(id),
  -- Lo que lleva contado del reporte, con la misma forma que el formulario de
  -- la pantalla. Se guarda como JSON y no en columnas porque cambia cada vez
  -- que el reporte cambie, y una conversacion a medias no es un registro de
  -- negocio: es un borrador de veinte minutos.
  datos JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- El borrador de verdad, cuando ya existe (lo crea la pieza del PDF).
  reporte_id INTEGER REFERENCES proyecto_reportes(id),
  activa BOOLEAN NOT NULL DEFAULT TRUE,
  ultima_actividad TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Una sola conversacion viva por numero: si hubiera dos, el asistente
-- contestaria con la mitad de lo que le contaron.
CREATE UNIQUE INDEX IF NOT EXISTS uq_whatsapp_conversaciones_activa
  ON whatsapp_conversaciones (telefono) WHERE activa;

CREATE INDEX IF NOT EXISTS idx_whatsapp_conversaciones_user
  ON whatsapp_conversaciones (user_id, created_at DESC);

-- A que conversacion pertenece cada mensaje, y si ya se atendio.
--
-- procesado_at nulo quiere decir «todavia no lo ha mirado el asistente». Es lo
-- que permite esperar unos segundos antes de contestar: cuando alguien manda
-- seis fotos seguidas, son seis entregas distintas y contestarle a cada una
-- seria absurdo.
ALTER TABLE whatsapp_mensajes
  ADD COLUMN IF NOT EXISTS conversacion_id INTEGER REFERENCES whatsapp_conversaciones(id);
ALTER TABLE whatsapp_mensajes
  ADD COLUMN IF NOT EXISTS procesado_at TIMESTAMP;

-- Cuantas veces se intento atenderlo. Si el modelo no contesta —se cayo la
-- red, Anthropic devolvio error— el mensaje se queda pendiente y se reintenta;
-- pero un mensaje que siempre falla no puede reintentarse para siempre, o la
-- persona no vuelve a recibir respuesta nunca.
ALTER TABLE whatsapp_mensajes
  ADD COLUMN IF NOT EXISTS intentos INTEGER NOT NULL DEFAULT 0;

-- Los mensajes de antes de esta migracion ya se atendieron en su momento; sin
-- esto, el trabajador los tomaria por pendientes y contestaria a destiempo.
UPDATE whatsapp_mensajes
   SET procesado_at = created_at
 WHERE procesado_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_whatsapp_mensajes_pendientes
  ON whatsapp_mensajes (created_at)
  WHERE direccion = 'entrante' AND procesado_at IS NULL;
