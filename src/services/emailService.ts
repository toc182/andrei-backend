import nodemailer from 'nodemailer';

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587');
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER;

let transporter: nodemailer.Transporter | null = null;

if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    family: 4,
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS
    }
  } as nodemailer.TransportOptions);
  console.log('✅ Email service configured');
} else {
  console.log('⚠️  Email service not configured (missing SMTP_HOST, SMTP_USER, or SMTP_PASS)');
}

export async function sendEmail(to: string, subject: string, html: string): Promise<void> {
  if (!transporter) {
    console.log(`📧 Email skipped (no SMTP config): to=${to}, subject="${subject}"`);
    return;
  }

  await transporter.sendMail({
    from: SMTP_FROM,
    to,
    subject,
    html
  });
}
