import type { Pool, PoolClient } from 'pg';
import { registrarAudit } from './auditLog.js';

/**
 * Qué le pasa a una caja menuda cuando se rechaza su apertura o un aumento
 * (Ivan, 2026-11-19).
 *
 * - La apertura (la primera solicitud de la caja) no se rechaza mientras la
 *   caja tenga gastos: o se eliminan los gastos, o, si el problema es el monto,
 *   se baja el monto y la apertura se reemplaza por una solicitud nueva
 *   (PUT /cajas-menudas/:id/monto).
 * - Rechazar la apertura cancela la caja: monto 0, ya no admite nada y pasa a
 *   «Inactivas». Se queda en el sistema con su solicitud rechazada, para que se
 *   vea quién la rechazó y por qué.
 * - Rechazar un aumento devuelve la caja al monto que tenía antes.
 *
 * La usan POST /solicitudes-pago/:id/rechazar (dentro de su transacción) y
 * GET /solicitudes-pago/:id, que se lo avisa a la pantalla antes de rechazar.
 */

export interface CajaDeLaApertura {
  id: number;
  nombre: string;
  gastos: number;
}

/**
 * La caja cuya APERTURA es esta solicitud (null si es un aumento o cualquier
 * otra solicitud). Con `bloquear`, la fila de la caja queda trabada hasta que
 * termine la transacción: ningún gasto entra entre este conteo y el rechazo.
 */
export async function cajaDeLaApertura(
  db: Pool | PoolClient,
  solicitudId: number,
  bloquear = false,
): Promise<CajaDeLaApertura | null> {
  const r = await db.query<{ id: number; nombre: string; gastos: number }>(
    `SELECT cm.id, cm.nombre,
            (SELECT COUNT(*)::int FROM cajas_menudas_gastos g WHERE g.caja_menuda_id = cm.id) AS gastos
       FROM cajas_menudas cm
      WHERE cm.solicitud_apertura_id = $1 AND cm.activo = true
      ${bloquear ? 'FOR UPDATE OF cm' : ''}`,
    [solicitudId],
  );
  return r.rows[0] ?? null;
}

/** Por qué una apertura con gastos no se rechaza, y las dos salidas. */
export function mensajeAperturaConGastos(caja: CajaDeLaApertura): string {
  const gastos = caja.gastos === 1 ? '1 gasto registrado' : `${caja.gastos} gastos registrados`;
  return (
    `No se puede rechazar la apertura: la caja ${caja.nombre} ya tiene ${gastos}. ` +
    'Elimine los gastos de la caja y vuelva a rechazar la solicitud, o, si el problema es el monto, ' +
    'baje el monto de la caja: la solicitud se reemplazará por una nueva por el monto correcto.'
  );
}

/**
 * Lo que le pasa a la caja cuando su apertura o un aumento queda rechazado,
 * dentro de la transacción de quien llama (con la solicitud ya 'rechazada').
 * Quien llama ya se negó a rechazar una apertura cuya caja tiene gastos.
 */
export async function alRechazarApertura(
  client: PoolClient,
  solicitudId: number,
  userId: number,
  comentario: string,
): Promise<void> {
  const caja = await cajaDeLaApertura(client, solicitudId, true);
  if (caja) {
    await client.query(
      `UPDATE cajas_menudas
          SET estado = 'cancelada', monto_asignado = 0, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1`,
      [caja.id],
    );
    await registrarAudit(
      userId,
      'cancelar',
      'caja_menuda',
      caja.id,
      { nombre: caja.nombre, solicitud_apertura_id: solicitudId, comentario },
      client,
    );
    return;
  }

  // Un aumento: la caja vuelve al monto que tenía antes de él.
  const historial = await client.query<{
    id: number;
    caja_menuda_id: number;
    monto_anterior: string;
  }>(
    `SELECT id, caja_menuda_id, monto_anterior
       FROM cajas_menudas_historial_monto
      WHERE solicitud_pago_id = $1`,
    [solicitudId],
  );
  if (historial.rows.length > 0) {
    const h = historial.rows[0];
    await client.query(
      `UPDATE cajas_menudas_historial_monto SET estado = 'rechazada' WHERE id = $1`,
      [h.id],
    );
    await client.query(
      'UPDATE cajas_menudas SET monto_asignado = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [h.monto_anterior, h.caja_menuda_id],
    );
  }
}
