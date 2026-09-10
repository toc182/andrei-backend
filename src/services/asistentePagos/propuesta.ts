// src/services/asistentePagos/propuesta.ts
// El borrador de cambios que el asistente arma durante una peticion.
//
// Nada de esto toca la base. Es una lista en memoria que muere con la peticion
// y que viaja a la pantalla para que la persona la mire antes de aplicarla.
//
// Cada cambio lleva una HUELLA: un resumen corto de como estaba ese pago cuando
// se propuso. Al aplicar se vuelve a calcular contra la base y, si no coincide,
// el lote entero se rechaza. Sin eso, dos personas mirando la misma pantalla se
// pisarian el trabajo sin enterarse.
//
// La huella se calcula AQUI y en ningun otro sitio. Si el que propone y el que
// aplica la calcularan cada uno a su manera, la comprobacion no serviria de
// nada el dia que una de las dos cambie.

import { createHash, randomUUID } from 'node:crypto';
import type { PagoContexto } from './contexto.js';

export type ReglaPropuesta =
  | 'una_partida'
  | 'proporcional_presupuesto'
  | 'partes_iguales'
  | 'porcentajes';

export interface LineaPropuesta {
  rowUid: string;
  /** null cuando la fila ya no esta en el desglose. Solo pasa en el "antes". */
  item: string | null;
  descripcion: string | null;
  monto: number;
}

export interface CambioPropuesto {
  solicitudId: number;
  numero: string | null;
  proveedor: string | null;
  monto: number;
  /** Como esta hoy. Lista vacia = sin partida. */
  antes: LineaPropuesta[];
  /** Como quedaria. Nunca llega vacia: el asistente no propone dejar sin partida. */
  despues: LineaPropuesta[];
  regla: ReglaPropuesta;
  motivo: string;
  huella: string;
}

export interface Propuesta {
  id: string;
  resumen: string;
  cambios: CambioPropuesto[];
}

const centavos = (n: number): number => Math.round(n * 100);

/** Resumen corto de como esta un pago ahora mismo. El monto del pago entra en
 *  la cuenta a proposito: si una correccion le cambio el importe, una propuesta
 *  hecha sobre el importe viejo no puede aplicarse. */
export function huellaDePago(
  solicitudId: number,
  montoTotalCentavos: number,
  lineas: { rowUid: string; monto: number }[],
): string {
  const ordenadas = [...lineas]
    .map((l) => `${l.rowUid}:${centavos(l.monto)}`)
    .sort();
  const texto = `${solicitudId}|${montoTotalCentavos}|${ordenadas.join(',')}`;
  return createHash('sha256').update(texto).digest('hex').slice(0, 16);
}

/** Dos repartos son el mismo si tienen las mismas partidas por los mismos
 *  centavos, en cualquier orden. */
function mismoReparto(a: LineaPropuesta[], b: LineaPropuesta[]): boolean {
  if (a.length !== b.length) return false;
  const clave = (l: LineaPropuesta[]) =>
    l.map((x) => `${x.rowUid}:${centavos(x.monto)}`).sort().join(',');
  return clave(a) === clave(b);
}

export class Borrador {
  private readonly porPago = new Map<number, CambioPropuesto>();

  /** Apunta como quedaria un pago. Si ya se habia propuesto algo para el, esto
   *  lo reemplaza: el asistente puede corregirse a mitad de la misma vuelta. */
  poner(
    pago: PagoContexto,
    despues: LineaPropuesta[],
    regla: ReglaPropuesta,
    motivo: string,
  ): void {
    const antes: LineaPropuesta[] = pago.partidas.map((p) => ({
      rowUid: p.rowUid,
      item: p.item,
      descripcion: p.descripcion,
      monto: p.monto,
    }));

    this.porPago.set(pago.id, {
      solicitudId: pago.id,
      numero: pago.numero,
      proveedor: pago.proveedor,
      monto: pago.monto,
      antes,
      despues,
      regla,
      motivo,
      huella: huellaDePago(pago.id, centavos(pago.monto), antes),
    });
  }

  /** Cuantos pagos lleva tocados, contando los que al final no cambian nada. */
  get tamano(): number {
    return this.porPago.size;
  }

  /** Los cambios de verdad. Los que dejan el pago igual que estaba se caen:
   *  decir "3 cambios" y que dos no cambien nada es mentir en la barra. */
  cambios(): CambioPropuesto[] {
    return [...this.porPago.values()].filter((c) => !mismoReparto(c.antes, c.despues));
  }

  /** null cuando no queda ningun cambio de verdad. */
  propuesta(resumen: string): Propuesta | null {
    const cambios = this.cambios();
    if (cambios.length === 0) return null;
    return { id: randomUUID(), resumen, cambios };
  }
}
