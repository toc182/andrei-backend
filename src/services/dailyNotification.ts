import { query } from '../database/config.js';
import { sendEmail } from './emailService.js';

interface PendingSolicitud {
  solicitud_id: number;
  numero: string;
  proveedor: string;
  monto_total: number;
  urgente: boolean;
  proyecto_nombre: string;
  aprobador_id: number;
  aprobador_nombre: string;
  aprobador_email: string | null;
}

interface NotificationResult {
  enviados: number;
  usuarios: string[];
}

function formatMoney(amount: number): string {
  return `B/. ${Number(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function buildEmailHtml(nombre: string, solicitudes: PendingSolicitud[]): string {
  const rows = solicitudes.map(s => `
    <tr>
      <td style="padding: 8px 12px; border-bottom: 1px solid #e2e8f0; font-size: 14px;">
        ${s.numero}${s.urgente ? ' <span style="background: #e53e3e; color: white; padding: 1px 6px; border-radius: 3px; font-size: 11px; font-weight: bold;">URGENTE</span>' : ''}
      </td>
      <td style="padding: 8px 12px; border-bottom: 1px solid #e2e8f0; font-size: 14px;">${s.proveedor}</td>
      <td style="padding: 8px 12px; border-bottom: 1px solid #e2e8f0; font-size: 14px; text-align: right; font-weight: 600;">${formatMoney(s.monto_total)}</td>
      <td style="padding: 8px 12px; border-bottom: 1px solid #e2e8f0; font-size: 14px;">${s.proyecto_nombre}</td>
    </tr>
  `).join('');

  const urgentCount = solicitudes.filter(s => s.urgente).length;
  const urgentNote = urgentCount > 0
    ? `<p style="color: #e53e3e; font-weight: 600; margin: 0 0 16px 0;">⚠ ${urgentCount} solicitud${urgentCount > 1 ? 'es' : ''} marcada${urgentCount > 1 ? 's' : ''} como urgente${urgentCount > 1 ? 's' : ''}</p>`
    : '';

  return `
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"></head>
    <body style="margin: 0; padding: 0; background: #f7fafc; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
      <div style="max-width: 600px; margin: 0 auto; padding: 24px;">
        <!-- Header -->
        <div style="background: #1a365d; padding: 20px 24px; border-radius: 8px 8px 0 0;">
          <h1 style="margin: 0; color: white; font-size: 18px; font-weight: 600;">Pinellas, S.A.</h1>
          <p style="margin: 4px 0 0 0; color: #a0aec0; font-size: 13px;">Sistema Andrei — Notificación de Aprobaciones</p>
        </div>

        <!-- Body -->
        <div style="background: white; padding: 24px; border: 1px solid #e2e8f0; border-top: none;">
          <p style="margin: 0 0 4px 0; font-size: 15px; color: #4a5568;">Hola <strong>${nombre}</strong>,</p>
          <p style="margin: 0 0 16px 0; font-size: 15px; color: #4a5568;">
            Tienes <strong>${solicitudes.length}</strong> solicitud${solicitudes.length > 1 ? 'es' : ''} de pago pendiente${solicitudes.length > 1 ? 's' : ''} de tu aprobación:
          </p>

          ${urgentNote}

          <table style="width: 100%; border-collapse: collapse; border: 1px solid #e2e8f0; border-radius: 4px;">
            <thead>
              <tr style="background: #f7fafc;">
                <th style="padding: 8px 12px; text-align: left; font-size: 12px; color: #718096; text-transform: uppercase; border-bottom: 2px solid #e2e8f0;">Número</th>
                <th style="padding: 8px 12px; text-align: left; font-size: 12px; color: #718096; text-transform: uppercase; border-bottom: 2px solid #e2e8f0;">Proveedor</th>
                <th style="padding: 8px 12px; text-align: right; font-size: 12px; color: #718096; text-transform: uppercase; border-bottom: 2px solid #e2e8f0;">Monto</th>
                <th style="padding: 8px 12px; text-align: left; font-size: 12px; color: #718096; text-transform: uppercase; border-bottom: 2px solid #e2e8f0;">Proyecto</th>
              </tr>
            </thead>
            <tbody>
              ${rows}
            </tbody>
          </table>

          <div style="margin-top: 24px; text-align: center;">
            <a href="https://sistema.pinellaspanama.com" style="display: inline-block; background: #1a365d; color: white; padding: 10px 24px; border-radius: 6px; text-decoration: none; font-size: 14px; font-weight: 600;">
              Ir al Sistema
            </a>
          </div>
        </div>

        <!-- Footer -->
        <div style="padding: 16px 24px; text-align: center; border: 1px solid #e2e8f0; border-top: none; border-radius: 0 0 8px 8px; background: #f7fafc;">
          <p style="margin: 0; font-size: 12px; color: #a0aec0;">
            Este es un mensaje automático del Sistema Andrei. No responda a este correo.
          </p>
        </div>
      </div>
    </body>
    </html>
  `;
}

export async function sendDailyNotifications(): Promise<NotificationResult> {
  // Find all pending solicitudes and their next approver in line
  const result = await query<PendingSolicitud>(`
    SELECT
      sp.id as solicitud_id,
      sp.numero,
      sp.proveedor,
      sp.monto_total,
      sp.urgente,
      COALESCE(p.nombre_corto, p.nombre) as proyecto_nombre,
      pas.user_id as aprobador_id,
      u.nombre as aprobador_nombre,
      u.email as aprobador_email
    FROM solicitudes_pago sp
    JOIN proyectos p ON sp.proyecto_id = p.id
    JOIN project_approval_settings pas ON pas.proyecto_id = sp.proyecto_id AND pas.activo = true
    JOIN users u ON pas.user_id = u.id
    WHERE sp.estado = 'pendiente'
      AND pas.orden = (
        SELECT COUNT(*) + 1
        FROM solicitud_aprobaciones sa
        WHERE sa.solicitud_pago_id = sp.id AND sa.accion = 'aprobado'
      )
    ORDER BY sp.urgente DESC, sp.created_at ASC
  `);

  if (result.rows.length === 0) {
    console.log('📧 No pending solicitudes — no notifications to send');
    return { enviados: 0, usuarios: [] };
  }

  // Group by approver
  const byApprover = new Map<number, PendingSolicitud[]>();
  for (const row of result.rows) {
    const existing = byApprover.get(row.aprobador_id) || [];
    existing.push(row);
    byApprover.set(row.aprobador_id, existing);
  }

  const enviados: string[] = [];

  for (const [, solicitudes] of byApprover) {
    const aprobador = solicitudes[0];

    if (!aprobador.aprobador_email) {
      console.log(`📧 Skipping ${aprobador.aprobador_nombre} — no email`);
      continue;
    }

    const subject = `Tienes ${solicitudes.length} solicitud${solicitudes.length > 1 ? 'es' : ''} pendiente${solicitudes.length > 1 ? 's' : ''} de aprobación`;
    const html = buildEmailHtml(aprobador.aprobador_nombre, solicitudes);

    try {
      await sendEmail(aprobador.aprobador_email, subject, html);
      enviados.push(aprobador.aprobador_nombre);
      console.log(`📧 Notification sent to ${aprobador.aprobador_nombre} (${aprobador.aprobador_email}) — ${solicitudes.length} solicitud(es)`);
    } catch (err) {
      console.error(`📧 Error sending to ${aprobador.aprobador_nombre}:`, err);
    }
  }

  console.log(`📧 Daily notifications complete: ${enviados.length} email(s) sent`);
  return { enviados: enviados.length, usuarios: enviados };
}
