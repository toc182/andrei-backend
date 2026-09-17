// La conversacion de una persona con el asistente: abrirla, leerla y cerrarla.
//
// Una conversacion dura mientras la persona siga en lo suyo. Si pasa medio dia
// sin escribir, la que habia se cierra y la siguiente vez empieza de cero: un
// «sí» de ayer no puede contestar la pregunta de hoy.

import { query } from '../../database/config.js';
import type { DatosReporte } from './datosReporte.js';

/** Cuanto aguanta una conversacion sin que nadie escriba. */
const HORAS_DE_VIDA = 12;

export type Modo = 'libre' | 'reporte_diario';

export interface Conversacion {
  id: number;
  userId: number;
  telefono: string;
  modo: Modo;
  proyectoId: number | null;
  datos: DatosReporte;
  reporteId: number | null;
}

interface FilaConversacion {
  id: number;
  user_id: number;
  telefono: string;
  modo: Modo;
  proyecto_id: number | null;
  datos: DatosReporte;
  reporte_id: number | null;
}

const desdeFila = (f: FilaConversacion): Conversacion => ({
  id: f.id,
  userId: f.user_id,
  telefono: f.telefono,
  modo: f.modo,
  proyectoId: f.proyecto_id,
  datos: f.datos ?? {},
  reporteId: f.reporte_id,
});

/**
 * La conversacion viva de ese numero, abriendo una si no hay.
 *
 * Cerrar la vieja y abrir la nueva va en la misma consulta que la busca, para
 * que dos entregas de Meta a la vez no abran dos conversaciones: el indice
 * unico parcial no dejaria, y una de las dos se caeria.
 */
export async function conversacionViva(
  telefono: string,
  userId: number,
): Promise<Conversacion> {
  await query(
    `UPDATE whatsapp_conversaciones
        SET activa = false
      WHERE telefono = $1 AND activa
        AND ultima_actividad < CURRENT_TIMESTAMP - ($2 || ' hours')::interval`,
    [telefono, String(HORAS_DE_VIDA)],
  );

  const viva = await query<FilaConversacion>(
    `SELECT id, user_id, telefono, modo, proyecto_id, datos, reporte_id
       FROM whatsapp_conversaciones
      WHERE telefono = $1 AND activa`,
    [telefono],
  );
  if (viva.rows[0]) return desdeFila(viva.rows[0]);

  const nueva = await query<FilaConversacion>(
    `INSERT INTO whatsapp_conversaciones (user_id, telefono)
     VALUES ($1, $2)
     ON CONFLICT (telefono) WHERE activa DO NOTHING
     RETURNING id, user_id, telefono, modo, proyecto_id, datos, reporte_id`,
    [userId, telefono],
  );
  if (nueva.rows[0]) return desdeFila(nueva.rows[0]);

  // La abrio otra entrega entre medias: la de esa vale igual.
  const otra = await query<FilaConversacion>(
    `SELECT id, user_id, telefono, modo, proyecto_id, datos, reporte_id
       FROM whatsapp_conversaciones
      WHERE telefono = $1 AND activa`,
    [telefono],
  );
  return desdeFila(otra.rows[0]);
}

/** Guarda lo que cambio de la conversacion. Lo que no se pasa, no se toca. */
export async function guardarConversacion(
  id: number,
  cambios: {
    modo?: Modo;
    proyectoId?: number | null;
    datos?: DatosReporte;
    reporteId?: number | null;
  },
): Promise<void> {
  const campos: string[] = ['ultima_actividad = CURRENT_TIMESTAMP'];
  const valores: unknown[] = [];
  let i = 1;

  if (cambios.modo !== undefined) {
    campos.push(`modo = $${i++}`);
    valores.push(cambios.modo);
  }
  if (cambios.proyectoId !== undefined) {
    campos.push(`proyecto_id = $${i++}`);
    valores.push(cambios.proyectoId);
  }
  if (cambios.datos !== undefined) {
    campos.push(`datos = $${i++}::jsonb`);
    valores.push(JSON.stringify(cambios.datos));
  }
  if (cambios.reporteId !== undefined) {
    campos.push(`reporte_id = $${i++}`);
    valores.push(cambios.reporteId);
  }

  valores.push(id);
  await query(
    `UPDATE whatsapp_conversaciones SET ${campos.join(', ')} WHERE id = $${i}`,
    valores,
  );
}

/** Se acabo: el reporte salio, o la persona lo dejo. */
export async function cerrarConversacion(id: number): Promise<void> {
  await query('UPDATE whatsapp_conversaciones SET activa = false WHERE id = $1', [id]);
}

export interface MensajeGuardado {
  id: number;
  direccion: 'entrante' | 'saliente';
  texto: string | null;
  tipo: string;
  r2Key: string | null;
}

/**
 * Lo que se han dicho en esta conversacion, para que el asistente lo lea.
 *
 * Con tope: una conversacion larguisima no puede acabar mandandole al modelo
 * doscientos mensajes. Los primeros que se caen son los mas viejos, que es
 * donde menos informacion hay —lo que importa ya esta anotado en `datos`.
 */
export async function historial(
  conversacionId: number,
  tope = 40,
): Promise<MensajeGuardado[]> {
  const r = await query<{
    id: number;
    direccion: 'entrante' | 'saliente';
    texto: string | null;
    tipo: string;
    r2_key: string | null;
  }>(
    `SELECT id, direccion, texto, tipo, r2_key
       FROM whatsapp_mensajes
      WHERE conversacion_id = $1
      ORDER BY id DESC
      LIMIT $2`,
    [conversacionId, tope],
  );
  return r.rows
    .reverse()
    .map((m) => ({ id: m.id, direccion: m.direccion, texto: m.texto, tipo: m.tipo, r2Key: m.r2_key }));
}

/** Cuantas fotos lleva mandadas en esta conversacion. */
export async function fotosDe(conversacionId: number): Promise<number> {
  const r = await query<{ n: string }>(
    `SELECT count(*)::text AS n
       FROM whatsapp_mensajes
      WHERE conversacion_id = $1 AND direccion = 'entrante'
        AND r2_key IS NOT NULL AND tipo IN ('image', 'document')`,
    [conversacionId],
  );
  return Number(r.rows[0]?.n ?? 0);
}
