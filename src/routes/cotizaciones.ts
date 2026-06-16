// Cotizaciones — the purchasing team's quote pool.
//
// A cotizacion (request, e.g. "Cemento gris — 100 sacos") holds N
// cotizacion_ofertas (one per supplier: proveedor, monto, nota), each
// with N cotizacion_archivos in R2. One oferta per cotizacion can be
// marked elegida. proyecto_id is nullable ("Oficina / General").
//
// Route ordering matters: every static-prefix route (/ofertas/...,
// /archivos/...) is declared BEFORE /:id so Express never captures
// them as an id.

import { Router, Request, Response, NextFunction } from 'express';
import { body, param, validationResult } from 'express-validator';
import multer from 'multer';
import crypto from 'crypto';
import { query, pool } from '../database/config.js';
import { authenticateToken, checkPermission } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { registrarAudit } from '../services/auditLog.js';
import {
  uploadFile,
  deleteFile,
  getFileSignedUrl,
} from '../services/storage.js';
import { fixUploadEncoding } from '../utils/fileEncoding.js';

const router = Router();

// Módulo no ligado a proyectos: sin checkProjectAccess. admin/co-admin
// pasan checkPermission automáticamente.
router.use(authenticateToken, checkPermission('cotizaciones'));

// Multer: memoria, 10MB, máximo 5 archivos, PDF/JPG/PNG — consistente
// con solicitud_pago_adjuntos.
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

// Traduce errores de multer a 400 JSON antes de llegar al handler.
function handleUpload(req: Request, res: Response, next: NextFunction): void {
  upload.array('archivos', 5)(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        res.status(400).json({
          success: false,
          message: 'El archivo excede el limite de 10MB',
        });
        return;
      }
      if (err.code === 'LIMIT_UNEXPECTED_FILE') {
        res
          .status(400)
          .json({ success: false, message: 'Maximo 5 archivos por subida' });
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
}

function sanitizeFilename(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_');
}

interface OfertaInput {
  proveedor: string;
  monto?: number | null;
  nota?: string | null;
}

// --- GET / — listado tab "Por solicitud" ---
router.get(
  '/',
  asyncHandler(async (_req: Request, res: Response): Promise<void> => {
    const result = await query(
      `SELECT c.id, c.descripcion, c.descripcion_larga, c.tipo, c.proyecto_id, c.ambito,
              COALESCE(NULLIF(p.nombre_corto, ''), p.nombre) AS proyecto_nombre, c.created_at
       FROM cotizaciones c
       LEFT JOIN proyectos p ON p.id = c.proyecto_id
       WHERE c.activo = TRUE
       ORDER BY c.created_at DESC`,
    );
    res.json({ success: true, data: result.rows });
  }),
);

// --- GET /ofertas — listado plano tab "Por proveedor" ---
router.get(
  '/ofertas',
  asyncHandler(async (_req: Request, res: Response): Promise<void> => {
    const result = await query(
      `SELECT o.id, o.cotizacion_id, o.proveedor, o.monto, o.nota, o.elegida,
              o.created_at, c.descripcion, c.tipo, c.proyecto_id, c.ambito,
              COALESCE(NULLIF(p.nombre_corto, ''), p.nombre) AS proyecto_nombre, u.nombre AS agregado_por_nombre,
              COUNT(a.id)::int AS archivos_count
       FROM cotizacion_ofertas o
       JOIN cotizaciones c ON c.id = o.cotizacion_id AND c.activo = TRUE
       LEFT JOIN proyectos p ON p.id = c.proyecto_id
       LEFT JOIN users u ON u.id = o.creado_por
       LEFT JOIN cotizacion_archivos a ON a.oferta_id = o.id
       WHERE o.activo = TRUE
       GROUP BY o.id, c.descripcion, c.tipo, c.proyecto_id, c.ambito, p.nombre_corto, p.nombre, u.nombre
       ORDER BY o.created_at DESC`,
    );
    res.json({ success: true, data: result.rows });
  }),
);

// --- POST / — crear cotización (+ primera oferta opcional, transaccional) ---
router.post(
  '/',
  [
    body('descripcion').isString().trim().notEmpty().isLength({ max: 255 }),
    body('descripcion_larga').optional({ nullable: true }).isString(),
    body('tipo').optional({ nullable: true }).isIn(['producto', 'servicio']),
    body('proyecto_id').optional({ nullable: true }).isInt(),
    body('ambito').optional({ nullable: true }).isIn(['oficina', 'otros']),
    body('oferta').optional().isObject(),
    body('oferta.proveedor').if(body('oferta').exists()).isString().trim().notEmpty(),
    body('oferta.monto').optional({ nullable: true }).isFloat({ min: 0 }),
    body('oferta.nota').optional({ nullable: true }).isString(),
  ],
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, error: 'Datos inválidos' });
      return;
    }

    const user = req.user!;
    const { descripcion, descripcion_larga, tipo, proyecto_id, ambito } = req.body;
    const oferta = req.body.oferta as OfertaInput | undefined;

    const client = await pool.connect();
    let cotizacionRow;
    let ofertaRow = null;
    try {
      await client.query('BEGIN');

      const insertCot = await client.query(
        `INSERT INTO cotizaciones (descripcion, descripcion_larga, tipo, proyecto_id, ambito, creado_por)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [
          (descripcion as string).trim(),
          descripcion_larga || null,
          tipo || null,
          proyecto_id ?? null,
          ambito || null,
          user.id,
        ],
      );
      cotizacionRow = insertCot.rows[0];

      if (oferta?.proveedor) {
        const insertOferta = await client.query(
          `INSERT INTO cotizacion_ofertas (cotizacion_id, proveedor, monto, nota, creado_por)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING *`,
          [
            cotizacionRow.id,
            oferta.proveedor.trim(),
            oferta.monto ?? null,
            oferta.nota || null,
            user.id,
          ],
        );
        ofertaRow = insertOferta.rows[0];
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    await registrarAudit(user.id, 'crear', 'cotizacion', cotizacionRow.id, {
      descripcion: cotizacionRow.descripcion,
    });
    if (ofertaRow) {
      await registrarAudit(user.id, 'crear', 'cotizacion_oferta', ofertaRow.id, {
        cotizacion_id: cotizacionRow.id,
        proveedor: ofertaRow.proveedor,
      });
    }

    res.status(201).json({
      success: true,
      data: { cotizacion: cotizacionRow, oferta: ofertaRow },
    });
  }),
);

// --- POST /ofertas/:ofertaId/archivos — subir archivos a una oferta ---
router.post(
  '/ofertas/:ofertaId/archivos',
  [param('ofertaId').isInt()],
  handleUpload,
  fixUploadEncoding,
  asyncHandler(
    async (req: Request<{ ofertaId: string }>, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({ success: false, error: 'Datos inválidos' });
        return;
      }

      const user = req.user!;
      const ofertaId = Number(req.params.ofertaId);
      const files = req.files as Express.Multer.File[];

      if (!files || files.length === 0) {
        res
          .status(400)
          .json({ success: false, message: 'No se recibieron archivos' });
        return;
      }

      const oferta = await query(
        'SELECT id FROM cotizacion_ofertas WHERE id = $1 AND activo = TRUE',
        [ofertaId],
      );
      if (oferta.rows.length === 0) {
        res
          .status(404)
          .json({ success: false, message: 'Oferta no encontrada' });
        return;
      }

      const uploaded: Array<{
        originalname: string;
        r2Key: string;
        mimetype: string;
        size: number;
      }> = [];
      for (const file of files) {
        const r2Key = `cotizaciones/${ofertaId}/${crypto.randomUUID()}_${sanitizeFilename(file.originalname)}`;
        await uploadFile(r2Key, file.buffer, file.mimetype);
        uploaded.push({
          originalname: file.originalname,
          r2Key,
          mimetype: file.mimetype,
          size: file.size,
        });
      }

      const values = uploaded
        .map((_, i) => {
          const b = i * 5;
          return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${uploaded.length * 5 + 1})`;
        })
        .join(', ');
      const params: unknown[] = uploaded.flatMap((f) => [
        ofertaId,
        f.originalname,
        f.r2Key,
        f.mimetype,
        f.size,
      ]);
      params.push(user.id);
      const inserted = await query(
        `INSERT INTO cotizacion_archivos (oferta_id, nombre_original, r2_key, tipo_mime, tamano, subido_por)
         VALUES ${values}
         RETURNING *`,
        params,
      );

      await registrarAudit(user.id, 'subir_archivos', 'cotizacion_oferta', ofertaId, {
        count: inserted.rows.length,
        nombres: uploaded.map((f) => f.originalname),
      });

      res.status(201).json({ success: true, data: inserted.rows });
    },
  ),
);

// --- GET /ofertas/:ofertaId/archivos — listar archivos ---
router.get(
  '/ofertas/:ofertaId/archivos',
  [param('ofertaId').isInt()],
  asyncHandler(
    async (req: Request<{ ofertaId: string }>, res: Response): Promise<void> => {
      const result = await query(
        `SELECT a.id, a.nombre_original, a.tipo_mime, a.tamano, a.created_at,
                u.nombre AS subido_por_nombre
         FROM cotizacion_archivos a
         LEFT JOIN users u ON u.id = a.subido_por
         WHERE a.oferta_id = $1
         ORDER BY a.created_at ASC`,
        [req.params.ofertaId],
      );
      res.json({ success: true, data: result.rows });
    },
  ),
);

// --- GET /ofertas/:ofertaId/archivos/urls — URLs firmadas en lote ---
router.get(
  '/ofertas/:ofertaId/archivos/urls',
  [param('ofertaId').isInt()],
  asyncHandler(
    async (req: Request<{ ofertaId: string }>, res: Response): Promise<void> => {
      const result = await query<{ id: number; r2_key: string; tipo_mime: string }>(
        'SELECT id, r2_key, tipo_mime FROM cotizacion_archivos WHERE oferta_id = $1',
        [req.params.ofertaId],
      );
      const data = await Promise.all(
        result.rows.map(async (row) => ({
          id: row.id,
          url: await getFileSignedUrl(row.r2_key),
          tipo_mime: row.tipo_mime,
        })),
      );
      res.json({ success: true, data });
    },
  ),
);

// --- PUT /ofertas/:ofertaId — editar oferta ---
router.put(
  '/ofertas/:ofertaId',
  [
    param('ofertaId').isInt(),
    body('proveedor').isString().trim().notEmpty().isLength({ max: 255 }),
    body('monto').optional({ nullable: true }).isFloat({ min: 0 }),
    body('nota').optional({ nullable: true }).isString(),
  ],
  asyncHandler(
    async (req: Request<{ ofertaId: string }>, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({ success: false, error: 'Datos inválidos' });
        return;
      }

      const user = req.user!;
      const ofertaId = Number(req.params.ofertaId);
      const { proveedor, monto, nota } = req.body;

      const result = await query(
        `UPDATE cotizacion_ofertas
         SET proveedor = $1, monto = $2, nota = $3
         WHERE id = $4 AND activo = TRUE
         RETURNING *`,
        [(proveedor as string).trim(), monto ?? null, nota || null, ofertaId],
      );
      if (result.rows.length === 0) {
        res
          .status(404)
          .json({ success: false, message: 'Oferta no encontrada' });
        return;
      }

      await registrarAudit(user.id, 'editar', 'cotizacion_oferta', ofertaId, {
        proveedor,
      });
      res.json({ success: true, data: result.rows[0] });
    },
  ),
);

// --- PUT /ofertas/:ofertaId/eleccion — marcar/quitar elegida ---
router.put(
  '/ofertas/:ofertaId/eleccion',
  [param('ofertaId').isInt(), body('elegida').isBoolean()],
  asyncHandler(
    async (req: Request<{ ofertaId: string }>, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({ success: false, error: 'Datos inválidos' });
        return;
      }

      const user = req.user!;
      const ofertaId = Number(req.params.ofertaId);
      const elegida = req.body.elegida as boolean;

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const cur = await client.query<{ cotizacion_id: number }>(
          'SELECT cotizacion_id FROM cotizacion_ofertas WHERE id = $1 AND activo = TRUE FOR UPDATE',
          [ofertaId],
        );
        if (cur.rows.length === 0) {
          await client.query('ROLLBACK');
          res
            .status(404)
            .json({ success: false, message: 'Oferta no encontrada' });
          return;
        }

        // Limpia todas y marca una: garantiza una sola elegida por
        // cotización (el índice único parcial es el respaldo).
        await client.query(
          'UPDATE cotizacion_ofertas SET elegida = FALSE WHERE cotizacion_id = $1',
          [cur.rows[0].cotizacion_id],
        );
        if (elegida) {
          await client.query(
            'UPDATE cotizacion_ofertas SET elegida = TRUE WHERE id = $1',
            [ofertaId],
          );
        }

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      await registrarAudit(
        user.id,
        elegida ? 'elegir_oferta' : 'quitar_eleccion',
        'cotizacion_oferta',
        ofertaId,
        {},
      );
      res.json({ success: true });
    },
  ),
);

// --- DELETE /ofertas/:ofertaId — soft delete de oferta ---
router.delete(
  '/ofertas/:ofertaId',
  [param('ofertaId').isInt()],
  asyncHandler(
    async (req: Request<{ ofertaId: string }>, res: Response): Promise<void> => {
      const user = req.user!;
      const ofertaId = Number(req.params.ofertaId);

      // Soft delete: los objetos R2 se conservan (recuperable).
      const result = await query(
        `UPDATE cotizacion_ofertas SET elegida = FALSE, activo = FALSE
         WHERE id = $1 AND activo = TRUE
         RETURNING id, proveedor`,
        [ofertaId],
      );
      if (result.rows.length === 0) {
        res
          .status(404)
          .json({ success: false, message: 'Oferta no encontrada' });
        return;
      }

      await registrarAudit(user.id, 'eliminar', 'cotizacion_oferta', ofertaId, {
        proveedor: result.rows[0].proveedor,
      });
      res.json({ success: true });
    },
  ),
);

// --- GET /archivos/:archivoId/download — URL firmada individual ---
router.get(
  '/archivos/:archivoId/download',
  [param('archivoId').isInt()],
  asyncHandler(
    async (req: Request<{ archivoId: string }>, res: Response): Promise<void> => {
      const result = await query<{ r2_key: string }>(
        'SELECT r2_key FROM cotizacion_archivos WHERE id = $1',
        [req.params.archivoId],
      );
      if (result.rows.length === 0) {
        res
          .status(404)
          .json({ success: false, message: 'Archivo no encontrado' });
        return;
      }
      const url = await getFileSignedUrl(result.rows[0].r2_key);
      res.json({ success: true, data: { url } });
    },
  ),
);

// --- DELETE /archivos/:archivoId — hard delete de archivo ---
router.delete(
  '/archivos/:archivoId',
  [param('archivoId').isInt()],
  asyncHandler(
    async (req: Request<{ archivoId: string }>, res: Response): Promise<void> => {
      const user = req.user!;
      const archivoId = Number(req.params.archivoId);

      const result = await query<{
        r2_key: string;
        nombre_original: string;
        oferta_id: number;
      }>(
        'SELECT r2_key, nombre_original, oferta_id FROM cotizacion_archivos WHERE id = $1',
        [archivoId],
      );
      if (result.rows.length === 0) {
        res
          .status(404)
          .json({ success: false, message: 'Archivo no encontrado' });
        return;
      }

      try {
        await deleteFile(result.rows[0].r2_key);
      } catch (err) {
        console.error('Error deleting file from R2:', err);
      }
      await query('DELETE FROM cotizacion_archivos WHERE id = $1', [archivoId]);

      await registrarAudit(
        user.id,
        'eliminar_archivo',
        'cotizacion_oferta',
        result.rows[0].oferta_id,
        { archivoId, nombre: result.rows[0].nombre_original },
      );
      res.json({ success: true });
    },
  ),
);

// --- GET /:id — detalle de cotización con ofertas ---
router.get(
  '/:id',
  [param('id').isInt()],
  asyncHandler(
    async (req: Request<{ id: string }>, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({ success: false, error: 'Datos inválidos' });
        return;
      }

      const { id } = req.params;

      const cot = await query(
        `SELECT c.*, COALESCE(NULLIF(p.nombre_corto, ''), p.nombre) AS proyecto_nombre, u.nombre AS pedido_por_nombre
         FROM cotizaciones c
         LEFT JOIN proyectos p ON p.id = c.proyecto_id
         LEFT JOIN users u ON u.id = c.creado_por
         WHERE c.id = $1 AND c.activo = TRUE`,
        [id],
      );
      if (cot.rows.length === 0) {
        res
          .status(404)
          .json({ success: false, message: 'Cotización no encontrada' });
        return;
      }

      const ofertas = await query(
        `SELECT o.id, o.proveedor, o.monto, o.nota, o.elegida, o.created_at,
                u.nombre AS creado_por_nombre,
                COUNT(a.id)::int AS archivos_count
         FROM cotizacion_ofertas o
         LEFT JOIN users u ON u.id = o.creado_por
         LEFT JOIN cotizacion_archivos a ON a.oferta_id = o.id
         WHERE o.cotizacion_id = $1 AND o.activo = TRUE
         GROUP BY o.id, u.nombre
         ORDER BY o.created_at ASC`,
        [id],
      );

      res.json({
        success: true,
        data: { ...cot.rows[0], ofertas: ofertas.rows },
      });
    },
  ),
);

// --- PUT /:id — editar cotización ---
router.put(
  '/:id',
  [
    param('id').isInt(),
    body('descripcion').isString().trim().notEmpty().isLength({ max: 255 }),
    body('descripcion_larga').optional({ nullable: true }).isString(),
    body('tipo').optional({ nullable: true }).isIn(['producto', 'servicio']),
    body('proyecto_id').optional({ nullable: true }).isInt(),
    body('ambito').optional({ nullable: true }).isIn(['oficina', 'otros']),
  ],
  asyncHandler(
    async (req: Request<{ id: string }>, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({ success: false, error: 'Datos inválidos' });
        return;
      }

      const user = req.user!;
      const id = Number(req.params.id);
      const { descripcion, descripcion_larga, tipo, proyecto_id, ambito } = req.body;

      const result = await query(
        `UPDATE cotizaciones
         SET descripcion = $1, descripcion_larga = $2, tipo = $3,
             proyecto_id = $4, ambito = $5, updated_at = CURRENT_TIMESTAMP
         WHERE id = $6 AND activo = TRUE
         RETURNING *`,
        [
          (descripcion as string).trim(),
          descripcion_larga || null,
          tipo || null,
          proyecto_id ?? null,
          ambito || null,
          id,
        ],
      );
      if (result.rows.length === 0) {
        res
          .status(404)
          .json({ success: false, message: 'Cotización no encontrada' });
        return;
      }

      await registrarAudit(user.id, 'editar', 'cotizacion', id, {
        descripcion,
      });
      res.json({ success: true, data: result.rows[0] });
    },
  ),
);

// --- POST /:id/ofertas — agregar oferta a cotización existente ---
router.post(
  '/:id/ofertas',
  [
    param('id').isInt(),
    body('proveedor').isString().trim().notEmpty().isLength({ max: 255 }),
    body('monto').optional({ nullable: true }).isFloat({ min: 0 }),
    body('nota').optional({ nullable: true }).isString(),
  ],
  asyncHandler(
    async (req: Request<{ id: string }>, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({ success: false, error: 'Datos inválidos' });
        return;
      }

      const user = req.user!;
      const id = Number(req.params.id);
      const { proveedor, monto, nota } = req.body;

      const parent = await query(
        'SELECT id FROM cotizaciones WHERE id = $1 AND activo = TRUE',
        [id],
      );
      if (parent.rows.length === 0) {
        res
          .status(404)
          .json({ success: false, message: 'Cotización no encontrada' });
        return;
      }

      const inserted = await query(
        `INSERT INTO cotizacion_ofertas (cotizacion_id, proveedor, monto, nota, creado_por)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [id, (proveedor as string).trim(), monto ?? null, nota || null, user.id],
      );

      await registrarAudit(
        user.id,
        'crear',
        'cotizacion_oferta',
        inserted.rows[0].id,
        { cotizacion_id: id, proveedor },
      );
      res.status(201).json({ success: true, data: inserted.rows[0] });
    },
  ),
);

// --- DELETE /:id — soft delete de cotización ---
router.delete(
  '/:id',
  [param('id').isInt()],
  asyncHandler(
    async (req: Request<{ id: string }>, res: Response): Promise<void> => {
      const user = req.user!;
      const id = Number(req.params.id);

      // Solo la cotización pasa a inactiva; las ofertas quedan intactas.
      // Ambos listados filtran por c.activo, así que desaparecen de la
      // vista automáticamente y un undelete futuro es trivial.
      const result = await query(
        `UPDATE cotizaciones SET activo = FALSE, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND activo = TRUE
         RETURNING id, descripcion`,
        [id],
      );
      if (result.rows.length === 0) {
        res
          .status(404)
          .json({ success: false, message: 'Cotización no encontrada' });
        return;
      }

      await registrarAudit(user.id, 'eliminar', 'cotizacion', id, {
        descripcion: result.rows[0].descripcion,
      });
      res.json({ success: true });
    },
  ),
);

export default router;
