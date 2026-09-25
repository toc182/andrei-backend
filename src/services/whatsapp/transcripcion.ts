// La nota de voz, pasada a texto.
//
// El ingeniero habla desde la obra y el asistente lee. Nada de esto toca al
// modelo que redacta: cuando la nota llega aqui, se convierte en el texto del
// mensaje y a partir de ahi la conversacion sigue como si lo hubiera escrito.
//
// Quien transcribe es OpenAI (Whisper). Sin OPENAI_API_KEY el servidor sigue
// funcionando: las notas de voz quedan sin entender y el asistente pide que se
// lo escriban, igual que cuando el audio sale mal.

import { query } from '../../database/config.js';
import { downloadFile } from '../storage.js';

const llave = (): string | undefined => process.env.OPENAI_API_KEY;
const base = (): string => process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1';
const modelo = (): string => process.env.OPENAI_MODELO_AUDIO ?? 'whisper-1';

/**
 * El tope de una nota de voz: unos doce minutos.
 *
 * WhatsApp las manda en opus a algo menos de 2 KB por segundo, asi que el
 * tamano es la unica medida de la duracion que tenemos antes de pagar por
 * transcribirla.
 */
export const MAX_BYTES = 1_500_000;

/**
 * Lo que Whisper se inventa cuando no hay voz: silencio o ruido le sacan
 * siempre las mismas frases de subtitulos. Si se colaran, el asistente
 * anotaria en el reporte que alguien agradecio ver un video.
 */
const INVENTADAS = [
  'subtitulos realizados por la comunidad de amara.org',
  'subtitulos por la comunidad de amara.org',
  'subtitulado por la comunidad de amara.org',
  'mas informacion en www.alimmenta.com',
  'gracias por ver el video',
  'gracias por ver el video!',
  'suscribete al canal',
];

/** Sin tildes, sin signos y en minusculas, para comparar frases. */
function plano(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .trim();
}

export type Transcripcion =
  | { ok: true; texto: string }
  | { ok: false; motivo: 'sin_llave' | 'muy_larga' | 'no_entendi' | 'fallo' };

/**
 * Pasa un audio a texto.
 *
 * `vocabulario` son las palabras propias de esa obra —sus areas, sus maquinas,
 * sus puestos—. Whisper las usa como pista, que es la diferencia entre «Torre
 * Pendulo» y «torre péndulo» o entre «la retro» y «la retro» convertida en otra
 * cosa. No es una lista cerrada: solo inclina lo que ya oyo.
 */
export async function transcribir(
  audio: Buffer,
  nombre: string,
  vocabulario?: string,
): Promise<Transcripcion> {
  const clave = llave();
  if (!clave) return { ok: false, motivo: 'sin_llave' };
  if (audio.length > MAX_BYTES) return { ok: false, motivo: 'muy_larga' };

  const cuerpo = new FormData();
  cuerpo.append('file', new Blob([new Uint8Array(audio)]), nombre);
  cuerpo.append('model', modelo());
  cuerpo.append('language', 'es');
  if (vocabulario) cuerpo.append('prompt', vocabulario);

  let texto: string;
  try {
    const r = await fetch(`${base()}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${clave}` },
      body: cuerpo,
    });
    if (!r.ok) {
      console.error(`[whatsapp] la transcripcion fallo con ${r.status}`);
      return { ok: false, motivo: 'fallo' };
    }
    const datos = (await r.json()) as { text?: unknown };
    texto = typeof datos.text === 'string' ? datos.text.trim() : '';
  } catch (e) {
    console.error('[whatsapp] no se pudo transcribir:', (e as Error).message);
    return { ok: false, motivo: 'fallo' };
  }

  if (!texto || INVENTADAS.some((f) => plano(f) === plano(texto))) {
    return { ok: false, motivo: 'no_entendi' };
  }
  return { ok: true, texto };
}

/** Las palabras de esa obra, para que Whisper las escriba como son. */
export async function vocabularioDe(proyectoId: number): Promise<string | undefined> {
  // La importacion va aqui dentro a proposito: herramientas.ts tira de
  // entrantes.ts, y entrantes.ts llama a este archivo cuando llega una nota de
  // voz. Cargarlo al arrancar cerraria ese circulo.
  const { listasDe } = await import('./herramientas.js');
  const listas = await listasDe(proyectoId);
  const nombres = [
    ...listas.areas.map((a) => a.nombre),
    ...listas.equipos.map((e) => e.nombre),
    ...listas.puestos.map((p) => p.nombre),
    ...listas.categorias.map((c) => c.nombre),
  ];
  if (nombres.length === 0) return undefined;
  // Whisper solo atiende a las primeras frases del prompt, asi que va corto y
  // con los nombres propios primero.
  return `Reporte de obra en Panamá. Nombres propios: ${nombres.join(', ')}.`.slice(0, 600);
}

/**
 * Lee una nota de voz recien llegada, sin esperar al turno del asistente.
 *
 * Es lo que hace que la respuesta llegue antes: cuando el asistente va a
 * pensar, la nota ya es texto. Si falla, no pasa nada —queda pendiente y el
 * turno la vuelve a intentar—.
 */
export async function leerNotaRecienLlegada(filaId: number): Promise<void> {
  const fila = await query<{ r2_key: string | null; proyecto_id: number | null }>(
    `SELECT m.r2_key, c.proyecto_id
       FROM whatsapp_mensajes m
       LEFT JOIN whatsapp_conversaciones c ON c.telefono = m.telefono AND c.activa
      WHERE m.id = $1`,
    [filaId],
  );
  const r2Key = fila.rows[0]?.r2_key;
  if (!r2Key) return;
  const vocabulario =
    fila.rows[0]?.proyecto_id === null || fila.rows[0]?.proyecto_id === undefined
      ? undefined
      : await vocabularioDe(fila.rows[0].proyecto_id);
  const audio = await downloadFile(r2Key);
  const r = await transcribir(audio, `nota-${filaId}.ogg`, vocabulario);
  if (r.ok) {
    await query('UPDATE whatsapp_mensajes SET texto = $2 WHERE id = $1', [filaId, r.texto]);
    return;
  }
  // Un fallo pasajero no se marca: la nota queda pendiente y el turno la
  // vuelve a intentar. Lo que no tiene arreglo —muy larga, no se entendio— si.
  if (r.motivo === 'fallo') return;
  await query('UPDATE whatsapp_mensajes SET error = $2 WHERE id = $1', [
    filaId,
    MOTIVOS[r.motivo] ?? r.motivo,
  ]);
}

/** Espera a que el audio este guardado, hasta unos segundos. */
async function esperarArchivo(
  filaId: number,
  clave: string | null,
  intentos = 10,
): Promise<string | null> {
  if (clave) return clave;
  for (let i = 0; i < intentos; i += 1) {
    await new Promise((r) => setTimeout(r, 500));
    const r = await query<{ r2_key: string | null; error: string | null }>(
      'SELECT r2_key, error FROM whatsapp_mensajes WHERE id = $1',
      [filaId],
    );
    if (r.rows[0]?.r2_key) return r.rows[0].r2_key;
    // Si al bajarlo de Meta fallo, ya quedo dicho en la fila: no hay que esperar mas.
    if (r.rows[0]?.error) return null;
  }
  return null;
}

/** Lo que se le dice a la persona cuando su nota de voz no se pudo leer. */
const MOTIVOS: Record<string, string> = {
  sin_llave: 'no se pueden leer notas de voz en este servidor',
  muy_larga: 'la nota de voz es demasiado larga',
  no_entendi: 'no se entendió la nota de voz',
  fallo: 'no se pudo leer la nota de voz',
  sin_archivo: 'la nota de voz no llegó a guardarse',
};

/**
 * Pasa a texto las notas de voz de esta conversacion que aun no lo estan.
 *
 * La red de seguridad: lo normal es que ya se hayan leido al llegar
 * (leerNotaRecienLlegada). Aqui se recogen las que no —porque el archivo
 * tardo, porque la transcripcion fallo— antes de que el asistente piense.
 */
export async function transcribirNotasDeVoz(conversacion: {
  id: number;
  proyectoId: number | null;
}): Promise<void> {
  const pendientes = await query<{ id: number; r2_key: string | null }>(
    `SELECT id, r2_key FROM whatsapp_mensajes
      WHERE conversacion_id = $1 AND direccion = 'entrante' AND tipo = 'audio'
        AND texto IS NULL AND error IS NULL
      ORDER BY id`,
    [conversacion.id],
  );
  if (pendientes.rows.length === 0) return;

  const vocabulario =
    conversacion.proyectoId === null ? undefined : await vocabularioDe(conversacion.proyectoId);

  for (const fila of pendientes.rows) {
    const motivo = await (async (): Promise<string | null> => {
      // La copia del audio a R2 va por su cuenta al recibirlo y puede no haber
      // terminado. Se le espera un poco; si aun asi no esta, la nota se queda
      // pendiente —sin marcarla como fallida— y se lee en el siguiente turno.
      const clave = await esperarArchivo(fila.id, fila.r2_key);
      if (!clave) return null;
      const audio = await downloadFile(clave);
      const r = await transcribir(audio, `nota-${fila.id}.ogg`, vocabulario);
      if (!r.ok) return r.motivo;
      await query('UPDATE whatsapp_mensajes SET texto = $2 WHERE id = $1', [fila.id, r.texto]);
      return null;
    })();
    if (motivo) {
      await query('UPDATE whatsapp_mensajes SET error = $2 WHERE id = $1', [
        fila.id,
        MOTIVOS[motivo] ?? motivo,
      ]);
    }
  }
}
