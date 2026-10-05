// El WhatsApp de las solicitudes URGENTES.
//
// Cuando una solicitud urgente llega al turno de alguien —al crearla, cuando
// firma el de antes (una sola o varias a la vez) y cuando se reenvia despues de
// un rechazo—, a esa persona le sale un WhatsApp con la solicitud y un boton
// «Aprobar» que la abre en el sistema (/solicitud/<id>), donde se aprueba con la
// contraseña de siempre. Ivan, 2026-10-05: solo las urgentes («me llegaria un
// monton de mensajes»), y aprobar no se hace en WhatsApp. El correo de las
// urgentes sigue saliendo como antes.
//
// Lo empieza el sistema, no la persona, asi que va con la plantilla que Meta
// aprobo el 2026-10-02 (solicitud_urgente, utilidad, español): fuera de las 24
// horas de una conversacion Meta no deja mandar otra cosa. Cada una cuesta
// alrededor de un centavo.
//
// Va a quien le toca firmar ahora, si tiene WhatsApp en el sistema. Un mismo
// turno no se avisa dos veces: whatsapp_avisos_urgentes (migracion 181) lo
// impide en la base, no aqui.
//
// Nunca tumba lo que la llamo: se llama despues de contestar, y un error solo
// queda en el registro.

import { query } from '../../database/config.js';
import { estaConfigurado } from './cliente.js';
import { mandarPlantilla } from './entrantes.js';
import { dinero } from './solicitudes.js';

export const PLANTILLA_URGENTE = 'solicitud_urgente';

/** Avisa a quien le toca firmar esta solicitud, si es urgente y tiene WhatsApp. */
export async function avisarTurnoUrgente(solicitudId: number): Promise<void> {
  if (!estaConfigurado()) return;
  try {
    const s = (
      await query<{
        id: number; numero: string; proveedor: string; monto_total: string; proyecto_id: number;
        proyecto: string; ronda: Date;
      }>(
        `SELECT sp.id, sp.numero, sp.proveedor, sp.monto_total, sp.proyecto_id,
                COALESCE(NULLIF(p.nombre_corto, ''), p.nombre) AS proyecto,
                COALESCE(sp.updated_at, sp.created_at) AS ronda
           FROM solicitudes_pago sp JOIN proyectos p ON p.id = sp.proyecto_id
          WHERE sp.id = $1 AND sp.activo AND sp.urgente AND sp.estado = 'pendiente'`,
        [solicitudId],
      )
    ).rows[0];
    if (!s) return;

    // El turno: el primero de la cadena que todavia no firmo. Lo mismo que
    // mira aprobar (solicitudesPago.ts).
    const firmadas = Number(
      (
        await query<{ n: string }>(
          "SELECT COUNT(*) AS n FROM solicitud_aprobaciones WHERE solicitud_pago_id = $1 AND accion = 'aprobado'",
          [s.id],
        )
      ).rows[0].n,
    );
    const turno = (
      await query<{ user_id: number; whatsapp: string | null; activo: boolean }>(
        `SELECT pas.user_id, u.whatsapp, u.activo
           FROM proyecto_ajustes_aprobacion pas JOIN users u ON u.id = pas.user_id
          WHERE pas.proyecto_id = $1 AND pas.activo
          ORDER BY pas.orden
          OFFSET $2 LIMIT 1`,
        [s.proyecto_id, firmadas],
      )
    ).rows[0];
    if (!turno?.activo || !turno.whatsapp) return;

    // Primero se apunta; si ya estaba apuntado, este turno ya se aviso.
    const apuntado = await query<{ id: number }>(
      `INSERT INTO whatsapp_avisos_urgentes (solicitud_pago_id, user_id, turno, ronda, telefono)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (solicitud_pago_id, user_id, turno, ronda) DO NOTHING
       RETURNING id`,
      [s.id, turno.user_id, firmadas + 1, s.ronda, turno.whatsapp],
    );
    if (apuntado.rows.length === 0) return;

    const monto = dinero(s.monto_total);
    const salio = await mandarPlantilla(
      turno.whatsapp,
      `La solicitud urgente ${s.numero} de ${s.proveedor} por ${monto}, del proyecto ${s.proyecto}, ` +
        `espera tu aprobación. [Aprobar: /solicitud/${s.id}]`,
      {
        nombre: PLANTILLA_URGENTE,
        idioma: 'es',
        cuerpo: [s.numero, s.proveedor, monto, s.proyecto],
        boton: String(s.id),
      },
    );
    await query('UPDATE whatsapp_avisos_urgentes SET salio = $1 WHERE id = $2', [salio, apuntado.rows[0].id]);
  } catch (e) {
    console.error(`[whatsapp] no se pudo avisar la solicitud urgente ${solicitudId}:`, (e as Error).message);
  }
}
