// El conector con WhatsApp (Cloud API de Meta).
//
// Las llaves son OPCIONALES, como las del correo y las del asistente de pagos:
// sin ellas el WhatsApp no existe y el resto del sistema sigue igual. Un
// servidor no se cae porque falte una funcion de conveniencia.
//
// WHATSAPP_TOKEN            el token del usuario de sistema en Meta
// WHATSAPP_PHONE_NUMBER_ID  el numero de la empresa, en id de Meta
// WHATSAPP_APP_SECRET       para comprobar la firma de lo que llega (firma.ts)
// WHATSAPP_VERIFY_TOKEN     la palabra que Meta repite al dar de alta la puerta
// WHATSAPP_API_URL          solo para las pruebas, que levantan un Meta de mentira

const API_POR_DEFECTO = 'https://graph.facebook.com/v23.0';

/** Hay llaves configuradas? */
export function estaConfigurado(): boolean {
  return Boolean(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID);
}

/** La raiz de la API. Se lee en cada llamada, no al cargar el modulo: las
 *  pruebas levantan su servidor despues de importar esto. */
const api = (): string =>
  (process.env.WHATSAPP_API_URL ?? API_POR_DEFECTO).replace(/\/$/, '');

const token = (): string => process.env.WHATSAPP_TOKEN ?? '';

/** Lo que Meta contesta cuando algo no le gusta. */
interface ErrorMeta {
  error?: { message?: string; code?: number; error_data?: { details?: string } };
}

async function leerError(res: Response): Promise<string> {
  const cuerpo = (await res.json().catch(() => null)) as ErrorMeta | null;
  const e = cuerpo?.error;
  const detalle = e?.error_data?.details ?? e?.message;
  return detalle ? `${detalle} (${res.status})` : `WhatsApp respondio ${res.status}`;
}

/** El id que WhatsApp le dio al mensaje que acabamos de mandar. */
interface Enviado {
  messages?: { id?: string }[];
}

/**
 * Manda un mensaje de texto.
 *
 * Solo sirve DENTRO de las 24 horas siguientes al ultimo mensaje de la persona,
 * que es como trabaja este asistente: siempre contesta, nunca empieza. Fuera de
 * esa ventana Meta exige una plantilla aprobada y esto devolveria error.
 */
export async function enviarTexto(telefono: string, texto: string): Promise<string | null> {
  if (!estaConfigurado()) {
    throw new Error('WhatsApp no esta configurado en este servidor');
  }
  const res = await fetch(`${api()}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: telefono,
      type: 'text',
      // Sin vista previa de enlaces: el asistente manda enlaces del sistema, y
      // la vista previa los abriria desde los servidores de Meta.
      text: { preview_url: false, body: texto },
    }),
  });
  if (!res.ok) throw new Error(await leerError(res));
  const cuerpo = (await res.json().catch(() => null)) as Enviado | null;
  return cuerpo?.messages?.[0]?.id ?? null;
}

/**
 * Manda hasta tres botones para que la persona toque en vez de escribir.
 *
 * Los titulos no pueden pasar de 20 caracteres: Meta rechaza el mensaje entero
 * si se pasan, asi que se cortan aqui y no en quien llama.
 */
export async function enviarBotones(
  telefono: string,
  texto: string,
  botones: { id: string; titulo: string }[],
): Promise<string | null> {
  if (!estaConfigurado()) {
    throw new Error('WhatsApp no esta configurado en este servidor');
  }
  const res = await fetch(`${api()}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: telefono,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: texto },
        action: {
          buttons: botones.slice(0, 3).map((b) => ({
            type: 'reply',
            reply: { id: b.id, title: b.titulo.slice(0, 20) },
          })),
        },
      },
    }),
  });
  if (!res.ok) throw new Error(await leerError(res));
  const cuerpo = (await res.json().catch(() => null)) as Enviado | null;
  return cuerpo?.messages?.[0]?.id ?? null;
}

/**
 * Sube un archivo a Meta y manda el mensaje que lo lleva.
 *
 * Son dos pasos porque Meta no acepta el archivo dentro del mensaje: primero
 * se sube y da un id, y despues el mensaje lo nombra. El id vale 30 dias, pero
 * aqui se usa al momento.
 */
export async function enviarDocumento(
  telefono: string,
  archivo: { nombre: string; datos: Buffer; tipoMime?: string },
  pie?: string,
): Promise<string | null> {
  if (!estaConfigurado()) {
    throw new Error('WhatsApp no esta configurado en este servidor');
  }
  const tipoMime = archivo.tipoMime ?? 'application/pdf';

  const formulario = new FormData();
  formulario.append('messaging_product', 'whatsapp');
  formulario.append('type', tipoMime);
  formulario.append(
    'file',
    new Blob([new Uint8Array(archivo.datos)], { type: tipoMime }),
    archivo.nombre,
  );

  const subida = await fetch(`${api()}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token()}` },
    body: formulario,
  });
  if (!subida.ok) throw new Error(await leerError(subida));
  const subido = (await subida.json().catch(() => null)) as { id?: string } | null;
  if (!subido?.id) throw new Error('Meta no devolvio el id del archivo subido');

  const res = await fetch(`${api()}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: telefono,
      type: 'document',
      document: { id: subido.id, filename: archivo.nombre, ...(pie ? { caption: pie } : {}) },
    }),
  });
  if (!res.ok) throw new Error(await leerError(res));
  const cuerpo = (await res.json().catch(() => null)) as Enviado | null;
  return cuerpo?.messages?.[0]?.id ?? null;
}


/**
 * Marca el mensaje como leido y enseña «escribiendo…» en el telefono.
 *
 * Es lo que le dice a la persona que se le va a contestar. Sin esto, entre que
 * escribe y le llega la respuesta hay un silencio en el que no sabe si el
 * asistente la oyo —se lo dijo Ivan la primera vez que lo probo.
 *
 * Dura 25 segundos o hasta que sale la respuesta, lo que pase antes. Meta no
 * lo cobra: no es un mensaje.
 */
export async function marcarLeidoYEscribiendo(waMessageId: string): Promise<void> {
  if (!estaConfigurado()) return;
  const res = await fetch(`${api()}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: waMessageId,
      typing_indicator: { type: 'text' },
    }),
  });
  if (!res.ok) throw new Error(await leerError(res));
}

/** Lo que Meta cuenta de un archivo antes de dejarlo bajar. */
interface FichaMedia {
  url?: string;
  mime_type?: string;
  file_size?: number;
}

export interface MediaBajado {
  buffer: Buffer;
  tipoMime: string;
  tamano: number;
}

/**
 * Baja una foto (o cualquier archivo) que mando el ingeniero.
 *
 * Son dos pasos: Meta primero da una direccion temporal —dura cinco minutos— y
 * despues hay que bajarla CON el token; sin el, la descarga falla aunque la
 * direccion sea correcta.
 *
 * El id del archivo vive siete dias. Por eso la copia a R2 se hace al recibirlo
 * y no el dia que haga falta.
 */
export async function descargarMedia(mediaId: string): Promise<MediaBajado> {
  if (!estaConfigurado()) {
    throw new Error('WhatsApp no esta configurado en este servidor');
  }
  const ficha = await fetch(`${api()}/${mediaId}`, {
    headers: { Authorization: `Bearer ${token()}` },
  });
  if (!ficha.ok) throw new Error(await leerError(ficha));
  const datos = (await ficha.json().catch(() => null)) as FichaMedia | null;
  if (!datos?.url) throw new Error('Meta no dio la direccion del archivo');

  const archivo = await fetch(datos.url, {
    headers: { Authorization: `Bearer ${token()}` },
  });
  if (!archivo.ok) throw new Error(await leerError(archivo));
  const buffer = Buffer.from(await archivo.arrayBuffer());

  return {
    buffer,
    tipoMime: datos.mime_type ?? archivo.headers.get('content-type') ?? 'application/octet-stream',
    tamano: datos.file_size ?? buffer.length,
  };
}
