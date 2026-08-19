// Los archivos del proyecto: contrato, orden de proceder y demas documentos.
//
// Todas las rutas cuelgan del proyecto (/:projectId/documentos/...) a proposito,
// incluso las que ya identifican el documento por su id. Asi checkProjectAccess
// puede leer el proyecto del path y no hace falta un chequeo a mano dentro del
// handler -- que es justo lo que hacen las otras rutas de adjuntos y por eso
// terminan repitiendo la logica de acceso.
//
// Se monta en /api/projects ANTES de routes/projects.ts (mismo patron que
// solicitudesPagoAdjuntos con /api/solicitudes-pago).
import { Router, Request, Response, NextFunction } from 'express';
import { body, param, validationResult } from 'express-validator';
import multer from 'multer';
import crypto from 'crypto';
import { query } from '../database/config.js';
import { authenticateToken, checkProjectAccess } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { uploadFile, deleteFile, getFileSignedUrl } from '../services/storage.js';
import { registrarAudit } from '../services/auditLog.js';
import { fixUploadEncoding } from '../utils/fileEncoding.js';

const router = Router();

const MAX_MB = 40;
const MAX_ARCHIVOS = 5;

// Sin fileFilter: aqui entra el contrato escaneado, pero tambien el Excel del
// presupuesto o el Word de una nota. Limitar a PDF/JPG/PNG como en solicitudes
// dejaria fuera justo lo que este modulo existe para guardar.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_MB * 1024 * 1024, files: MAX_ARCHIVOS },
});

/** Traduce los errores de multer a 400 JSON antes de llegar al handler. */
function handleUpload(req: Request, res: Response, next: NextFunction): void {
  upload.array('archivos', MAX_ARCHIVOS)(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        res.status(400).json({
          success: false,
          error: `El archivo excede el limite de ${MAX_MB}MB`,
        });
        return;
      }
      if (err.code === 'LIMIT_UNEXPECTED_FILE' || err.code === 'LIMIT_FILE_COUNT') {
        res.status(400).json({
          success: false,
          error: `Maximo ${MAX_ARCHIVOS} archivos por subida`,
        });
        return;
      }
      res.status(400).json({ success: false, error: err.message });
      return;
    }
    if (err) {
      res.status(400).json({ success: false, error: err.message });
      return;
    }
    next();
  });
}

/** El nombre viaja al key de R2, asi que fuera acentos y todo lo que no sea
 *  seguro en una URL. El nombre bonito se guarda aparte en la fila. */
const sanitizeFilename = (name: string): string =>
  name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 200);

interface DocumentoRow {
  id: number;
  proyecto_id: number;
  nombre_original: string;
  /** Como lo llamamos aquí. Null = se muestra por su nombre de archivo. */
  etiqueta: string | null;
  r2_key: string;
  tipo_mime: string;
  tamano: number;
  subido_por: number;
  subido_por_nombre: string | null;
  created_at: Date;
}

/** Editar y borrar piden lo mismo: tener acceso al proyecto deja subir y mirar,
 *  pero no tocar lo que puso otro. Por encima, admin y co-admin. */
const puedeTocar = (
  fila: { subido_por: number },
  user: { id: number; rol: string },
): boolean =>
  fila.subido_por === user.id || user.rol === 'admin' || user.rol === 'co-admin';

const invalido = (req: Request, res: Response): boolean => {
  const errors = validationResult(req);
  if (errors.isEmpty()) return false;
  res.status(400).json({ success: false, error: 'Parametros invalidos' });
  return true;
};

// GET /:projectId/documentos — la lista
router.get(
  '/:projectId/documentos',
  authenticateToken,
  checkProjectAccess('projectId'),
  [param('projectId').isInt()],
  asyncHandler(async (req: Request<{ projectId: string }>, res: Response): Promise<void> => {
    if (invalido(req, res)) return;
    const result = await query<DocumentoRow>(
      `SELECT d.id, d.proyecto_id, d.nombre_original, d.etiqueta, d.r2_key,
              d.tipo_mime, d.tamano, d.subido_por, d.created_at,
              u.nombre AS subido_por_nombre
         FROM proyecto_documentos d
         LEFT JOIN users u ON u.id = d.subido_por
        WHERE d.proyecto_id = $1
        ORDER BY d.created_at DESC`,
      [Number(req.params.projectId)],
    );
    // La clave de R2 no sale al cliente: no le sirve de nada y es la direccion
    // real del archivo en el bucket.
    const data = result.rows.map(({ r2_key: _fuera, ...resto }) => resto);
    res.json({ success: true, data });
  }),
);

// POST /:projectId/documentos — subir
router.post(
  '/:projectId/documentos',
  authenticateToken,
  checkProjectAccess('projectId'),
  handleUpload,
  fixUploadEncoding,
  [param('projectId').isInt()],
  asyncHandler(async (req: Request<{ projectId: string }>, res: Response): Promise<void> => {
    if (invalido(req, res)) return;
    const user = req.user!;
    const projectId = Number(req.params.projectId);
    const archivos = (req.files as Express.Multer.File[] | undefined) ?? [];

    if (archivos.length === 0) {
      res.status(400).json({ success: false, error: 'Archivo requerido' });
      return;
    }

    const proyecto = await query<{ id: number }>(
      'SELECT id FROM proyectos WHERE id = $1',
      [projectId],
    );
    if (proyecto.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Proyecto no encontrado' });
      return;
    }

    // Primero R2 y despues la base: si R2 falla no queda una fila apuntando a
    // un archivo que no existe. Al reves, un objeto huerfano no rompe nada.
    const subidos: { r2Key: string; archivo: Express.Multer.File }[] = [];
    for (const archivo of archivos) {
      const r2Key = `proyectos/${projectId}/${crypto.randomUUID()}_${sanitizeFilename(archivo.originalname)}`;
      await uploadFile(r2Key, archivo.buffer, archivo.mimetype);
      subidos.push({ r2Key, archivo });
    }

    const insertados: number[] = [];
    for (const { r2Key, archivo } of subidos) {
      const ins = await query<{ id: number }>(
        `INSERT INTO proyecto_documentos
           (proyecto_id, nombre_original, r2_key, tipo_mime, tamano, subido_por)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [projectId, archivo.originalname, r2Key, archivo.mimetype, archivo.size, user.id],
      );
      insertados.push(ins.rows[0].id);
    }

    await registrarAudit(user.id, 'adjuntar', 'proyecto', projectId, {
      documento_ids: insertados,
      nombres: archivos.map((a) => a.originalname),
    });

    res.status(201).json({ success: true, data: { ids: insertados } });
  }),
);

// GET /:projectId/documentos/:documentoId/download — enlace temporal
router.get(
  '/:projectId/documentos/:documentoId/download',
  authenticateToken,
  checkProjectAccess('projectId'),
  [param('projectId').isInt(), param('documentoId').isInt()],
  asyncHandler(
    async (req: Request<{ projectId: string; documentoId: string }>, res: Response): Promise<void> => {
      if (invalido(req, res)) return;
      const result = await query<DocumentoRow>(
        'SELECT r2_key, nombre_original FROM proyecto_documentos WHERE id = $1 AND proyecto_id = $2',
        [Number(req.params.documentoId), Number(req.params.projectId)],
      );
      if (result.rows.length === 0) {
        res.status(404).json({ success: false, error: 'Documento no encontrado' });
        return;
      }
      // El enlace lleva con que nombre debe guardarse: sin eso, el navegador lo
      // saca de la clave en R2 y el archivo baja con el UUID delante.
      const url = await getFileSignedUrl(
        result.rows[0].r2_key,
        900,
        result.rows[0].nombre_original,
      );
      res.json({ success: true, data: { url, nombre: result.rows[0].nombre_original } });
    },
  ),
);

// PATCH /:projectId/documentos/:documentoId — la etiqueta
//
// Solo la etiqueta. El nombre del archivo NO se toca: es el que traia al
// subirse y con el que vuelve a bajar, y asi siempre se puede saber cual es el
// archivo de verdad detras de la etiqueta que le pusimos.
router.patch(
  '/:projectId/documentos/:documentoId',
  authenticateToken,
  checkProjectAccess('projectId'),
  [
    param('projectId').isInt(),
    param('documentoId').isInt(),
    body('etiqueta').optional({ nullable: true }).isString().trim().isLength({ max: 200 }),
  ],
  asyncHandler(
    async (req: Request<{ projectId: string; documentoId: string }>, res: Response): Promise<void> => {
      if (invalido(req, res)) return;
      const user = req.user!;
      const projectId = Number(req.params.projectId);
      const documentoId = Number(req.params.documentoId);
      const { etiqueta } = req.body as { etiqueta?: string | null };

      if (etiqueta === undefined) {
        res.status(400).json({ success: false, error: 'Nada que cambiar' });
        return;
      }

      const actual = await query<DocumentoRow>(
        'SELECT subido_por, nombre_original, etiqueta FROM proyecto_documentos WHERE id = $1 AND proyecto_id = $2',
        [documentoId, projectId],
      );
      if (actual.rows.length === 0) {
        res.status(404).json({ success: false, error: 'Documento no encontrado' });
        return;
      }
      if (!puedeTocar(actual.rows[0], user)) {
        res.status(403).json({
          success: false,
          error: 'Solo quien subio el documento puede cambiarlo',
        });
        return;
      }

      // Una etiqueta en blanco es quitarla, no guardarla vacia: asi el renglon
      // vuelve a verse solo por el nombre del archivo.
      const etiquetaFinal = (etiqueta ?? '').trim() || null;

      await query('UPDATE proyecto_documentos SET etiqueta = $1 WHERE id = $2', [
        etiquetaFinal,
        documentoId,
      ]);

      await registrarAudit(user.id, 'editar_adjunto', 'proyecto', projectId, {
        documento_id: documentoId,
        nombre: actual.rows[0].nombre_original,
        etiqueta: etiquetaFinal,
      });

      res.json({ success: true });
    },
  ),
);

// DELETE /:projectId/documentos/:documentoId
router.delete(
  '/:projectId/documentos/:documentoId',
  authenticateToken,
  checkProjectAccess('projectId'),
  [param('projectId').isInt(), param('documentoId').isInt()],
  asyncHandler(
    async (req: Request<{ projectId: string; documentoId: string }>, res: Response): Promise<void> => {
      if (invalido(req, res)) return;
      const user = req.user!;
      const projectId = Number(req.params.projectId);
      const documentoId = Number(req.params.documentoId);

      const result = await query<DocumentoRow>(
        'SELECT r2_key, subido_por, nombre_original FROM proyecto_documentos WHERE id = $1 AND proyecto_id = $2',
        [documentoId, projectId],
      );
      if (result.rows.length === 0) {
        res.status(404).json({ success: false, error: 'Documento no encontrado' });
        return;
      }

      if (!puedeTocar(result.rows[0], user)) {
        res.status(403).json({
          success: false,
          error: 'Solo quien subio el documento puede borrarlo',
        });
        return;
      }

      // R2 primero. Si falla, la fila se queda y el documento se puede volver a
      // intentar; borrar la fila antes dejaria el objeto sin nadie que lo nombre.
      await deleteFile(result.rows[0].r2_key);
      await query('DELETE FROM proyecto_documentos WHERE id = $1', [documentoId]);

      await registrarAudit(user.id, 'eliminar_adjunto', 'proyecto', projectId, {
        documento_id: documentoId,
        nombre: result.rows[0].nombre_original,
      });

      res.json({ success: true });
    },
  ),
);

export default router;
