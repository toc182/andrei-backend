import { Router, Request, Response } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { sendDailyNotifications } from '../services/dailyNotification.js';

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

export default router;
