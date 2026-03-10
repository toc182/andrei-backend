import { Router, Request, Response } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { sendDailyNotifications } from '../services/dailyNotification.js';
import { sendEmail } from '../services/emailService.js';

const router = Router();

// POST /test-daily — Ejecutar notificación diaria manualmente (solo admin)
router.post('/test-daily', authenticateToken, asyncHandler(async (req: Request, res: Response): Promise<void> => {
  if (req.user!.rol !== 'admin') {
    res.status(403).json({ success: false, message: 'Solo administradores pueden ejecutar esta acción' });
    return;
  }

  const result = await sendDailyNotifications();

  res.json({
    success: true,
    message: `Notificaciones enviadas: ${result.enviados}`,
    ...result
  });
}));

// POST /test-email — Enviar email de prueba al usuario actual (solo admin, temporal)
router.post('/test-email', authenticateToken, asyncHandler(async (req: Request, res: Response): Promise<void> => {
  if (req.user!.rol !== 'admin') {
    res.status(403).json({ success: false, message: 'Solo administradores' });
    return;
  }

  const userEmail = req.user!.email;
  const userName = req.user!.nombre || 'Admin';

  const html = `
    <div style="max-width: 600px; margin: 0 auto; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
      <div style="background: #1a365d; padding: 20px 24px; border-radius: 8px 8px 0 0;">
        <h1 style="margin: 0; color: white; font-size: 18px;">Pinellas, S.A.</h1>
        <p style="margin: 4px 0 0; color: #a0aec0; font-size: 13px;">Sistema Andrei — Email de Prueba</p>
      </div>
      <div style="background: white; padding: 24px; border: 1px solid #e2e8f0; border-top: none; border-radius: 0 0 8px 8px;">
        <p style="margin: 0 0 12px; font-size: 15px; color: #4a5568;">Hola <strong>${userName}</strong>,</p>
        <p style="margin: 0 0 12px; font-size: 15px; color: #4a5568;">Este es un email de prueba del Sistema Andrei. Si lo recibes, la configuración SMTP está funcionando correctamente.</p>
        <p style="margin: 0; font-size: 13px; color: #a0aec0;">Enviado: ${new Date().toLocaleString('es-PA', { timeZone: 'America/Panama' })}</p>
      </div>
    </div>
  `;

  await sendEmail(userEmail, 'Prueba de email — Sistema Andrei', html);

  res.json({
    success: true,
    message: `Email de prueba enviado a ${userEmail}`
  });
}));

export default router;
