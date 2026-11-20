import type { PoolClient } from 'pg';

/**
 * Los pagos de una solicitud de pago (migración 191, pagos parciales).
 *
 * Una solicitud regular se puede pagar en partes (Ivan, 2026-11-18). Lo pagado y
 * el saldo salen SOLO de la vista solicitud_pago_saldo, y el estado que le toca
 * a la solicitud por lo pagado sale SOLO de estadoSegunPagos(): registrar un
 * pago, corregirlo o anularlo pasan por la misma regla.
 *
 * Los montos viajan en centavos enteros. Sumar y restar decimales en coma
 * flotante deja saldos de 0.0000001 que nunca llegan a cero.
 */

export type EstadoPorPagos =
  | 'aprobada'
  | 'abonada'
  | 'pagada'
  | 'facturada'
  | 'reembolsada'
  | 'transferida';

/** «1293.75» (o un número) → 129375. */
export function aCentavos(valor: string | number): number {
  return Math.round(Number(valor) * 100);
}

/** 129375 → «1293.75», para guardar en un NUMERIC(12,2). */
export function deCentavos(centavos: number): string {
  return (centavos / 100).toFixed(2);
}

/** 129375 → «B/. 1,293.75», como lo escriben el PDF y las pantallas. */
export function dineroCentavos(centavos: number): string {
  return `B/. ${(centavos / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * Un monto escrito por quien registra o corrige un pago: «1293.75», sin
 * separador de miles y con dos decimales a lo sumo (la pantalla lo manda así).
 * Devuelve los centavos, o null si no es un monto mayor que cero.
 */
export function leerMonto(valor: unknown): number | null {
  if (typeof valor !== 'string' && typeof valor !== 'number') return null;
  const texto = String(valor).trim();
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(texto)) return null;
  const centavos = aCentavos(texto);
  return centavos > 0 ? centavos : null;
}

export interface SaldoSolicitud {
  numero: string;
  tipo: 'regular' | 'reembolso' | 'apertura';
  estado: string;
  nombreCorto: string;
  totalCentavos: number;
  pagadoCentavos: number;
  saldoCentavos: number;
  pagos: number;
  conFactura: boolean;
}

/**
 * La solicitud y su saldo, con la fila BLOQUEADA hasta el final de la
 * transacción: dos pagos registrados al mismo tiempo no pueden pasar del saldo,
 * porque el segundo espera a que el primero termine y lee el saldo ya rebajado.
 */
export async function leerSaldoBloqueando(
  client: PoolClient,
  solicitudId: number,
): Promise<SaldoSolicitud | null> {
  const fila = await client.query<{
    numero: string;
    tipo: SaldoSolicitud['tipo'];
    estado: string;
    nombre_corto: string;
  }>(
    `SELECT sp.numero, sp.tipo, sp.estado, COALESCE(p.nombre_corto, p.nombre) AS nombre_corto
       FROM solicitudes_pago sp
       LEFT JOIN proyectos p ON p.id = sp.proyecto_id
      WHERE sp.id = $1 AND sp.activo = true
        FOR UPDATE OF sp`,
    [solicitudId],
  );
  if (fila.rows.length === 0) return null;

  const saldo = await client.query<{
    monto_total: string;
    pagado: string;
    saldo: string;
    pagos: number;
    con_factura: boolean;
  }>(
    `SELECT v.monto_total::text, v.pagado::text, v.saldo::text, v.pagos,
            EXISTS (SELECT 1 FROM facturas_solicitud f WHERE f.solicitud_pago_id = v.solicitud_pago_id) AS con_factura
       FROM solicitud_pago_saldo v
      WHERE v.solicitud_pago_id = $1`,
    [solicitudId],
  );
  const s = saldo.rows[0];
  const f = fila.rows[0];
  return {
    numero: f.numero,
    tipo: f.tipo,
    estado: f.estado,
    nombreCorto: f.nombre_corto,
    totalCentavos: aCentavos(s.monto_total),
    pagadoCentavos: aCentavos(s.pagado),
    saldoCentavos: aCentavos(s.saldo),
    pagos: s.pagos,
    conFactura: s.con_factura,
  };
}

/**
 * El estado que le toca a una solicitud aprobada por lo que se le ha pagado.
 *
 *   sin pagos            → aprobada («Por pagar»)
 *   con saldo            → abonada
 *   saldo en cero        → pagada, o facturada si la factura ya se registró;
 *                          las de caja menuda, reembolsada o transferida.
 *
 * Lo pagado nunca pasa del total: quien escribe un pago lo revisa antes. Si
 * pasara, es un error del sistema y se detiene todo.
 */
export function estadoSegunPagos(s: {
  tipo: SaldoSolicitud['tipo'];
  pagos: number;
  saldoCentavos: number;
  conFactura: boolean;
}): EstadoPorPagos {
  if (s.saldoCentavos < 0) {
    throw new Error('Lo pagado pasa del total de la solicitud');
  }
  if (s.pagos === 0) return 'aprobada';
  if (s.saldoCentavos > 0) return 'abonada';
  if (s.tipo === 'reembolso') return 'reembolsada';
  if (s.tipo === 'apertura') return 'transferida';
  return s.conFactura ? 'facturada' : 'pagada';
}
