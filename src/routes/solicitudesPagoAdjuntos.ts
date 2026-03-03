import { Router, Request, Response, NextFunction } from 'express';
import { param } from 'express-validator';
import multer from 'multer';
import crypto from 'crypto';
import { query } from '../database/config.js';
import { authenticateToken } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { uploadFile, deleteFile, getFileSignedUrl } from '../services/storage.js';

const router = Router();

router.use(authenticateToken);

// Multer config: memory storage, 10MB limit, PDF/JPG/PNG only
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['application/pdf', 'image/jpeg', 'image/png'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Tipo de archivo no permitido. Solo PDF, JPG y PNG.'));
    }
  },
});

// Sanitize filename for R2 key
function sanitizeFilename(name: string): string {
  return name
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_');
}

// --- GET /adjuntos/:adjuntoId/download — Signed URL ---
router.get('/adjuntos/:adjuntoId/download', [
  param('adjuntoId').isInt()
], asyncHandler(async (req: Request<{ adjuntoId: string }>, res: Response): Promise<void> => {
  const { adjuntoId } = req.params;

  const result = await query<{ r2_key: string }>(
    'SELECT r2_key FROM solicitud_pago_adjuntos WHERE id = $1', [adjuntoId]
  );

  if (result.rows.length === 0) {
    res.status(404).json({ success: false, message: 'Adjunto no encontrado' });
    return;
  }

  const url = await getFileSignedUrl(result.rows[0].r2_key);
  res.json({ success: true, url });
}));

// --- DELETE /adjuntos/:adjuntoId — Delete from R2 and DB ---
router.delete('/adjuntos/:adjuntoId', [
  param('adjuntoId').isInt()
], asyncHandler(async (req: Request<{ adjuntoId: string }>, res: Response): Promise<void> => {
  const { adjuntoId } = req.params;

  const result = await query<{ r2_key: string }>(
    'SELECT r2_key FROM solicitud_pago_adjuntos WHERE id = $1', [adjuntoId]
  );

  if (result.rows.length === 0) {
    res.status(404).json({ success: false, message: 'Adjunto no encontrado' });
    return;
  }

  // Delete from R2
  try {
    await deleteFile(result.rows[0].r2_key);
  } catch (err) {
    console.error('Error deleting file from R2:', err);
  }

  // Delete from DB
  await query('DELETE FROM solicitud_pago_adjuntos WHERE id = $1', [adjuntoId]);

  res.json({ success: true, message: 'Adjunto eliminado' });
}));

// --- GET /:id/adjuntos/urls — Batch signed URLs for all adjuntos ---
router.get('/:id/adjuntos/urls', [
  param('id').isInt()
], asyncHandler(async (req: Request<{ id: string }>, res: Response): Promise<void> => {
  const { id } = req.params;

  const result = await query<{ id: number; r2_key: string; tipo_mime: string }>(
    'SELECT id, r2_key, tipo_mime FROM solicitud_pago_adjuntos WHERE solicitud_pago_id = $1',
    [id]
  );

  const adjuntosWithUrls = await Promise.all(
    result.rows.map(async (row) => ({
      id: row.id,
      url: await getFileSignedUrl(row.r2_key),
      tipo_mime: row.tipo_mime,
    }))
  );

  res.json({ success: true, adjuntos: adjuntosWithUrls });
}));

// --- GET /:id/adjuntos — List adjuntos for a solicitud ---
router.get('/:id/adjuntos', [
  param('id').isInt()
], asyncHandler(async (req: Request<{ id: string }>, res: Response): Promise<void> => {
  const { id } = req.params;

  const result = await query(`
    SELECT a.*, u.nombre as subido_por_nombre
    FROM solicitud_pago_adjuntos a
    LEFT JOIN users u ON a.subido_por = u.id
    WHERE a.solicitud_pago_id = $1
    ORDER BY a.created_at DESC
  `, [id]);

  res.json({ success: true, adjuntos: result.rows });
}));

// --- POST /:id/adjuntos — Upload files ---
router.post('/:id/adjuntos', [
  param('id').isInt()
], (req: Request, res: Response, next: NextFunction) => {
  upload.array('archivos', 5)(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        res.status(400).json({ success: false, message: 'El archivo excede el limite de 10MB' });
        return;
      }
      if (err.code === 'LIMIT_UNEXPECTED_FILE') {
        res.status(400).json({ success: false, message: 'Maximo 5 archivos por subida' });
        return;
      }
      res.status(400).json({ success: false, message: err.message });
      return;
    }
    if (err) {
      res.status(400).json({ success: false, message: err.message });
      return;
    }
    next();
  });
}, asyncHandler(async (req: Request<{ id: string }>, res: Response): Promise<void> => {
  const { id } = req.params;
  const files = req.files as Express.Multer.File[];

  if (!files || files.length === 0) {
    res.status(400).json({ success: false, message: 'No se recibieron archivos' });
    return;
  }

  // Verify solicitud exists
  const solicitud = await query('SELECT id FROM solicitudes_pago WHERE id = $1', [id]);
  if (solicitud.rows.length === 0) {
    res.status(404).json({ success: false, message: 'Solicitud no encontrada' });
    return;
  }

  const adjuntos = [];

  for (const file of files) {
    const uuid = crypto.randomUUID();
    const safeName = sanitizeFilename(file.originalname);
    const r2Key = `solicitudes-pago/${id}/${uuid}_${safeName}`;

    await uploadFile(r2Key, file.buffer, file.mimetype);

    const result = await query(`
      INSERT INTO solicitud_pago_adjuntos (solicitud_pago_id, nombre_original, r2_key, tipo_mime, tamano, subido_por)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [id, file.originalname, r2Key, file.mimetype, file.size, req.user!.id]);

    adjuntos.push(result.rows[0]);
  }

  res.status(201).json({ success: true, adjuntos });
}));

export default router;
