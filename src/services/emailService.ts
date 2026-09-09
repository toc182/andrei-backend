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
): Promise<void> {
  if (!resend) {
    const destino = Array.isArray(to) ? to.join(', ') : to;
    const adjuntos = attachments?.length
      ? `, ${attachments.length} adjunto(s)`
      : '';
    console.log(
      `📧 Email skipped (no Resend config): to=${destino}, subject="${subject}"${adjuntos}`,
    );
    return;
  }

  await resend.emails.send({
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
}
