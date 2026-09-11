import { Resend } from 'resend';

const RESEND_API_KEY = process.env.RESEND_API_KEY;

let resend: Resend | null = null;

if (RESEND_API_KEY) {
  resend = new Resend(RESEND_API_KEY);
  console.log('✅ Email service configured (Resend)');
} else {
  console.log('⚠️  Email service not configured (missing RESEND_API_KEY)');
}

export interface EmailAttachment {
  filename: string;
  content: Buffer;
}

/**
 * `to` acepta una direccion o varias. `attachments` es opcional, asi que
 * ninguna de las llamadas que ya existian cambia.
 */
export async function sendEmail(
  to: string | string[],
  subject: string,
  html: string,
  attachments?: EmailAttachment[],
): Promise<string | null> {
  if (!resend) {
    const destino = Array.isArray(to) ? to.join(', ') : to;
    const adjuntos = attachments?.length
      ? `, ${attachments.length} adjunto(s)`
      : '';
    console.log(
      `📧 Email skipped (no Resend config): to=${destino}, subject="${subject}"${adjuntos}`,
    );
    return null;
  }

  const { data, error } = await resend.emails.send({
    from: 'Pinellas <info@pinellaspanama.com>',
    to,
    subject,
    html,
    ...(attachments?.length
      ? {
        attachments: attachments.map((a) => ({
          filename: a.filename,
          content: a.content,
        })),
      }
      : {}),
  });

  // Resend NO lanza cuando rechaza un correo: devuelve el motivo en `error` y
  // la promesa se resuelve igual. Sin mirar eso, un correo rechazado —adjunto
  // demasiado pesado, dominio sin verificar, clave vencida— se daba por
  // enviado. Era el unico sitio del sistema capaz de mentir sobre un envio, y
  // por eso un reporte podia quedar marcado como enviado sin que llegara a
  // ninguna bandeja. Ahora se lanza, y quien llama decide si eso tumba la
  // operacion o solo se anota: los avisos de solicitudes y el correo diario ya
  // lo envuelven en su propio try/catch.
  if (error) {
    const detalle =
      (error as { message?: string }).message ?? JSON.stringify(error);
    throw new Error(`Resend rechazo el correo: ${detalle}`);
  }

  return data?.id ?? null;
}
