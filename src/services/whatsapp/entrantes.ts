// Lo que llega del WhatsApp de la empresa: leerlo, guardarlo y quedarse con las
// fotos antes de que Meta las borre.
//
// Aqui NO se contesta a quien esta registrado: su mensaje se guarda pendiente y
// lo atiende el trabajador unos segundos despues, cuando la persona deja de
// escribir (trabajador.ts). A un numero desconocido si se le contesta aqui
// mismo, una sola vez, porque con el no hay nada que esperar.

import { query } from '../../database/config.js';
import { uploadFile } from '../storage.js';
import {
  descargarMedia,
  enviarBotones,
  enviarDocumento,
  enviarTexto,
  estaConfigurado,
  marcarLeidoYEscribiendo,
} from './cliente.js';

/** Un mensaje ya leido del sobre de Meta, sin el archivo todavia. */
export interface MensajeEntrante {
  waId: string;
  telefono: string;
  tipo: string;
  texto: string | null;
  /** El archivo, cuando el mensaje trae uno. */
  mediaId: string | null;
  /** El sobre de ese mensaje, tal cual. */
  crudo: unknown;
}

/** El aviso de Meta sobre un mensaje NUESTRO que no llego. */
interface EstadoSaliente {
  waId: string;
  error: string;
}

const esObjeto = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null;

const comoTexto = (x: unknown): string | null => (typeof x === 'string' ? x : null);

const lista = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);

/** Solo digitos: es como manda Meta los numeros y como se guardan. */
const soloDigitos = (x: string): string => x.replace(/\D/g, '');

/**
 * Saca del sobre los mensajes y los avisos de fallo.
 *
 * El sobre de Meta viene en tres capas (entry → changes → value) y puede traer
 * varios mensajes de varias personas a la vez. Leer de mas no cuesta nada;
 * suponer que solo viene uno, si.
 */
export function leerPayload(cuerpo: unknown): {
  mensajes: MensajeEntrante[];
  fallos: EstadoSaliente[];
} {
  const mensajes: MensajeEntrante[] = [];
  const fallos: EstadoSaliente[] = [];
  if (!esObjeto(cuerpo)) return { mensajes, fallos };

  for (const entrada of lista(cuerpo.entry)) {
    if (!esObjeto(entrada)) continue;
    for (const cambio of lista(entrada.changes)) {
      if (!esObjeto(cambio) || !esObjeto(cambio.value)) continue;
      const valor = cambio.value;

      for (const m of lista(valor.messages)) {
        if (!esObjeto(m)) continue;
        const waId = comoTexto(m.id);
        const de = comoTexto(m.from);
        if (!waId || !de) continue;

        const tipo = comoTexto(m.type) ?? 'desconocido';
        mensajes.push({
          waId,
          telefono: soloDigitos(de),
          tipo,
          texto: textoDe(m, tipo),
          mediaId: mediaDe(m, tipo),
          crudo: m,
        });
      }

      for (const s of lista(valor.statuses)) {
        if (!esObjeto(s)) continue;
        if (comoTexto(s.status) !== 'failed') continue;
        const waId = comoTexto(s.id);
        if (!waId) continue;
        const primero = lista(s.errors).find(esObjeto);
        fallos.push({
          waId,
          error:
            comoTexto(primero?.title) ??
            comoTexto(primero?.message) ??
            'WhatsApp no pudo entregarlo',
        });
      }
    }
  }
  return { mensajes, fallos };
}

/** Lo que la persona escribio, venga donde venga segun el tipo de mensaje. */
function textoDe(m: Record<string, unknown>, tipo: string): string | null {
  if (tipo === 'text' && esObjeto(m.text)) return comoTexto(m.text.body);
  // Una foto puede traer pie de foto, y ese pie es lo que el ingeniero quiso
  // decir de ella.
  if ((tipo === 'image' || tipo === 'document' || tipo === 'video') && esObjeto(m[tipo])) {
    return comoTexto((m[tipo] as Record<string, unknown>).caption);
  }
  if (tipo === 'button' && esObjeto(m.button)) return comoTexto(m.button.text);
  if (tipo === 'interactive' && esObjeto(m.interactive)) {
    const i = m.interactive;
    for (const clave of ['button_reply', 'list_reply']) {
      if (esObjeto(i[clave])) return comoTexto((i[clave] as Record<string, unknown>).title);
    }
    // La respuesta de un formulario dentro de WhatsApp llega en un texto con
    // JSON adentro; se guarda tal cual y quien la necesite la interpreta.
    if (esObjeto(i.nfm_reply)) return comoTexto(i.nfm_reply.response_json);
  }
  return null;
}

function mediaDe(m: Record<string, unknown>, tipo: string): string | null {
  if (!['image', 'audio', 'video', 'document', 'sticker'].includes(tipo)) return null;
  const parte = m[tipo];
  return esObjeto(parte) ? comoTexto(parte.id) : null;
}

/** La extension que le toca al archivo segun lo que diga Meta que es. */
function extension(tipoMime: string): string {
  const limpio = tipoMime.split(';')[0].trim().toLowerCase();
  const conocidas: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'audio/ogg': 'ogg',
    'audio/mpeg': 'mp3',
    'application/pdf': 'pdf',
    'video/mp4': 'mp4',
  };
  return conocidas[limpio] ?? 'bin';
}

/**
 * Donde vive en R2 lo que entra por WhatsApp.
 *
 * Por mes y por id de mensaje: cuando llega no se sabe todavia de que proyecto
 * ni de que reporte es —eso lo decide el asistente despues— asi que no puede ir
 * en la carpeta de una obra. Si acaba siendo foto de un reporte, la fila del
 * reporte apunta a esta misma direccion; el archivo no se mueve.
 */
function claveMedia(waId: string, tipoMime: string): string {
  const mes = new Date().toISOString().slice(0, 7);
  const limpio = waId.replace(/[^A-Za-z0-9_-]/g, '');
  return `whatsapp/${mes}/${limpio}.${extension(tipoMime)}`;
}

/** El dueno de un numero, si ese numero esta registrado y activo. */
async function usuarioDe(telefono: string): Promise<number | null> {
  const r = await query<{ id: number }>(
    'SELECT id FROM users WHERE whatsapp = $1 AND activo = true',
    [telefono],
  );
  return r.rows[0]?.id ?? null;
}

/**
 * Guarda el mensaje. Devuelve la fila, o null si ya estaba.
 *
 * El «ya estaba» es lo normal, no un error: Meta reintenta la entrega hasta
 * recibir un 200 y avisa que la misma puede llegar dos veces. Lo resuelve el
 * indice unico sobre wa_id, no una consulta previa, que dejaria la puerta
 * abierta entre la consulta y la insercion.
 */
async function guardarEntrante(
  m: MensajeEntrante,
  userId: number | null,
): Promise<{ id: number } | null> {
  const r = await query<{ id: number }>(
    `INSERT INTO whatsapp_mensajes
       (direccion, wa_id, telefono, user_id, tipo, texto, payload)
     VALUES ('entrante', $1, $2, $3, $4, $5, $6)
     ON CONFLICT (wa_id) WHERE wa_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [m.waId, m.telefono, userId, m.tipo, m.texto, JSON.stringify(m.crudo)],
  );
  return r.rows[0] ?? null;
}

/** Deja anotado en la fila lo que salio mal con ese mensaje. */
async function anotarError(id: number, error: string): Promise<void> {
  await query('UPDATE whatsapp_mensajes SET error = $2 WHERE id = $1', [id, error.slice(0, 500)]);
}

const esperar = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Se trae el archivo a R2.
 *
 * Con reintentos porque la unica ventana para bajarlo son siete dias, pero la
 * direccion que da Meta dura cinco minutos: si se pierde por un corte de red,
 * el que vuelve a pedirla es este bucle. Si aun asi no se puede, queda dicho en
 * la fila y el asistente podra pedirle la foto otra vez al ingeniero.
 */
async function traerMedia(filaId: number, mediaId: string): Promise<void> {
  let ultimo = 'no se pudo bajar el archivo';
  for (let intento = 0; intento < 3; intento += 1) {
    try {
      const { buffer, tipoMime, tamano } = await descargarMedia(mediaId);
      const clave = claveMedia(`${mediaId}_${filaId}`, tipoMime);
      await uploadFile(clave, buffer, tipoMime);
      await query(
        'UPDATE whatsapp_mensajes SET r2_key = $2, tipo_mime = $3, tamano = $4 WHERE id = $1',
        [filaId, clave, tipoMime, tamano],
      );
      return;
    } catch (e) {
      ultimo = (e as Error).message;
      if (intento < 2) await esperar(1000 * (intento + 1));
    }
  }
  console.error(`[whatsapp] no se pudo guardar el archivo del mensaje ${filaId}: ${ultimo}`);
  await anotarError(filaId, ultimo);
}

/** Lo que se le dice a quien escribe desde un numero que no conocemos. */
const NO_REGISTRADO =
  'Hola. Este es el asistente de Pinellas y tu número no está registrado, ' +
  'así que no puedo ayudarte por aquí. Si trabajas con nosotros, pídele a la ' +
  'oficina que registre tu WhatsApp en el sistema.';

/**
 * Manda algo y lo deja anotado, salga o no salga.
 *
 * Todo lo que sale pasa por aqui —texto, botones, un PDF— para que la
 * conversacion se pueda leer entera despues, incluido lo que no llego a salir.
 */
async function mandar(
  telefono: string,
  tipo: string,
  texto: string,
  hacer: () => Promise<string | null>,
  conversacionId?: number,
): Promise<boolean> {
  let waId: string | null = null;
  let error: string | null = null;
  try {
    waId = await hacer();
  } catch (e) {
    error = (e as Error).message;
    console.error(`[whatsapp] no se le pudo mandar ${tipo} a ${telefono}: ${error}`);
  }
  await query(
    `INSERT INTO whatsapp_mensajes
       (direccion, wa_id, telefono, tipo, texto, error, conversacion_id, procesado_at)
     VALUES ('saliente', $1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)`,
    [waId, telefono, tipo, texto, error, conversacionId ?? null],
  );
  return error === null;
}

/** Un mensaje de texto. Devuelve si salio. */
export async function responder(
  telefono: string,
  texto: string,
  conversacionId?: number,
): Promise<boolean> {
  return mandar(telefono, 'text', texto, () => enviarTexto(telefono, texto), conversacionId);
}

/** Una pregunta con botones para tocar. Devuelve si salio. */
export async function responderBotones(
  telefono: string,
  texto: string,
  botones: { id: string; titulo: string }[],
  conversacionId?: number,
): Promise<boolean> {
  return mandar(
    telefono,
    'interactive',
    texto,
    () => enviarBotones(telefono, texto, botones),
    conversacionId,
  );
}

/** Un archivo —el PDF del reporte—. Devuelve si salio. */
export async function responderDocumento(
  telefono: string,
  archivo: { nombre: string; datos: Buffer },
  pie: string,
  conversacionId?: number,
): Promise<boolean> {
  return mandar(
    telefono,
    'document',
    `${archivo.nombre}${pie ? ` — ${pie}` : ''}`,
    () => enviarDocumento(telefono, archivo, pie),
    conversacionId,
  );
}

/**
 * Todo lo que hay que hacer con un sobre de Meta.
 *
 * Se llama DESPUES de haberle contestado 200 a Meta: bajar fotos tarda, y una
 * puerta que tarda hace que Meta reintente y mande todo repetido.
 */
export async function procesarPayload(cuerpo: unknown): Promise<void> {
  const { mensajes, fallos } = leerPayload(cuerpo);

  for (const fallo of fallos) {
    await query(
      `UPDATE whatsapp_mensajes SET error = $2
        WHERE wa_id = $1 AND direccion = 'saliente'`,
      [fallo.waId, fallo.error.slice(0, 500)],
    );
  }

  for (const m of mensajes) {
    const userId = await usuarioDe(m.telefono);
    const fila = await guardarEntrante(m, userId);
    // Repetido: ya se hizo todo la primera vez.
    if (!fila) continue;

    // Que vea enseguida que se le oyo: doble check azul y «escribiendo…».
    // Va antes de bajar la foto, que es lo que mas tarda.
    if (userId !== null) {
      await marcarLeidoYEscribiendo(m.waId).catch((e: Error) =>
        console.error('[whatsapp] no se pudo marcar como leido:', e.message),
      );
    }

    if (m.mediaId) await traerMedia(fila.id, m.mediaId);

    if (userId === null) {
      // No hay nada mas que hacer con el: se le contesta —si se puede— y se da
      // por atendido, para que no se quede pendiente para siempre.
      if (estaConfigurado()) await responder(m.telefono, NO_REGISTRADO);
      await query(
        'UPDATE whatsapp_mensajes SET procesado_at = CURRENT_TIMESTAMP WHERE id = $1',
        [fila.id],
      );
    }
  }
}
