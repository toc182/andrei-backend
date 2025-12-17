/**
 * Project Bitacora (Log) Routes
 * Endpoints for managing project log entries, comments, and attachments
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { query } = require('../database/config');
const { authenticateToken } = require('../middleware/auth');
const { body, validationResult } = require('express-validator');

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, '../uploads/bitacora');
    // Create directory if it doesn't exist
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    // Generate unique filename: timestamp-originalname
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, uniqueSuffix + ext);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB max
  },
  fileFilter: (req, file, cb) => {
    // Allow images only
    const allowedTypes = /jpeg|jpg|png|gif|webp/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    if (extname && mimetype) {
      cb(null, true);
    } else {
      cb(new Error('Solo se permiten imágenes (jpeg, jpg, png, gif, webp)'));
    }
  }
});

// ============================================
// LOG ENTRIES ENDPOINTS
// ============================================

// GET /api/project-bitacora/projects/:projectId - List entries for a project
router.get('/projects/:projectId', authenticateToken, async (req, res) => {
  try {
    const { projectId } = req.params;
    const { limit = 20, offset = 0 } = req.query;

    // Get entries with creator info and counts
    const result = await query(`
      SELECT
        e.*,
        u.nombre as creador_nombre,
        (SELECT COUNT(*) FROM project_log_comments WHERE entry_id = e.id) as comment_count,
        (
          SELECT COUNT(*) FROM project_log_attachments
          WHERE entry_id = e.id
          OR comment_id IN (SELECT id FROM project_log_comments WHERE entry_id = e.id)
        ) as attachment_count
      FROM project_log_entries e
      JOIN users u ON e.created_by = u.id
      WHERE e.project_id = $1
      ORDER BY e.created_at DESC
      LIMIT $2 OFFSET $3
    `, [projectId, limit, offset]);

    // Get attachments for all entries
    const entryIds = result.rows.map(e => e.id);
    let attachmentsByEntry = {};

    if (entryIds.length > 0) {
      const attachmentsResult = await query(
        'SELECT * FROM project_log_attachments WHERE entry_id = ANY($1) ORDER BY created_at ASC',
        [entryIds]
      );

      // Group attachments by entry_id
      attachmentsResult.rows.forEach(att => {
        if (!attachmentsByEntry[att.entry_id]) {
          attachmentsByEntry[att.entry_id] = [];
        }
        attachmentsByEntry[att.entry_id].push(att);
      });
    }

    // Add attachments to each entry
    const entriesWithAttachments = result.rows.map(entry => ({
      ...entry,
      attachments: attachmentsByEntry[entry.id] || []
    }));

    // Get total count
    const countResult = await query(
      'SELECT COUNT(*) as total FROM project_log_entries WHERE project_id = $1',
      [projectId]
    );

    res.json({
      success: true,
      entries: entriesWithAttachments,
      total: parseInt(countResult.rows[0].total),
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
  } catch (error) {
    console.error('Error fetching log entries:', error);
    res.status(500).json({ success: false, message: 'Error al obtener entradas' });
  }
});

// GET /api/project-bitacora/:entryId - Get single entry with comments and attachments
router.get('/:entryId', authenticateToken, async (req, res) => {
  try {
    const { entryId } = req.params;

    // Get entry
    const entryResult = await query(`
      SELECT
        e.*,
        u.nombre as creador_nombre
      FROM project_log_entries e
      JOIN users u ON e.created_by = u.id
      WHERE e.id = $1
    `, [entryId]);

    if (entryResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Entrada no encontrada' });
    }

    // Get comments
    const commentsResult = await query(`
      SELECT
        c.*,
        u.nombre as creador_nombre
      FROM project_log_comments c
      JOIN users u ON c.created_by = u.id
      WHERE c.entry_id = $1
      ORDER BY c.created_at ASC
    `, [entryId]);

    // Get entry attachments
    const attachmentsResult = await query(`
      SELECT * FROM project_log_attachments
      WHERE entry_id = $1
      ORDER BY created_at ASC
    `, [entryId]);

    // Get comment attachments
    const commentIds = commentsResult.rows.map(c => c.id);
    let commentAttachments = {};

    if (commentIds.length > 0) {
      const commentAttResult = await query(
        'SELECT * FROM project_log_attachments WHERE comment_id = ANY($1) ORDER BY created_at ASC',
        [commentIds]
      );

      // Group by comment_id
      commentAttResult.rows.forEach(att => {
        if (!commentAttachments[att.comment_id]) {
          commentAttachments[att.comment_id] = [];
        }
        commentAttachments[att.comment_id].push(att);
      });
    }

    // Add attachments to comments
    const commentsWithAttachments = commentsResult.rows.map(comment => ({
      ...comment,
      attachments: commentAttachments[comment.id] || []
    }));

    res.json({
      success: true,
      entry: {
        ...entryResult.rows[0],
        comments: commentsWithAttachments,
        attachments: attachmentsResult.rows
      }
    });
  } catch (error) {
    console.error('Error fetching log entry:', error);
    res.status(500).json({ success: false, message: 'Error al obtener entrada' });
  }
});

// POST /api/project-bitacora/projects/:projectId - Create entry
router.post('/projects/:projectId', authenticateToken, upload.array('fotos', 10), async (req, res) => {
  try {
    const { projectId } = req.params;
    const { titulo, contenido } = req.body;
    const userId = req.user.id;

    if (!contenido || !contenido.trim()) {
      return res.status(400).json({ success: false, message: 'El contenido es requerido' });
    }

    // Create entry
    const entryResult = await query(`
      INSERT INTO project_log_entries (project_id, titulo, contenido, created_by)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [projectId, titulo || null, contenido.trim(), userId]);

    const entry = entryResult.rows[0];

    // Save attachments if any
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        await query(`
          INSERT INTO project_log_attachments (entry_id, filename, filepath, mimetype, size)
          VALUES ($1, $2, $3, $4, $5)
        `, [entry.id, file.originalname, file.filename, file.mimetype, file.size]);
      }
    }

    // Get complete entry with creator name
    const completeEntry = await query(`
      SELECT e.*, u.nombre as creador_nombre
      FROM project_log_entries e
      JOIN users u ON e.created_by = u.id
      WHERE e.id = $1
    `, [entry.id]);

    // Get attachments
    const attachments = await query(
      'SELECT * FROM project_log_attachments WHERE entry_id = $1',
      [entry.id]
    );

    res.status(201).json({
      success: true,
      entry: {
        ...completeEntry.rows[0],
        attachments: attachments.rows,
        comment_count: 0,
        attachment_count: attachments.rows.length
      }
    });
  } catch (error) {
    console.error('Error creating log entry:', error);
    res.status(500).json({ success: false, message: 'Error al crear entrada' });
  }
});

// PUT /api/project-bitacora/:entryId - Update entry
router.put('/:entryId', authenticateToken, async (req, res) => {
  try {
    const { entryId } = req.params;
    const { titulo, contenido } = req.body;
    const userId = req.user.id;

    // Check ownership
    const existing = await query(
      'SELECT created_by FROM project_log_entries WHERE id = $1',
      [entryId]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Entrada no encontrada' });
    }

    if (existing.rows[0].created_by !== userId) {
      return res.status(403).json({ success: false, message: 'No puedes editar esta entrada' });
    }

    const result = await query(`
      UPDATE project_log_entries
      SET titulo = $1, contenido = $2, updated_at = CURRENT_TIMESTAMP
      WHERE id = $3
      RETURNING *
    `, [titulo || null, contenido, entryId]);

    res.json({
      success: true,
      entry: result.rows[0]
    });
  } catch (error) {
    console.error('Error updating log entry:', error);
    res.status(500).json({ success: false, message: 'Error al actualizar entrada' });
  }
});

// DELETE /api/project-bitacora/:entryId - Delete entry
router.delete('/:entryId', authenticateToken, async (req, res) => {
  try {
    const { entryId } = req.params;
    const userId = req.user.id;

    // Check ownership
    const existing = await query(
      'SELECT created_by FROM project_log_entries WHERE id = $1',
      [entryId]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Entrada no encontrada' });
    }

    if (existing.rows[0].created_by !== userId) {
      return res.status(403).json({ success: false, message: 'No puedes eliminar esta entrada' });
    }

    // Get attachments to delete files
    const attachments = await query(
      'SELECT filepath FROM project_log_attachments WHERE entry_id = $1',
      [entryId]
    );

    // Delete files from disk
    for (const att of attachments.rows) {
      const filePath = path.join(__dirname, '../uploads/bitacora', att.filepath);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }

    // Delete entry (cascade will delete comments and attachments)
    await query('DELETE FROM project_log_entries WHERE id = $1', [entryId]);

    res.json({ success: true, message: 'Entrada eliminada' });
  } catch (error) {
    console.error('Error deleting log entry:', error);
    res.status(500).json({ success: false, message: 'Error al eliminar entrada' });
  }
});

// ============================================
// COMMENTS ENDPOINTS
// ============================================

// POST /api/project-bitacora/:entryId/comments - Add comment with optional photos
router.post('/:entryId/comments', authenticateToken, upload.array('fotos', 5), async (req, res) => {
  try {
    const { entryId } = req.params;
    const { contenido } = req.body;
    const userId = req.user.id;

    // Verify entry exists
    const entryCheck = await query(
      'SELECT id FROM project_log_entries WHERE id = $1',
      [entryId]
    );

    if (entryCheck.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Entrada no encontrada' });
    }

    // Create comment
    const result = await query(`
      INSERT INTO project_log_comments (entry_id, contenido, created_by)
      VALUES ($1, $2, $3)
      RETURNING *
    `, [entryId, contenido || '', userId]);

    const comment = result.rows[0];

    // Save attachments if any
    const attachments = [];
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        const attResult = await query(`
          INSERT INTO project_log_attachments (comment_id, filename, filepath, mimetype, size)
          VALUES ($1, $2, $3, $4, $5)
          RETURNING *
        `, [comment.id, file.originalname, file.filename, file.mimetype, file.size]);
        attachments.push(attResult.rows[0]);
      }
    }

    // Get user name
    const userResult = await query('SELECT nombre FROM users WHERE id = $1', [userId]);

    res.status(201).json({
      success: true,
      comment: {
        ...comment,
        creador_nombre: userResult.rows[0]?.nombre,
        attachments
      }
    });
  } catch (error) {
    console.error('Error adding comment:', error);
    res.status(500).json({ success: false, message: 'Error al agregar comentario' });
  }
});

// DELETE /api/project-bitacora/comments/:commentId - Delete comment
router.delete('/comments/:commentId', authenticateToken, async (req, res) => {
  try {
    const { commentId } = req.params;
    const userId = req.user.id;

    // Get attachments to delete files
    const attachments = await query(
      'SELECT filepath FROM project_log_attachments WHERE comment_id = $1',
      [commentId]
    );

    // Delete files from disk
    for (const att of attachments.rows) {
      const filePath = path.join(__dirname, '../uploads/bitacora', att.filepath);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }

    const result = await query(
      'DELETE FROM project_log_comments WHERE id = $1 AND created_by = $2 RETURNING id',
      [commentId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Comentario no encontrado o no tienes permiso para eliminarlo'
      });
    }

    res.json({ success: true, message: 'Comentario eliminado' });
  } catch (error) {
    console.error('Error deleting comment:', error);
    res.status(500).json({ success: false, message: 'Error al eliminar comentario' });
  }
});

// ============================================
// ATTACHMENTS ENDPOINTS
// ============================================

// POST /api/project-bitacora/:entryId/attachments - Add attachments to existing entry
router.post('/:entryId/attachments', authenticateToken, upload.array('fotos', 10), async (req, res) => {
  try {
    const { entryId } = req.params;
    const userId = req.user.id;

    // Verify entry exists and user owns it
    const entryCheck = await query(
      'SELECT created_by FROM project_log_entries WHERE id = $1',
      [entryId]
    );

    if (entryCheck.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Entrada no encontrada' });
    }

    if (entryCheck.rows[0].created_by !== userId) {
      return res.status(403).json({ success: false, message: 'No puedes agregar fotos a esta entrada' });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ success: false, message: 'No se recibieron archivos' });
    }

    const attachments = [];
    for (const file of req.files) {
      const result = await query(`
        INSERT INTO project_log_attachments (entry_id, filename, filepath, mimetype, size)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING *
      `, [entryId, file.originalname, file.filename, file.mimetype, file.size]);
      attachments.push(result.rows[0]);
    }

    res.status(201).json({
      success: true,
      attachments
    });
  } catch (error) {
    console.error('Error adding attachments:', error);
    res.status(500).json({ success: false, message: 'Error al agregar fotos' });
  }
});

// DELETE /api/project-bitacora/attachments/:attachmentId - Delete attachment
router.delete('/attachments/:attachmentId', authenticateToken, async (req, res) => {
  try {
    const { attachmentId } = req.params;
    const userId = req.user.id;

    // Get attachment and verify ownership
    const attachment = await query(`
      SELECT a.*, e.created_by
      FROM project_log_attachments a
      JOIN project_log_entries e ON a.entry_id = e.id
      WHERE a.id = $1
    `, [attachmentId]);

    if (attachment.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Archivo no encontrado' });
    }

    if (attachment.rows[0].created_by !== userId) {
      return res.status(403).json({ success: false, message: 'No puedes eliminar este archivo' });
    }

    // Delete file from disk
    const filePath = path.join(__dirname, '../uploads/bitacora', attachment.rows[0].filepath);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    // Delete from database
    await query('DELETE FROM project_log_attachments WHERE id = $1', [attachmentId]);

    res.json({ success: true, message: 'Archivo eliminado' });
  } catch (error) {
    console.error('Error deleting attachment:', error);
    res.status(500).json({ success: false, message: 'Error al eliminar archivo' });
  }
});

module.exports = router;
