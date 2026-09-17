-- 170_whatsapp_entrada.sql
-- Lo que hace falta para RECIBIR en el sistema lo que un ingeniero le manda al
-- WhatsApp de la empresa. Todavia no contesta nada util: esto es la puerta y el
-- registro, que es lo unico que se puede probar sin el asistente.

-- El WhatsApp de cada persona. Es como el sistema sabe quien escribe: WhatsApp
-- garantiza el numero de quien manda, asi que un numero registrado identifica a
-- su dueno sin contrasena. A un numero desconocido no se le contesta nada del
-- negocio.
--
-- Se guarda como lo manda Meta: solo digitos, con codigo de pais y sin el «+»
-- (50766199092). Cualquier otra forma —«6619-9092», «+507 6619 9092»— no
-- coincidiria nunca con lo que llega.
ALTER TABLE users ADD COLUMN IF NOT EXISTS whatsapp VARCHAR(20);

-- Unico, pero solo entre los que tienen numero: dos personas no pueden compartir
-- el mismo WhatsApp —el sistema no sabria de quien es el reporte— y los NULL no
-- chocan entre si en un indice parcial.
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_whatsapp
  ON users (whatsapp) WHERE whatsapp IS NOT NULL;

-- Todo lo que entra y todo lo que sale, con su foto si la trae.
--
-- No es un registro de auditoria ni una bitacora bonita: es la unica manera de
-- averiguar por que una conversacion salio mal, porque del lado del telefono
-- solo esta el chat y ahi no se ve que entendio el sistema.
CREATE TABLE IF NOT EXISTS whatsapp_mensajes (
  id SERIAL PRIMARY KEY,
  direccion VARCHAR(10) NOT NULL,
  -- El id que le pone WhatsApp al mensaje. Es la defensa contra los repetidos:
  -- Meta reintenta una entrega hasta que le contestemos 200, y avisa que puede
  -- mandar la misma dos veces.
  wa_id VARCHAR(160),
  -- Siempre el numero del ingeniero, mande el o le mandemos nosotros: asi la
  -- conversacion se lee entera filtrando por una sola columna.
  telefono VARCHAR(20) NOT NULL,
  -- Quien es, si el numero esta registrado. Null = desconocido, y se guarda
  -- igual: si alguien escribe y no le contestamos, hay que poder verlo.
  user_id INTEGER REFERENCES users(id),
  tipo VARCHAR(20) NOT NULL,
  texto TEXT,
  -- La foto ya copiada a R2. Meta borra la suya a los 7 dias, asi que la copia
  -- se hace al recibirla y no cuando haga falta.
  r2_key VARCHAR(500),
  tipo_mime VARCHAR(100),
  tamano INTEGER,
  -- Lo que salio mal con ESTE mensaje: la foto que no se pudo bajar, el envio
  -- que Meta rechazo. Que quede en la fila y no solo en los registros del
  -- servidor, que se pierden.
  error TEXT,
  -- El sobre entero como lo mando Meta. Cuando algo no cuadre, aqui esta lo que
  -- de verdad llego, sin depender de lo que el codigo supo leer ese dia.
  payload JSONB,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_whatsapp_mensajes_direccion
    CHECK (direccion IN ('entrante', 'saliente'))
);

-- Parcial porque un mensaje que no llego a salir no tiene id de WhatsApp, y
-- varios sin id no deben chocar entre si.
CREATE UNIQUE INDEX IF NOT EXISTS uq_whatsapp_mensajes_wa_id
  ON whatsapp_mensajes (wa_id) WHERE wa_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_whatsapp_mensajes_telefono
  ON whatsapp_mensajes (telefono, created_at DESC);
