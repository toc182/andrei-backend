// El que atiende los mensajes que llegaron.
//
// No se contesta en cuanto entra un mensaje, sino cuando la persona lleva unos
// segundos callada. En WhatsApp una idea llega partida en trozos —seis fotos,
// y luego «eso fue todo lo de hoy»— y contestar a cada trozo seria una
// conversacion imposible. Esos segundos son WHATSAPP_ESPERA_MS.

import { pool, query } from '../../database/config.js';
import { conversar } from './asistente.js';
import {
  conversacionViva,
  fotosDe,
  historial,
  type Conversacion,
} from './conversacion.js';
import { responder } from './entrantes.js';
import { marcarLeidoYEscribiendo } from './cliente.js';
import { transcribirNotasDeVoz } from './transcripcion.js';
import type { Usuario } from './herramientas.js';

/**
 * Lo que se espera a que la persona termine de escribir.
 *
 * Tres segundos desde el 2026-09-26 (fueron ocho y luego cinco). Para lo que
 * sirve de verdad es para las fotos: treinta y una fotos son treinta y un
 * mensajes, y sin esta espera el asistente contestaria a cada una. Quien
 * escribe de corrido no la necesita, y por eso se acorto.
 */
const ESPERA_MS = Number(process.env.WHATSAPP_ESPERA_MS ?? 3000);

/** Cada cuanto se mira si hay algo que atender. */
const TIC_MS = Number(process.env.WHATSAPP_TIC_MS ?? 2000);

/** Cuantas veces se reintenta un mensaje que revento antes de rendirse. */
const MAX_INTENTOS = 3;

const NO_PUDE =
  'Se me complicó atenderte ahora mismo. Vuelve a escribirme en un momento, por favor.';

interface Pendiente {
  telefono: string;
  user_id: number;
}

/** Los numeros que tienen algo sin atender y ya llevan un rato callados. */
async function numerosPendientes(): Promise<Pendiente[]> {
  const r = await query<Pendiente>(
    `SELECT telefono, min(user_id) AS user_id
       FROM whatsapp_mensajes
      WHERE direccion = 'entrante'
        AND procesado_at IS NULL
        AND user_id IS NOT NULL
        AND intentos < $2
      GROUP BY telefono
     HAVING max(created_at) < CURRENT_TIMESTAMP - ($1 || ' milliseconds')::interval`,
    [String(ESPERA_MS), MAX_INTENTOS],
  );
  return r.rows;
}

/**
 * Coge el turno de ese numero, si nadie mas lo tiene.
 *
 * Con un cerrojo de Postgres y no con una columna: en Railway puede haber dos
 * procesos a la vez durante un despliegue, y los dos verian los mismos
 * mensajes pendientes.
 *
 * El cerrojo se pide y se suelta SOBRE LA MISMA CONEXION, sacada del pool a
 * mano. Es la trampa de este mecanismo: un cerrojo de sesion pertenece a la
 * conexion que lo pidio, y si el «suelta» sale por otra —que es lo que hace el
 * pool cuando le pides una consulta suelta— el cerrojo se queda puesto para
 * siempre y ese numero no se vuelve a atender. Si el proceso se muere a medias,
 * la conexion se cierra y el cerrojo se cae con ella.
 */
async function conElTurno<T>(telefono: string, hacer: () => Promise<T>): Promise<T | null> {
  const cliente = await pool.connect();
  const clave = `whatsapp:${telefono}`;
  try {
    const tomado = await cliente.query<{ tomado: boolean }>(
      'SELECT pg_try_advisory_lock(hashtext($1)) AS tomado',
      [clave],
    );
    if (!tomado.rows[0]?.tomado) return null;
    try {
      return await hacer();
    } finally {
      await cliente.query('SELECT pg_advisory_unlock(hashtext($1))', [clave]);
    }
  } finally {
    cliente.release();
  }
}

/** Los mensajes sin atender de ese numero, ya metidos en su conversacion. */
async function recoger(conversacion: Conversacion): Promise<number[]> {
  const r = await query<{ id: number }>(
    `UPDATE whatsapp_mensajes
        SET conversacion_id = $2
      WHERE direccion = 'entrante' AND procesado_at IS NULL AND telefono = $1
      RETURNING id`,
    [conversacion.telefono, conversacion.id],
  );
  return r.rows.map((x) => x.id);
}

async function marcarAtendidos(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await query(
    'UPDATE whatsapp_mensajes SET procesado_at = CURRENT_TIMESTAMP WHERE id = ANY($1::int[])',
    [ids],
  );
}

async function anotarIntento(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await query('UPDATE whatsapp_mensajes SET intentos = intentos + 1 WHERE id = ANY($1::int[])', [
    ids,
  ]);
}

/** Atiende a un numero: junta lo suyo, piensa una vez y contesta una vez. */
async function atender(p: Pendiente): Promise<void> {
  const u = await query<Usuario>(
    'SELECT id, nombre, rol FROM users WHERE id = $1 AND activo = true',
    [p.user_id],
  );
  const usuario = u.rows[0];
  if (!usuario) {
    // Le quitaron el acceso entre que escribio y ahora: no se le contesta, pero
    // tampoco se queda dando vueltas para siempre.
    const ids = await query<{ id: number }>(
      `SELECT id FROM whatsapp_mensajes
        WHERE direccion = 'entrante' AND procesado_at IS NULL AND telefono = $1`,
      [p.telefono],
    );
    await marcarAtendidos(ids.rows.map((x) => x.id));
    return;
  }

  const conversacion = await conversacionViva(p.telefono, usuario.id);
  const ids = await recoger(conversacion);
  if (ids.length === 0) return;

  // Meta solo ensena «escribiendo…» 25 segundos, y un turno con notas de voz y
  // varias vueltas de herramientas puede durar mas. Se renueva mientras dure:
  // si no, la persona ve un silencio y no sabe si le estan contestando.
  const ultimo = ids[ids.length - 1];
  const wa = await query<{ wa_id: string | null }>(
    'SELECT wa_id FROM whatsapp_mensajes WHERE id = $1',
    [ultimo],
  );
  const waId = wa.rows[0]?.wa_id ?? null;
  const escribiendo = waId
    ? setInterval(() => {
      void marcarLeidoYEscribiendo(waId).catch(() => undefined);
    }, 20_000)
    : null;

  try {
    // Las notas de voz se leen antes de pensar nada: el asistente no oye, lee.
    await transcribirNotasDeVoz(conversacion);
    const ctx = { usuario, conversacion, fotos: await fotosDe(conversacion.id) };
    const r = await conversar({ ctx, historial: await historial(conversacion.id) });
    const texto = r.texto.trim();
    if (texto) await responder(p.telefono, texto, conversacion.id);
    await marcarAtendidos(ids);
    console.log(
      `[whatsapp] ${usuario.nombre}: ${ids.length} mensaje(s) atendidos ` +
        `(${r.uso.entrada} entrada, ${r.uso.salida} salida, ${r.uso.cache} cache)`,
    );
  } catch (e) {
    await anotarIntento(ids);
    const motivo = (e as Error).message;
    console.error(`[whatsapp] no se pudo atender a ${p.telefono}: ${motivo}`);
    const agotados = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM whatsapp_mensajes
        WHERE id = ANY($1::int[]) AND intentos >= $2`,
      [ids, MAX_INTENTOS],
    );
    // Se acabaron los reintentos: mejor decirle que no se pudo que dejarlo
    // esperando una respuesta que no va a llegar.
    if (Number(agotados.rows[0]?.n ?? 0) > 0) {
      await responder(p.telefono, NO_PUDE, conversacion.id).catch(() => undefined);
      await marcarAtendidos(ids);
    }
  } finally {
    if (escribiendo) clearInterval(escribiendo);
  }
}

/** Una pasada: atiende a todos los que estan esperando. Devuelve a cuantos. */
export async function atenderPendientes(): Promise<number> {
  const pendientes = await numerosPendientes();
  let atendidos = 0;
  for (const p of pendientes) {
    const hecho = await conElTurno(p.telefono, async () => {
      await atender(p);
      return true;
    });
    if (hecho) atendidos += 1;
  }
  return atendidos;
}

let corriendo = false;
let reloj: NodeJS.Timeout | null = null;

/**
 * Arranca el trabajador. Sin llaves de WhatsApp no arranca nada: un servidor
 * sin WhatsApp no tiene que despertarse cada dos segundos.
 */
export function arrancarTrabajador(): void {
  if (reloj) return;
  reloj = setInterval(() => {
    // Sin solaparse: una pasada lenta —el modelo tarda— no puede empezar otra
    // encima, que veria los mismos mensajes.
    if (corriendo) return;
    corriendo = true;
    void atenderPendientes()
      .catch((e: Error) => console.error('[whatsapp] el trabajador falló:', e.message))
      .finally(() => {
        corriendo = false;
      });
  }, TIC_MS);
  // Que no sea lo que mantiene vivo el proceso.
  reloj.unref();
  console.log(`✅ WhatsApp: atendiendo mensajes (espera ${ESPERA_MS} ms)`);
}
