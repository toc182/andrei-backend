import type { PoolClient } from 'pg';
import { query } from '../database/config.js';

// Con `db` —el cliente de una transaccion abierta— el registro va DENTRO de
// ella: se guarda o se deshace junto con el cambio que anota. Ahi un fallo no
// se traga: en Postgres un INSERT fallido deja la transaccion abortada y el
// COMMIT de despues la deshace entera sin dar error, asi que el cambio se
// perderia mientras la ruta responde que todo salio bien.
export async function registrarAudit(
  userId: number,
  accion: string,
  entidad: string,
  entidadId: number | null,
  detalles?: Record<string, unknown>,
  db?: PoolClient,
): Promise<void> {
  const sql =
    'INSERT INTO audit_log (user_id, accion, entidad, entidad_id, detalles) VALUES ($1, $2, $3, $4, $5)';
  const params = [
    userId,
    accion,
    entidad,
    entidadId,
    detalles ? JSON.stringify(detalles) : null,
  ];
  if (db) {
    await db.query(sql, params);
    return;
  }
  try {
    await query(sql, params);
  } catch (err) {
    console.error('Error registrando audit log:', err);
  }
}
