import { query } from '../database/config.js';

export async function registrarAudit(
  userId: number,
  accion: string,
  entidad: string,
  entidadId: number | null,
  detalles?: Record<string, unknown>,
): Promise<void> {
  try {
    await query(
      'INSERT INTO audit_log (user_id, accion, entidad, entidad_id, detalles) VALUES ($1, $2, $3, $4, $5)',
      [
        userId,
        accion,
        entidad,
        entidadId,
        detalles ? JSON.stringify(detalles) : null,
      ],
    );
  } catch (err) {
    console.error('Error registrando audit log:', err);
  }
}
