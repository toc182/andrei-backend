/**
 * Project Bitacora (Log) Routes
 * Endpoints for managing project log entries, comments, and attachments
 */

import { Router, Request, Response } from 'express';
import multer from 'multer';
import crypto from 'crypto';
import path from 'path';
import { query } from '../database/config.js';
import { authenticateToken } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import {
  uploadFile,
  deleteFile,
  getFileSignedUrl,
} from '../services/storage.js';

const router = Router();

// Types
interface LogEntryRow {
  id: number;
  proyecto_id: number;
  titulo?: string;
  contenido: string;
  creado_por: number;
  created_at: Date;
  updated_at: Date;
  creador_nombre?: string;
  comment_count?: string;
  attachment_count?: string;
}

interface LogCommentRow {
  id: number;
  bitacora_id: number;
  contenido: string;
  creado_por: number;
  created_at: Date;
  creador_nombre?: string;
}

interface LogAttachmentRow {
  id: number;
  bitacora_id?: number;
  comentario_id?: number;
  nombre_archivo: string;
  r2_key: string;
  tipo_mime: string;
  tamano: number;
  created_at: Date;
  creado_por?: number;
  url?: string;
}

interface QueryParams {
  limit?: string;
  offset?: string;
}

interface CreateEntryBody {
  titulo?: string;
  contenido: string;
}

interface CommentBody {
  contenido?: string;
}

// Multer config: memory storage (we forward the buffer to R2). 10MB max,
// images only. Matches the R2 storage pattern used by solicitudesPagoAdjuntos.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB max
  },
  fileFilter: (_req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|webp/;
    const extname = allowedTypes.test(
      path.extname(file.originalname).toLowerCase(),
    );
    const mimetype = allowedTypes.test(file.mimetype);
    if (extname && mimetype) {
      cb(null, true);
    } else {
      cb(new Error('Solo se permiten imágenes (jpeg, jpg, png, gif, webp)'));
    }
  },
});

// Sanitize an original filename so it can safely live inside an R2 key.
// Mirrors solicitudesPagoAdjuntos.sanitizeFilename.
function sanitizeFilename(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_');
}

// Build the R2 key for a bitacora attachment.
function buildBitacoraKey(
  parent: { kind: 'entry'; entryId: number } | { kind: 'comment'; commentId: number },
  originalName: string,
): string {
  const uuid = crypto.randomUUID();
  const safe = sanitizeFilename(originalName);
  const prefix =
    parent.kind === 'entry'
      ? `bitacora/entries/${parent.entryId}`
      : `bitacora/comments/${parent.commentId}`;
  return `${prefix}/${uuid}_${safe}`;
}

// Add a fresh signed URL to every attachment in an array. Skips legacy rows
// where r2_key looks like a bare filename from the old disk-storage scheme
// (they'd never resolve and would just fail authentication on R2).
async function attachSignedUrls(
  attachments: LogAttachmentRow[],
): Promise<LogAttachmentRow[]> {
  return Promise.all(
    attachments.map(async (att) => {
      if (!att.r2_key || !att.r2_key.includes('/')) return att;
      try {
        const url = await getFileSignedUrl(att.r2_key);
        return { ...att, url };
      } catch (err) {
        console.error('Error signing bitacora attachment URL:', err);
        return att;
      }
    }),
  );
}

// ============================================
// LOG ENTRIES ENDPOINTS
// ============================================

// GET /api/project-bitacora/projects/:projectId - List entries for a project
router.get(
  '/projects/:projectId',
  authenticateToken,
  asyncHandler(
    async (
      req: Request<{ projectId: string }, object, object, QueryParams>,
      res: Response,
    ): Promise<void> => {
      const { projectId } = req.params;
      const { limit = '20', offset = '0' } = req.query;

      // Get entries with creator info and counts
      const result = await query<LogEntryRow>(
        `
    SELECT
      e.*,
      u.nombre as creador_nombre,
      (SELECT COUNT(*) FROM proyecto_bitacora_comentarios WHERE bitacora_id = e.id) as comment_count,
      (
        SELECT COUNT(*) FROM proyecto_bitacora_adjuntos
        WHERE bitacora_id = e.id
        OR comentario_id IN (SELECT id FROM proyecto_bitacora_comentarios WHERE bitacora_id = e.id)
      ) as attachment_count
    FROM proyecto_bitacora e
    JOIN users u ON e.creado_por = u.id
    WHERE e.proyecto_id = $1
    ORDER BY e.created_at DESC
    LIMIT $2 OFFSET $3
  `,
        [projectId, limit, offset],
      );

      // Get attachments for all entries
      const entryIds = result.rows.map((e) => e.id);
      const attachmentsByEntry: Record<number, LogAttachmentRow[]> = {};

      if (entryIds.length > 0) {
        const attachmentsResult = await query<LogAttachmentRow>(
          'SELECT * FROM proyecto_bitacora_adjuntos WHERE bitacora_id = ANY($1) ORDER BY created_at ASC',
          [entryIds],
        );

        const signedAttachments = await attachSignedUrls(attachmentsResult.rows);

        // Group attachments by bitacora_id
        signedAttachments.forEach((att) => {
          if (att.bitacora_id) {
            if (!attachmentsByEntry[att.bitacora_id]) {
              attachmentsByEntry[att.bitacora_id] = [];
            }
            attachmentsByEntry[att.bitacora_id].push(att);
          }
        });
      }

      // Add attachments to each entry
      const entriesWithAttachments = result.rows.map((entry) => ({
        ...entry,
        attachments: attachmentsByEntry[entry.id] || [],
      }));

      // Get total count
      const countResult = await query<{ total: string }>(
        'SELECT COUNT(*) as total FROM proyecto_bitacora WHERE proyecto_id = $1',
        [projectId],
      );

      res.json({
        success: true,
        entries: entriesWithAttachments,
        total: parseInt(countResult.rows[0].total),
        limit: parseInt(limit),
        offset: parseInt(offset),
      });
    },
  ),
);

// GET /api/project-bitacora/:entryId - Get single entry with comments and attachments
router.get(
  '/:entryId',
  authenticateToken,
  asyncHandler(
    async (req: Request<{ entryId: string }>, res: Response): Promise<void> => {
      const { entryId } = req.params;

      // Get entry
      const entryResult = await query<LogEntryRow>(
        `
    SELECT
      e.*,
      u.nombre as creador_nombre
    FROM proyecto_bitacora e
    JOIN users u ON e.creado_por = u.id
    WHERE e.id = $1
  `,
        [entryId],
      );

      if (entryResult.rows.length === 0) {
        res
          .status(404)
          .json({ success: false, message: 'Entrada no encontrada' });
        return;
      }

      // Get comments
      const commentsResult = await query<LogCommentRow>(
        `
    SELECT
      c.*,
      u.nombre as creador_nombre
    FROM proyecto_bitacora_comentarios c
    JOIN users u ON c.creado_por = u.id
    WHERE c.bitacora_id = $1
    ORDER BY c.created_at ASC
  `,
        [entryId],
      );

      // Get entry attachments
      const attachmentsResult = await query<LogAttachmentRow>(
        `
    SELECT * FROM proyecto_bitacora_adjuntos
    WHERE bitacora_id = $1
    ORDER BY created_at ASC
  `,
        [entryId],
      );
      const signedEntryAttachments = await attachSignedUrls(
        attachmentsResult.rows,
      );

      // Get comment attachments
      const commentIds = commentsResult.rows.map((c) => c.id);
      const commentAttachments: Record<number, LogAttachmentRow[]> = {};

      if (commentIds.length > 0) {
        const commentAttResult = await query<LogAttachmentRow>(
          'SELECT * FROM proyecto_bitacora_adjuntos WHERE comentario_id = ANY($1) ORDER BY created_at ASC',
          [commentIds],
        );

        const signedCommentAttachments = await attachSignedUrls(
          commentAttResult.rows,
        );

        // Group by comentario_id
        signedCommentAttachments.forEach((att) => {
          if (att.comentario_id) {
            if (!commentAttachments[att.comentario_id]) {
              commentAttachments[att.comentario_id] = [];
            }
            commentAttachments[att.comentario_id].push(att);
          }
        });
      }

      // Add attachments to comments
      const commentsWithAttachments = commentsResult.rows.map((comment) => ({
        ...comment,
        attachments: commentAttachments[comment.id] || [],
      }));

      res.json({
        success: true,
        entry: {
          ...entryResult.rows[0],
          comments: commentsWithAttachments,
          attachments: signedEntryAttachments,
        },
      });
    },
  ),
);

// POST /api/project-bitacora/projects/:projectId - Create entry
router.post(
  '/projects/:projectId',
  authenticateToken,
  upload.array('fotos', 10),
  asyncHandler(
    async (
      req: Request<{ projectId: string }, object, CreateEntryBody>,
      res: Response,
    ): Promise<void> => {
      const { projectId } = req.params;
      const { titulo, contenido } = req.body;
      const userId = req.user!.id;

      if (!contenido || !contenido.trim()) {
        res
          .status(400)
          .json({ success: false, message: 'El contenido es requerido' });
        return;
      }

      // Create entry
      const entryResult = await query<LogEntryRow>(
        `
    INSERT INTO proyecto_bitacora (proyecto_id, titulo, contenido, creado_por)
    VALUES ($1, $2, $3, $4)
    RETURNING *
  `,
        [projectId, titulo || null, contenido.trim(), userId],
      );

      const entry = entryResult.rows[0];

      // Save attachments if any (uploaded to R2 in-memory, then row inserted)
      const files = req.files as Express.Multer.File[];
      if (files && files.length > 0) {
        for (const file of files) {
          const r2Key = buildBitacoraKey(
            { kind: 'entry', entryId: entry.id },
            file.originalname,
          );
          await uploadFile(r2Key, file.buffer, file.mimetype);
          await query(
            `
        INSERT INTO proyecto_bitacora_adjuntos (bitacora_id, nombre_archivo, r2_key, tipo_mime, tamano)
        VALUES ($1, $2, $3, $4, $5)
      `,
            [
              entry.id,
              file.originalname,
              r2Key,
              file.mimetype,
              file.size,
            ],
          );
        }
      }

      // Get complete entry with creator name
      const completeEntry = await query<LogEntryRow>(
        `
    SELECT e.*, u.nombre as creador_nombre
    FROM proyecto_bitacora e
    JOIN users u ON e.creado_por = u.id
    WHERE e.id = $1
  `,
        [entry.id],
      );

      // Get attachments + sign URLs
      const attachments = await query<LogAttachmentRow>(
        'SELECT * FROM proyecto_bitacora_adjuntos WHERE bitacora_id = $1',
        [entry.id],
      );
      const signedAttachments = await attachSignedUrls(attachments.rows);

      res.status(201).json({
        success: true,
        entry: {
          ...completeEntry.rows[0],
          attachments: signedAttachments,
          comment_count: 0,
          attachment_count: signedAttachments.length,
        },
      });
    },
  ),
);

// PUT /api/project-bitacora/:entryId - Update entry
router.put(
  '/:entryId',
  authenticateToken,
  asyncHandler(
    async (
      req: Request<{ entryId: string }, object, CreateEntryBody>,
      res: Response,
    ): Promise<void> => {
      const { entryId } = req.params;
      const { titulo, contenido } = req.body;
      const userId = req.user!.id;

      // Check ownership
      const existing = await query<{ creado_por: number }>(
        'SELECT creado_por FROM proyecto_bitacora WHERE id = $1',
        [entryId],
      );

      if (existing.rows.length === 0) {
        res
          .status(404)
          .json({ success: false, message: 'Entrada no encontrada' });
        return;
      }

      if (existing.rows[0].creado_por !== userId) {
        res
          .status(403)
          .json({ success: false, message: 'No puedes editar esta entrada' });
        return;
      }

      const result = await query<LogEntryRow>(
        `
    UPDATE proyecto_bitacora
    SET titulo = $1, contenido = $2, updated_at = CURRENT_TIMESTAMP
    WHERE id = $3
    RETURNING *
  `,
        [titulo || null, contenido, entryId],
      );

      res.json({
        success: true,
        entry: result.rows[0],
      });
    },
  ),
);

// DELETE /api/project-bitacora/:entryId - Delete entry
router.delete(
  '/:entryId',
  authenticateToken,
  asyncHandler(
    async (req: Request<{ entryId: string }>, res: Response): Promise<void> => {
      const { entryId } = req.params;
      const userId = req.user!.id;
      const isAdmin =
        req.user!.rol === 'admin' || req.user!.rol === 'co-admin';

      // Check ownership
      const existing = await query<{ creado_por: number }>(
        'SELECT creado_por FROM proyecto_bitacora WHERE id = $1',
        [entryId],
      );

      if (existing.rows.length === 0) {
        res
          .status(404)
          .json({ success: false, message: 'Entrada no encontrada' });
        return;
      }

      if (!isAdmin && existing.rows[0].creado_por !== userId) {
        res
          .status(403)
          .json({ success: false, message: 'No puedes eliminar esta entrada' });
        return;
      }

      // Get attachments to delete files
      // Collect all R2 keys for this entry: both the entry's direct
      // attachments and attachments on any of its comments.
      const attachments = await query<{ r2_key: string }>(
        `SELECT r2_key FROM proyecto_bitacora_adjuntos
         WHERE bitacora_id = $1
            OR comentario_id IN (
              SELECT id FROM proyecto_bitacora_comentarios WHERE bitacora_id = $1
            )`,
        [entryId],
      );

      // Delete files from R2 (best-effort)
      for (const att of attachments.rows) {
        if (att.r2_key && att.r2_key.includes('/')) {
          try {
            await deleteFile(att.r2_key);
          } catch (err) {
            console.error('Error deleting R2 file (entry):', err);
          }
        }
      }

      // Delete entry (cascade will delete comments and attachments)
      await query('DELETE FROM proyecto_bitacora WHERE id = $1', [entryId]);

      res.json({ success: true, message: 'Entrada eliminada' });
    },
  ),
);

// ============================================
// COMMENTS ENDPOINTS
// ============================================

// POST /api/project-bitacora/:entryId/comments - Add comment with optional photos
router.post(
  '/:entryId/comments',
  authenticateToken,
  upload.array('fotos', 5),
  asyncHandler(
    async (
      req: Request<{ entryId: string }, object, CommentBody>,
      res: Response,
    ): Promise<void> => {
      const { entryId } = req.params;
      const { contenido } = req.body;
      const userId = req.user!.id;

      // Verify entry exists
      const entryCheck = await query<{ id: number }>(
        'SELECT id FROM proyecto_bitacora WHERE id = $1',
        [entryId],
      );

      if (entryCheck.rows.length === 0) {
        res
          .status(404)
          .json({ success: false, message: 'Entrada no encontrada' });
        return;
      }

      // Create comment
      const result = await query<LogCommentRow>(
        `
    INSERT INTO proyecto_bitacora_comentarios (bitacora_id, contenido, creado_por)
    VALUES ($1, $2, $3)
    RETURNING *
  `,
        [entryId, contenido || '', userId],
      );

      const comment = result.rows[0];

      // Save attachments if any (R2 upload then DB insert)
      const attachments: LogAttachmentRow[] = [];
      const files = req.files as Express.Multer.File[];
      if (files && files.length > 0) {
        for (const file of files) {
          const r2Key = buildBitacoraKey(
            { kind: 'comment', commentId: comment.id },
            file.originalname,
          );
          await uploadFile(r2Key, file.buffer, file.mimetype);
          const attResult = await query<LogAttachmentRow>(
            `
        INSERT INTO proyecto_bitacora_adjuntos (comentario_id, nombre_archivo, r2_key, tipo_mime, tamano)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING *
      `,
            [
              comment.id,
              file.originalname,
              r2Key,
              file.mimetype,
              file.size,
            ],
          );
          attachments.push(attResult.rows[0]);
        }
      }
      const signedAttachments = await attachSignedUrls(attachments);

      // Get user name
      const userResult = await query<{ nombre: string }>(
        'SELECT nombre FROM users WHERE id = $1',
        [userId],
      );

      res.status(201).json({
        success: true,
        comment: {
          ...comment,
          creador_nombre: userResult.rows[0]?.nombre,
          attachments: signedAttachments,
        },
      });
    },
  ),
);

// DELETE /api/project-bitacora/comments/:commentId - Delete comment
router.delete(
  '/comments/:commentId',
  authenticateToken,
  asyncHandler(
    async (
      req: Request<{ commentId: string }>,
      res: Response,
    ): Promise<void> => {
      const { commentId } = req.params;
      const userId = req.user!.id;
      const isAdmin =
        req.user!.rol === 'admin' || req.user!.rol === 'co-admin';

      // Verify comment exists and capture ownership
      const existing = await query<{ creado_por: number }>(
        'SELECT creado_por FROM proyecto_bitacora_comentarios WHERE id = $1',
        [commentId],
      );

      if (existing.rows.length === 0) {
        res.status(404).json({
          success: false,
          message: 'Comentario no encontrado',
        });
        return;
      }

      if (!isAdmin && existing.rows[0].creado_por !== userId) {
        res.status(403).json({
          success: false,
          message: 'No tienes permiso para eliminar este comentario',
        });
        return;
      }

      // Get attachments to delete from R2
      const attachments = await query<{ r2_key: string }>(
        'SELECT r2_key FROM proyecto_bitacora_adjuntos WHERE comentario_id = $1',
        [commentId],
      );

      // Delete files from R2 (best-effort: log on failure, don't block DB delete)
      for (const att of attachments.rows) {
        if (att.r2_key && att.r2_key.includes('/')) {
          try {
            await deleteFile(att.r2_key);
          } catch (err) {
            console.error('Error deleting R2 file (comment):', err);
          }
        }
      }

      const result = await query<{ id: number }>(
        'DELETE FROM proyecto_bitacora_comentarios WHERE id = $1 RETURNING id',
        [commentId],
      );

      if (result.rows.length === 0) {
        res.status(404).json({
          success: false,
          message:
            'Comentario no encontrado o no tienes permiso para eliminarlo',
        });
        return;
      }

      res.json({ success: true, message: 'Comentario eliminado' });
    },
  ),
);

// ============================================
// ATTACHMENTS ENDPOINTS
// ============================================

// POST /api/project-bitacora/:entryId/attachments - Add attachments to existing entry
router.post(
  '/:entryId/attachments',
  authenticateToken,
  upload.array('fotos', 10),
  asyncHandler(
    async (req: Request<{ entryId: string }>, res: Response): Promise<void> => {
      const { entryId } = req.params;
      const userId = req.user!.id;

      // Verify entry exists and user owns it
      const entryCheck = await query<{ creado_por: number }>(
        'SELECT creado_por FROM proyecto_bitacora WHERE id = $1',
        [entryId],
      );

      if (entryCheck.rows.length === 0) {
        res
          .status(404)
          .json({ success: false, message: 'Entrada no encontrada' });
        return;
      }

      if (entryCheck.rows[0].creado_por !== userId) {
        res.status(403).json({
          success: false,
          message: 'No puedes agregar fotos a esta entrada',
        });
        return;
      }

      const files = req.files as Express.Multer.File[];
      if (!files || files.length === 0) {
        res
          .status(400)
          .json({ success: false, message: 'No se recibieron archivos' });
        return;
      }

      const attachments: LogAttachmentRow[] = [];
      for (const file of files) {
        const r2Key = buildBitacoraKey(
          { kind: 'entry', entryId: parseInt(entryId) },
          file.originalname,
        );
        await uploadFile(r2Key, file.buffer, file.mimetype);
        const result = await query<LogAttachmentRow>(
          `
      INSERT INTO proyecto_bitacora_adjuntos (bitacora_id, nombre_archivo, r2_key, tipo_mime, tamano)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `,
          [entryId, file.originalname, r2Key, file.mimetype, file.size],
        );
        attachments.push(result.rows[0]);
      }
      const signedAttachments = await attachSignedUrls(attachments);

      res.status(201).json({
        success: true,
        attachments: signedAttachments,
      });
    },
  ),
);

// DELETE /api/project-bitacora/attachments/:attachmentId - Delete attachment
router.delete(
  '/attachments/:attachmentId',
  authenticateToken,
  asyncHandler(
    async (
      req: Request<{ attachmentId: string }>,
      res: Response,
    ): Promise<void> => {
      const { attachmentId } = req.params;
      const userId = req.user!.id;
      const isAdmin =
        req.user!.rol === 'admin' || req.user!.rol === 'co-admin';

      // Get attachment and verify ownership
      const attachment = await query<LogAttachmentRow & { creado_por: number }>(
        `
    SELECT a.*, e.creado_por
    FROM proyecto_bitacora_adjuntos a
    JOIN proyecto_bitacora e ON a.bitacora_id = e.id
    WHERE a.id = $1
  `,
        [attachmentId],
      );

      if (attachment.rows.length === 0) {
        res
          .status(404)
          .json({ success: false, message: 'Archivo no encontrado' });
        return;
      }

      if (!isAdmin && attachment.rows[0].creado_por !== userId) {
        res
          .status(403)
          .json({ success: false, message: 'No puedes eliminar este archivo' });
        return;
      }

      // Delete file from R2 (best-effort)
      const r2Key = attachment.rows[0].r2_key;
      if (r2Key && r2Key.includes('/')) {
        try {
          await deleteFile(r2Key);
        } catch (err) {
          console.error('Error deleting R2 file (attachment):', err);
        }
      }

      // Delete from database
      await query('DELETE FROM proyecto_bitacora_adjuntos WHERE id = $1', [
        attachmentId,
      ]);

      res.json({ success: true, message: 'Archivo eliminado' });
    },
  ),
);

export default router;
