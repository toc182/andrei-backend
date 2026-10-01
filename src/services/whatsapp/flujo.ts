// El turno del reporte diario visto desde el sistema: lo que se resuelve antes
// de que piense el modelo y la pregunta que sale despues.
//
// El modelo entiende y anota; que se pregunta despues lo decide el sistema
// (preguntasFijas.ts). Decision de Ivan del 2026-09-28.

import {
  diaEnPalabras,
  fijarObra,
  hoyEnPanama,
  listasDe,
  proyectosDe,
  type Contexto,
} from './herramientas.js';
import type { MensajeGuardado } from './conversacion.js';
import { guardarConversacion } from './conversacion.js';
import { responder, responderBotones } from './entrantes.js';
import { enMinuscula, resolverRespuesta, siguientePregunta } from './preguntasFijas.js';
import { semanaCerrada } from '../semanaCerrada.js';
import { FOTOS_MAX } from '../reportePdfComun.js';

/** Las herramientas de pagos: si se usaron, se vuelve al reporte con aviso. */
const DE_PAGOS = new Set(['buscar_solicitudes', 'ver_solicitud']);

/** Lo que cuenta como foto, igual que en fotosDe (conversacion.ts). */
const ES_FOTO = new Set(['image', 'document']);

/** Lo que cabe en el cuerpo de un mensaje con botones (Meta admite 1024). */
const CUERPO_CON_BOTONES = 1000;

/** Lo que la persona escribio desde lo ultimo que le mandamos. */
function loQueDijo(historial: MensajeGuardado[]): MensajeGuardado[] {
  let ultima = -1;
  historial.forEach((m, i) => {
    if (m.direccion === 'saliente') ultima = i;
  });
  return historial.slice(ultima + 1).filter((m) => m.direccion === 'entrante');
}

/**
 * Antes del modelo: la respuesta a la pregunta fija, si es de las que no
 * necesitan criterio —«Sí» a la fecha, un numero de la lista, «nada»—.
 *
 * Devuelve si el modelo sobra en este turno, y lo que el sistema decidio y el
 * modelo tiene que decirle a la persona.
 */
export async function antesDelModelo(
  ctx: Contexto,
  historial: MensajeGuardado[],
): Promise<{ sinModelo: boolean; aviso: string | null; texto?: string }> {
  const c = ctx.conversacion;
  const dichos = loQueDijo(historial);

  // Llegaron fotos y ya pasan del tope: se le dice en este mismo turno, una
  // vez, que las de despues de la 40 no entran (Ivan, 2026-09-30).
  const llegaronFotos = dichos.some((m) => ES_FOTO.has(m.tipo));
  const pasanDelTope = c.modo === 'reporte_diario' && llegaronFotos && ctx.fotos > FOTOS_MAX;
  const avisoFotos = pasanDelTope
    ? `Ya van ${ctx.fotos} fotos y al reporte entran solo las primeras ${FOTOS_MAX}: ` +
      `las otras ${ctx.fotos - FOTOS_MAX} no. Díselo en una línea.`
    : null;
  const nada = { sinModelo: false, aviso: avisoFotos };
  if (c.modo !== 'reporte_diario' || c.borradorEnviadoAt !== null) return nada;
  if (dichos.length === 0) return nada;

  // Solo fotos: no hay nada que entender —el pie de cada una ya es su leyenda
  // (borrador.ts)—, asi que contesta el sistema y detras sale la pregunta que
  // toca, con sus botones. Con el modelo de por medio, el 28/09 ofrecio el
  // borrador con sus palabras y los botones no salieron (Ivan, 2026-10-01).
  const fotosDelTurno = dichos.filter((m) => ES_FOTO.has(m.tipo)).length;
  if (fotosDelTurno > 0 && dichos.every((m) => ES_FOTO.has(m.tipo) || m.tipo === 'unsupported')) {
    const recibidas = fotosDelTurno === 1 ? 'Recibí la foto.' : `Recibí ${fotosDelTurno} fotos.`;
    const tope = pasanDelTope
      ? ` Ya van ${ctx.fotos} y al reporte entran solo las primeras ${FOTOS_MAX}: las otras ` +
        `${ctx.fotos - FOTOS_MAX} no.`
      : '';
    return { sinModelo: true, aviso: null, texto: recibidas + tope };
  }

  const hoy = hoyEnPanama();
  const r = resolverRespuesta({
    datos: c.datos,
    dicho: dichos.map((m) => m.texto ?? '').join(' '),
    mensajes: dichos.length,
    listas: c.proyectoId === null ? null : await listasDe(c.proyectoId),
    obras: await proyectosDe(ctx.usuario),
    hoy,
    hoyEnPalabras: diaEnPalabras(hoy),
  });
  if (r.tipo === 'modelo') return nada;

  c.datos = r.datos;
  if (r.tipo === 'resuelta' && r.proyectoId !== undefined) {
    await fijarObra(c, r.proyectoId);
  } else {
    await guardarConversacion(c.id, { datos: c.datos });
  }
  return r.tipo === 'resuelta'
    ? { sinModelo: avisoFotos === null, aviso: avisoFotos }
    : { sinModelo: false, aviso: [r.aviso, avisoFotos].filter(Boolean).join(' ') };
}

/**
 * Despues del modelo: lo que dijo, y detras la pregunta que toca, en un solo
 * mensaje.
 *
 * No se pregunta nada del reporte si no hay reporte en curso, si ya se le mando
 * el borrador, si la semana de esa fecha esta cerrada, si una herramienta ya le
 * hizo una pregunta, o si el mensaje del modelo es una pregunta: entonces esta
 * aclarando algo y hay que esperar la respuesta.
 */
export async function despuesDelModelo(
  ctx: Contexto,
  r: { texto: string; herramientas: string[]; cerrado: boolean },
): Promise<void> {
  const c = ctx.conversacion;
  const texto = r.texto.trim();
  const decir = async (): Promise<void> => {
    if (texto) await responder(c.telefono, texto, c.id);
  };

  if (r.cerrado || c.modo !== 'reporte_diario' || c.borradorEnviadoAt !== null) return decir();
  if (texto.includes('?')) return decir();
  if (c.proyectoId !== null && (await semanaCerrada(c.proyectoId, c.datos.fecha ?? hoyEnPanama()))) {
    return decir();
  }

  // Una pregunta de pagos en medio del reporte: se vuelve a la misma pregunta,
  // con las mismas palabras, y no cuenta como otra vez.
  const deVuelta = r.herramientas.some((h) => DE_PAGOS.has(h));
  const veces = { ...(c.datos.veces ?? {}) };
  const ultima = c.datos.ultimaPregunta ?? null;
  if (deVuelta && ultima && veces[ultima]) veces[ultima] -= 1;

  const hoy = hoyEnPanama();
  const p = siguientePregunta({
    datos: { ...c.datos, veces },
    listas: c.proyectoId === null ? null : await listasDe(c.proyectoId),
    fotos: ctx.fotos,
    obras: await proyectosDe(ctx.usuario),
    hoyEnPalabras: diaEnPalabras(hoy),
  });
  if (!p) return decir();

  veces[p.grupo] = (veces[p.grupo] ?? 0) + 1;
  c.datos = { ...c.datos, veces, ultimaPregunta: p.grupo };
  await guardarConversacion(c.id, { datos: c.datos });

  const pregunta = deVuelta ? `Volviendo al reporte: ${enMinuscula(p.texto)}` : p.texto;
  const mensaje = texto ? `${texto}\n\n${pregunta}` : pregunta;
  if (!p.botones) {
    await responder(c.telefono, mensaje, c.id);
  } else if (mensaje.length <= CUERPO_CON_BOTONES) {
    await responderBotones(c.telefono, mensaje, p.botones, c.id);
  } else {
    await decir();
    await responderBotones(c.telefono, pregunta, p.botones, c.id);
  }
}
