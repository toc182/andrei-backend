import type { PoolClient } from 'pg';
import { deleteFile } from './storage.js';

/**
 * Quita una solicitud de pago (activo = false) y lo que cuelga de ella, dentro
 * de la transacción de quien llama. Devuelve las llaves de sus archivos en R2,
 * que se borran con borrarArchivos() DESPUÉS del COMMIT: un ROLLBACK no
 * devuelve un archivo ya borrado.
 *
 * La usan DELETE /solicitudes-pago/:id y la eliminación de una caja menuda
 * (DELETE /cajas-menudas/:id), que se lleva su apertura y sus reembolsos sin
 * pagar. Quién puede quitar qué lo decide cada ruta, no esta función.
 */
export async function retirarSolicitud(
  client: PoolClient,
  id: number,
): Promise<string[]> {
  const adjuntos = await client.query<{ r2_key: string }>(
    'SELECT r2_key FROM solicitud_pago_adjuntos WHERE solicitud_pago_id = $1',
    [id],
  );

  await client.query('DELETE FROM devoluciones_solicitud WHERE solicitud_pago_id = $1', [id]);
  await client.query('DELETE FROM reembolsos_pinellas WHERE solicitud_pago_id = $1', [id]);
  await client.query('DELETE FROM comprobantes_pago WHERE solicitud_pago_id = $1', [id]);
  await client.query('DELETE FROM facturas_solicitud WHERE solicitud_pago_id = $1', [id]);
  await client.query('DELETE FROM solicitud_aprobaciones WHERE solicitud_pago_id = $1', [id]);
  await client.query('DELETE FROM solicitud_revisiones WHERE solicitud_pago_id = $1', [id]);
  await client.query('DELETE FROM correcciones_solicitud WHERE solicitud_pago_id = $1', [id]);

  // Los gastos y archivos de caja menuda que iban en un reembolso vuelven a
  // ser gastos corrientes de su caja.
  await client.query(
    'UPDATE cajas_menudas_gastos SET solicitud_reembolso_id = NULL WHERE solicitud_reembolso_id = $1',
    [id],
  );
  await client.query(
    'UPDATE cajas_menudas_adjuntos SET solicitud_reembolso_id = NULL WHERE solicitud_reembolso_id = $1',
    [id],
  );

  await client.query(
    'UPDATE solicitudes_pago SET activo = false, updated_at = CURRENT_TIMESTAMP WHERE id = $1',
    [id],
  );

  return adjuntos.rows.map((a) => a.r2_key);
}

/** Borra de R2 los archivos que devolvió retirarSolicitud(); un fallo solo se anota. */
export async function borrarArchivos(claves: string[]): Promise<void> {
  for (const clave of claves) {
    try {
      await deleteFile(clave);
    } catch (err) {
      console.error('Error deleting R2 file:', clave, err);
    }
  }
}
