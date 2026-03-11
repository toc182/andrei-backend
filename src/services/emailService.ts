import { Resend } from 'resend';

const RESEND_API_KEY = process.env.RESEND_API_KEY;

let resend: Resend | null = null;

if (RESEND_API_KEY) {
  resend = new Resend(RESEND_API_KEY);
  console.log('✅ Email service configured (Resend)');
} else {
  console.log('⚠️  Email service not configured (missing RESEND_API_KEY)');
}

export async function sendEmail(to: string, subject: string, html: string): Promise<void> {
  if (!resend) {
    console.log(`📧 Email skipped (no Resend config): to=${to}, subject="${subject}"`);
    return;
  }

  await resend.emails.send({
    from: 'Pinellas <info@pinellaspanama.com>',
    to,
    subject,
    html
  });
}
