// src/services/partidasProyecto.ts
// A que partida del desglose pertenece cada pago.
//
// El ancla es (desglose_id, row_uid) del desglose OFICIAL del proyecto, no el
// presupuesto: los presupuestos van y vienen —y la estrella se puede mover a
// mitad de obra— mientras que el desglose es la lista de partidas del contrato.
// Asi, cambiar de presupuesto no descoloca el gasto ya clasificado.
//
// Solo son costeables las filas SIN HIJOS. Una fila con hijos es un contenedor:
// su total sube desde abajo, y meterle gasto propio seria contarlo dos veces
// (misma regla que el presupuesto y el desglose).
//
// Este modulo vive aparte de routes/costs.ts porque lo usan DOS caminos: el
// guardado de un pago a la vez y, mas adelante, el guardado por lote. Las
// comprobaciones tienen que ser las mismas en los dos, y la unica manera de que
// no se separen con el tiempo es que sean literalmente el mismo codigo.

import type { PoolClient } from 'pg';
import { query } from '../database/config.js';

const numero = (v: string | null | undefined): number => (v != null ? parseFloat(v) : 0);

/** Los centavos, en entero: comparar sumas de decimales en coma flotante deja
 *  repartos que "no cuadran" por 0.0000001. */
export const centavos = (n: number): number => Math.round(n * 100);

export interface PartidaWire {
  rowUid: string;
  item: string;
  descripcion: string;
  /** Lo que el presupuesto oficial le puso a esta partida. Es el peso con el
   *  que se reparte un gasto general: una partida que es el 20% del
   *  presupuesto carga el 20% del extintor. null = sin costo escrito, y
   *  entonces no entra en el reparto porque no hay con que calcular su parte. */
  presupuestado: number | null;
  /** El grupo del que cuelga, para poder repartir solo dentro de una seccion.
   *  null en las partidas que van sueltas en la raiz. */
  seccionUid: string | null;
}

export interface SeccionWire {
  rowUid: string;
  item: string;
  descripcion: string;
  partidas: number;
}

export interface PartidasDelProyecto {
  desgloseId: number;
  partidas: PartidaWire[];
  secciones: SeccionWire[];
}

/** Una linea de reparto de un pago. item/descripcion van en null cuando la fila
 *  ya no esta en el desglose: la partida se borro despues de asignarla. */
export interface PartidaAsignadaWire {
  rowUid: string;
  item: string | null;
  descripcion: string | null;
  monto: number;
}

export interface LineaPartida {
  rowUid: string;
  monto: number;
}

/** Un reparto que no se puede guardar, con el motivo ya escrito para el usuario.
 *  Las rutas lo traducen a un 400 con ese mismo mensaje. */
export class RepartoInvalidoError extends Error {}

/** El desglose oficial del proyecto, sus filas costeables y las secciones que
 *  las agrupan. null si el proyecto no tiene desglose. */
export async function partidasDelProyecto(
  proyectoId: number,
): Promise<PartidasDelProyecto | null> {
  const d = await query<{ id: number }>(
    `SELECT id FROM desgloses
      WHERE proyecto_id = $1 AND tipo = 'oficial' AND activo = TRUE
      ORDER BY id LIMIT 1`,
    [proyectoId],
  );
  if (!d.rows.length) return null;
  const desgloseId = d.rows[0].id;

  const filas = await query<{
    row_uid: string; item: string; descripcion: string; presupuestado: string | null;
    seccion_uid: string | null; seccion_item: string | null; seccion_desc: string | null;
  }>(
    `WITH presu AS (
       SELECT r.desglose_row_uid AS row_uid,
              SUM(r.cantidad * r.costo_unitario) AS presupuestado
         FROM presupuestos p
         JOIN presupuesto_renglones r ON r.presupuesto_id = p.id
        WHERE p.proyecto_id = $2 AND p.activo = TRUE AND p.es_principal = TRUE
          AND NOT EXISTS (SELECT 1 FROM presupuesto_renglones h WHERE h.parent_id = r.id)
        GROUP BY r.desglose_row_uid
     )
     SELECT i.row_uid, i.item, i.descripcion,
            pr.presupuestado::text AS presupuestado,
            g.row_uid    AS seccion_uid,
            g.item       AS seccion_item,
            g.descripcion AS seccion_desc
       FROM desglose_items i
       LEFT JOIN desglose_items g ON g.id = i.parent_id
       LEFT JOIN presu pr ON pr.row_uid = i.row_uid
      WHERE i.desglose_id = $1
        AND NOT EXISTS (SELECT 1 FROM desglose_items h WHERE h.parent_id = i.id)
      ORDER BY i.orden`,
    [desgloseId, proyectoId],
  );

  const secciones: SeccionWire[] = [];
  for (const f of filas.rows) {
    if (f.seccion_uid == null) continue;
    const ya = secciones.find((s) => s.rowUid === f.seccion_uid);
    if (ya) ya.partidas++;
    else {
      secciones.push({
        rowUid: f.seccion_uid,
        item: f.seccion_item ?? '',
        descripcion: f.seccion_desc ?? '',
        partidas: 1,
      });
    }
  }

  return {
    desgloseId,
    partidas: filas.rows.map((f) => ({
      rowUid: f.row_uid,
      item: f.item,
      descripcion: f.descripcion,
      presupuestado: f.presupuestado != null ? numero(f.presupuestado) : null,
      seccionUid: f.seccion_uid,
    })),
    secciones,
  };
}

/** Lo que llega por la red convertido en lineas de verdad, o un error con el
 *  motivo. No comprueba la suma: eso depende del monto del pago. */
export function normalizarLineas(
  crudas: { rowUid?: unknown; monto?: unknown }[],
  validas: Set<string>,
): LineaPartida[] {
  const lineas: LineaPartida[] = [];
  for (const l of crudas) {
    const rowUid = typeof l.rowUid === 'string' ? l.rowUid : '';
    const monto = typeof l.monto === 'number' ? l.monto : NaN;
    if (!validas.has(rowUid)) {
      throw new RepartoInvalidoError('Esa partida no está en el desglose del proyecto');
    }
    if (!Number.isFinite(monto) || centavos(monto) <= 0) {
      throw new RepartoInvalidoError('Cada partida necesita un monto mayor que cero');
    }
    if (lineas.some((x) => x.rowUid === rowUid)) {
      throw new RepartoInvalidoError('Esa partida está repetida en el reparto');
    }
    lineas.push({ rowUid, monto });
  }
  return lineas;
}

/** Lista vacia = dejarlo sin clasificar, y eso si vale. Con lineas, la suma
 *  tiene que dar el monto del pago: un reparto a medias haria que el gasto por
 *  partida no cuadrase con el total gastado, y las dos cifras de la pantalla se
 *  contradirian. */
export function comprobarSuma(lineas: LineaPartida[], montoTotalCentavos: number): void {
  if (lineas.length === 0) return;
  const suma = lineas.reduce((s, l) => s + centavos(l.monto), 0);
  if (suma !== montoTotalCentavos) {
    throw new RepartoInvalidoError('El reparto tiene que sumar exactamente el monto del pago');
  }
}

/** Guarda el reparto de UN pago dentro de una transaccion ya abierta.
 *
 *  Vuelve a comprobarlo todo aunque quien llama ya lo haya hecho: es la ultima
 *  puerta antes de la base, la usan dos caminos distintos, y uno de ellos
 *  recibe la propuesta de fuera. */
export async function aplicarPartidasDePago(
  client: PoolClient,
  args: {
    solicitudId: number;
    desgloseId: number;
    lineas: LineaPartida[];
    montoTotalCentavos: number;
    validas: Set<string>;
    userId: number;
  },
): Promise<void> {
  const { solicitudId, desgloseId, lineas, montoTotalCentavos, validas, userId } = args;

  const limpias = normalizarLineas(lineas, validas);
  comprobarSuma(limpias, montoTotalCentavos);

  await client.query(
    'DELETE FROM solicitud_pago_partidas WHERE solicitud_pago_id = $1',
    [solicitudId],
  );
  for (const l of limpias) {
    await client.query(
      `INSERT INTO solicitud_pago_partidas
         (solicitud_pago_id, desglose_id, row_uid, monto, creado_por)
       VALUES ($1, $2, $3, $4, $5)`,
      [solicitudId, desgloseId, l.rowUid, l.monto, userId],
    );
  }
}

/** El reparto de un pago tal como lo pinta la pantalla. LEFT JOIN a proposito:
 *  si la fila desaparecio del desglose, la linea sigue aqui con el nombre vacio
 *  y la pantalla la trata como pendiente de volver a asignar. */
export async function leerPartidasDePago(
  solicitudId: number,
): Promise<PartidaAsignadaWire[]> {
  const guardadas = await query<{
    row_uid: string; monto: string; item: string | null; descripcion: string | null;
  }>(
    `SELECT sp.row_uid, sp.monto::text AS monto, i.item, i.descripcion
       FROM solicitud_pago_partidas sp
       LEFT JOIN desglose_items i
              ON i.desglose_id = sp.desglose_id AND i.row_uid = sp.row_uid
      WHERE sp.solicitud_pago_id = $1
      ORDER BY sp.id`,
    [solicitudId],
  );
  return guardadas.rows.map((g) => ({
    rowUid: g.row_uid,
    item: g.item,
    descripcion: g.descripcion,
    monto: numero(g.monto),
  }));
}
