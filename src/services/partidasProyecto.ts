// src/services/partidasProyecto.ts
// A que partida pertenece cada pago.
//
// El ancla es (presupuesto_id, row_uid) del presupuesto OFICIAL del proyecto.
// Antes era el desglose del contrato, y se cambio porque un desglose puede
// tener 8 lineas: con eso no se controla un costo. El detalle esta en el
// presupuesto (Ivan, 2026-09-10; migracion 161).
//
// Que la clasificacion guarde SU presupuesto es lo que hace seguro mover la
// estrella: las lineas del presupuesto anterior dejan de casar y todo aparece
// en cero, pero no se borran. Volver a marcarlo las devuelve.
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
  /** Lo que el presupuesto le puso a esta partida: cantidad x costo unitario.
   *  Es el peso con el que se reparte un gasto general — una partida que es el
   *  20% del presupuesto carga el 20% del extintor. null = sin costo escrito, y
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
  presupuestoId: number;
  partidas: PartidaWire[];
  secciones: SeccionWire[];
}

/** Una linea de reparto de un pago. item/descripcion van en null cuando la fila
 *  ya no esta en el presupuesto: o se borro despues de asignarla, o la estrella
 *  se movio a otro presupuesto y esta linea es del anterior. */
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

/** El presupuesto oficial del proyecto, sus filas costeables y las secciones
 *  que las agrupan. null si el proyecto no tiene presupuesto oficial — y
 *  entonces no hay a que clasificar, igual que antes pasaba sin desglose.
 *
 *  Costeable = fila SIN HIJOS. Una fila con hijos es un contenedor: su total
 *  sube desde abajo y meterle gasto propio seria contarlo dos veces. */
export async function partidasDelProyecto(
  proyectoId: number,
): Promise<PartidasDelProyecto | null> {
  const p = await query<{ id: number }>(
    `SELECT id FROM presupuestos
      WHERE proyecto_id = $1 AND activo = TRUE AND es_principal = TRUE
      ORDER BY id LIMIT 1`,
    [proyectoId],
  );
  if (!p.rows.length) return null;
  const presupuestoId = p.rows[0].id;

  const filas = await query<{
    row_uid: string; item: string; descripcion: string; presupuestado: string | null;
    seccion_uid: string | null; seccion_item: string | null; seccion_desc: string | null;
  }>(
    `SELECT r.row_uid, r.codigo AS item, r.descripcion,
            (r.cantidad * r.costo_unitario)::text AS presupuestado,
            g.row_uid     AS seccion_uid,
            g.codigo      AS seccion_item,
            g.descripcion AS seccion_desc
       FROM presupuesto_renglones r
       LEFT JOIN presupuesto_renglones g ON g.id = r.parent_id
      WHERE r.presupuesto_id = $1
        AND NOT EXISTS (SELECT 1 FROM presupuesto_renglones h WHERE h.parent_id = r.id)
      ORDER BY r.orden`,
    [presupuestoId],
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
    presupuestoId,
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
      throw new RepartoInvalidoError('Esa partida no está en el presupuesto del proyecto');
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
    presupuestoId: number;
    lineas: LineaPartida[];
    montoTotalCentavos: number;
    validas: Set<string>;
    userId: number;
  },
): Promise<void> {
  const { solicitudId, presupuestoId, lineas, montoTotalCentavos, validas, userId } = args;

  const limpias = normalizarLineas(lineas, validas);
  comprobarSuma(limpias, montoTotalCentavos);

  await client.query(
    'DELETE FROM solicitud_pago_partidas WHERE solicitud_pago_id = $1',
    [solicitudId],
  );
  for (const l of limpias) {
    await client.query(
      `INSERT INTO solicitud_pago_partidas
         (solicitud_pago_id, presupuesto_id, row_uid, monto, creado_por)
       VALUES ($1, $2, $3, $4, $5)`,
      [solicitudId, presupuestoId, l.rowUid, l.monto, userId],
    );
  }
}

/** El reparto de un pago tal como lo pinta la pantalla. LEFT JOIN a proposito:
 *  si la fila ya no esta —se borro, o la estrella se movio a otro presupuesto—
 *  la linea sigue aqui con el nombre vacio y la pantalla la trata como
 *  pendiente de volver a asignar. */
export async function leerPartidasDePago(
  solicitudId: number,
): Promise<PartidaAsignadaWire[]> {
  const guardadas = await query<{
    row_uid: string; monto: string; item: string | null; descripcion: string | null;
  }>(
    `SELECT sp.row_uid, sp.monto::text AS monto, r.codigo AS item, r.descripcion
       FROM solicitud_pago_partidas sp
       LEFT JOIN presupuestos p
              ON p.id = sp.presupuesto_id AND p.activo AND p.es_principal
       LEFT JOIN presupuesto_renglones r
              ON r.presupuesto_id = p.id AND r.row_uid = sp.row_uid
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
