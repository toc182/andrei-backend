import { Router, Request, Response, NextFunction } from 'express';
import { body, param, validationResult } from 'express-validator';
import multer from 'multer';
import crypto from 'crypto';
import { query, pool } from '../database/config.js';
import { authenticateToken, checkPermission, requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { deleteFile, downloadFile, uploadFile, getFileSignedUrl } from '../services/storage.js';
import { generateSolicitudPDF } from '../services/pdfGenerator.js';
import { registrarAudit } from '../services/auditLog.js';
import { sendEmail } from '../services/emailService.js';
import { PDFDocument } from 'pdf-lib';
import bcrypt from 'bcryptjs';

const router = Router();

// Helper: generate full PDF (solicitud + adjuntos merged) for a given solicitud ID
async function generateFullPDF(solicitudId: number): Promise<Buffer> {
  const solicitud = await query<SolicitudRow>(
    `
    SELECT sp.*,
      COALESCE(p.nombre_corto, p.nombre) as proyecto_nombre,
      u1.nombre as preparado_nombre,
      u2.nombre as solicitado_nombre
    FROM solicitudes_pago sp
    LEFT JOIN proyectos p ON sp.proyecto_id = p.id
    LEFT JOIN users u1 ON sp.preparado_por = u1.id
    LEFT JOIN users u2 ON sp.solicitado_por = u2.id
    WHERE sp.id = $1
  `,
    [solicitudId],
  );

  if (solicitud.rows.length === 0) throw new Error('Solicitud no encontrada');

  const sol = solicitud.rows[0];

  const items = await query<ItemRow>(
    'SELECT * FROM solicitud_pago_items WHERE solicitud_pago_id = $1 ORDER BY orden, id',
    [solicitudId],
  );

  const ajustes = await query<AjusteRow>(
    'SELECT * FROM solicitud_pago_ajustes WHERE solicitud_pago_id = $1 ORDER BY orden, id',
    [solicitudId],
  );

  const aprobaciones = await query<{
    usuario_nombre: string;
    accion: string;
    fecha: string;
  }>(
    `
    SELECT sa.accion, sa.fecha, u.nombre as usuario_nombre
    FROM solicitud_aprobaciones sa
    JOIN users u ON sa.user_id = u.id
    WHERE sa.solicitud_pago_id = $1
    ORDER BY sa.orden
  `,
    [solicitudId],
  );

  const totalAprobadoresResult = await query<{ count: string }>(
    'SELECT COUNT(*) as count FROM project_approval_settings WHERE proyecto_id = $1 AND activo = true',
    [sol.proyecto_id],
  );
  const totalAprobadores = parseInt(totalAprobadoresResult.rows[0].count);

  const aprobadoresProyecto = await query<{
    user_id: number;
    nombre: string;
    orden: number;
  }>(
    'SELECT pas.user_id, u.nombre, pas.orden FROM project_approval_settings pas JOIN users u ON u.id = pas.user_id WHERE pas.proyecto_id = $1 AND pas.activo = true ORDER BY pas.orden',
    [sol.proyecto_id],
  );

  let pdfComprobante:
    | { fecha_pago: string; registrado_por_nombre: string }
    | undefined;
  if (sol.estado === 'pagada' || sol.estado === 'facturada') {
    const compResult = await query<{
      fecha_pago: string;
      registrado_por_nombre: string;
    }>(
      `
      SELECT cp.fecha_pago, u.nombre as registrado_por_nombre
      FROM comprobantes_pago cp
      LEFT JOIN users u ON cp.registrado_por = u.id
      WHERE cp.solicitud_pago_id = $1
    `,
      [solicitudId],
    );
    if (compResult.rows.length > 0) {
      pdfComprobante = compResult.rows[0];
    }
  }

  let pdfFactura:
    | {
        fecha_factura: string;
        numero_factura?: string;
        registrado_por_nombre: string;
      }
    | undefined;
  if (sol.estado === 'facturada') {
    const factResult = await query<{
      fecha_factura: string;
      numero_factura: string | null;
      registrado_por_nombre: string;
    }>(
      `
      SELECT fs.fecha_factura, fs.numero_factura, u.nombre as registrado_por_nombre
      FROM facturas_solicitud fs
      LEFT JOIN users u ON fs.registrado_por = u.id
      WHERE fs.solicitud_pago_id = $1
    `,
      [solicitudId],
    );
    if (factResult.rows.length > 0) {
      pdfFactura = {
        fecha_factura: factResult.rows[0].fecha_factura,
        numero_factura: factResult.rows[0].numero_factura || undefined,
        registrado_por_nombre: factResult.rows[0].registrado_por_nombre,
      };
    }
  }

  let pdfReembolso:
    | { fecha_reembolso: string; registrado_por_nombre: string }
    | undefined;
  if (sol.pinellas_paga) {
    const reembResult = await query<{
      fecha_reembolso: string;
      registrado_por_nombre: string;
    }>(
      `
      SELECT rp.fecha_reembolso, u.nombre as registrado_por_nombre
      FROM reembolsos_pinellas rp
      LEFT JOIN users u ON rp.registrado_por = u.id
      WHERE rp.solicitud_id = $1
    `,
      [solicitudId],
    );
    if (reembResult.rows.length > 0) {
      pdfReembolso = reembResult.rows[0];
    }
  }

  const solicitudBuffer = await generateSolicitudPDF({
    estado: sol.estado,
    solicitud: {
      numero: sol.numero,
      fecha: sol.fecha,
      proveedor: sol.proveedor,
      proyecto_nombre: sol.proyecto_nombre || '',
      preparado_nombre: sol.preparado_nombre || '',
      solicitado_nombre: sol.solicitado_nombre || null,
      observaciones: sol.observaciones,
      urgente: sol.urgente,
      subtotal: sol.subtotal,
      descuentos: sol.descuentos,
      impuestos: sol.impuestos,
      monto_total: sol.monto_total,
      beneficiario: sol.beneficiario,
      banco: sol.banco,
      tipo_cuenta: sol.tipo_cuenta,
      numero_cuenta: sol.numero_cuenta,
      pinellas_paga: sol.pinellas_paga,
    },
    items: items.rows,
    ajustes: ajustes.rows,
    aprobaciones: aprobaciones.rows,
    comprobante: pdfComprobante,
    factura: pdfFactura,
    codigo_verificacion: sol.codigo_verificacion,
    total_aprobadores: totalAprobadores,
    aprobadores_proyecto: aprobadoresProyecto.rows,
    reembolso: pdfReembolso,
  });

  // Merge adjuntos into the PDF
  const adjuntos = await query<{
    r2_key: string;
    tipo_mime: string;
    nombre_original: string;
  }>(
    `SELECT r2_key, tipo_mime, nombre_original FROM solicitud_pago_adjuntos WHERE solicitud_pago_id = $1 ORDER BY CASE tipo_adjunto WHEN 'comprobante' THEN 1 WHEN 'factura' THEN 2 ELSE 3 END, created_at`,
    [solicitudId],
  );

  // Also fetch devolucion comprobante if exists
  const devolucionComp = await query<{
    comprobante_url: string;
    comprobante_nombre: string;
  }>(
    'SELECT comprobante_url, comprobante_nombre FROM devoluciones_solicitud WHERE solicitud_id = $1',
    [solicitudId],
  );

  if (adjuntos.rows.length === 0 && devolucionComp.rows.length === 0) {
    return solicitudBuffer;
  }

  const mergedPdf = await PDFDocument.load(solicitudBuffer);

  for (const adjunto of adjuntos.rows) {
    try {
      const fileBuffer = await downloadFile(adjunto.r2_key);

      if (adjunto.tipo_mime === 'application/pdf') {
        const attachedPdf = await PDFDocument.load(fileBuffer);
        const pages = await mergedPdf.copyPages(
          attachedPdf,
          attachedPdf.getPageIndices(),
        );
        for (const page of pages) {
          mergedPdf.addPage(page);
        }
      } else if (
        adjunto.tipo_mime === 'image/jpeg' ||
        adjunto.tipo_mime === 'image/png'
      ) {
        const img =
          adjunto.tipo_mime === 'image/jpeg'
            ? await mergedPdf.embedJpg(fileBuffer)
            : await mergedPdf.embedPng(fileBuffer);

        const pageW = 612;
        const pageH = 792;
        const margin = 40;
        const maxW = pageW - margin * 2;
        const maxH = pageH - margin * 2;

        const scale = Math.min(maxW / img.width, maxH / img.height, 1);
        const drawW = img.width * scale;
        const drawH = img.height * scale;

        const page = mergedPdf.addPage([pageW, pageH]);
        page.drawImage(img, {
          x: (pageW - drawW) / 2,
          y: (pageH - drawH) / 2,
          width: drawW,
          height: drawH,
        });
      }
    } catch (err) {
      console.error(
        `Error procesando adjunto ${adjunto.nombre_original}:`,
        err,
      );
    }
  }

  // Merge devolucion comprobante if exists
  if (devolucionComp.rows.length > 0) {
    try {
      const devFile = await downloadFile(devolucionComp.rows[0].comprobante_url);
      const devMime = devolucionComp.rows[0].comprobante_url.toLowerCase();
      if (devMime.endsWith('.pdf')) {
        const devPdf = await PDFDocument.load(devFile);
        const pages = await mergedPdf.copyPages(devPdf, devPdf.getPageIndices());
        for (const page of pages) {
          mergedPdf.addPage(page);
        }
      } else if (devMime.endsWith('.jpg') || devMime.endsWith('.jpeg') || devMime.endsWith('.png')) {
        const img = devMime.endsWith('.png')
          ? await mergedPdf.embedPng(devFile)
          : await mergedPdf.embedJpg(devFile);
        const pageW = 612;
        const pageH = 792;
        const margin = 40;
        const maxW = pageW - margin * 2;
        const maxH = pageH - margin * 2;
        const scale = Math.min(maxW / img.width, maxH / img.height, 1);
        const drawW = img.width * scale;
        const drawH = img.height * scale;
        const page = mergedPdf.addPage([pageW, pageH]);
        page.drawImage(img, {
          x: (pageW - drawW) / 2,
          y: (pageH - drawH) / 2,
          width: drawW,
          height: drawH,
        });
      }
    } catch (err) {
      console.error('Error procesando comprobante de devolución:', err);
    }
  }

  const mergedBytes = await mergedPdf.save();
  return Buffer.from(mergedBytes);
}

// Helper: build cambios array by comparing old and new solicitud data
interface CambioSimple {
  campo: string;
  anterior: string;
  nuevo: string;
}

interface CambioItem {
  campo: 'item';
  item_id: number;
  descripcion: string;
  cambios: { campo: string; anterior: string; nuevo: string }[];
}

interface CambioItemAgregado {
  campo: 'item_agregado';
  descripcion: string;
  nuevo: Record<string, unknown>;
}

interface CambioItemEliminado {
  campo: 'item_eliminado';
  descripcion: string;
  anterior: Record<string, unknown>;
}

type Cambio = CambioSimple | CambioItem | CambioItemAgregado | CambioItemEliminado;

// Normalize a date value to YYYY-MM-DD for comparison
function normalizeDate(val: unknown): string {
  if (!val) return '';
  const s = String(val);
  // If it's already YYYY-MM-DD, return as-is
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // Try to parse and extract date part
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().split('T')[0];
  return s.split('T')[0] || s;
}

// Normalize a numeric value for comparison (avoids "1.00" vs "1" false diffs)
function normalizeNumeric(val: unknown): string {
  if (val === null || val === undefined || val === '') return '';
  const n = parseFloat(String(val));
  if (isNaN(n)) return String(val);
  return String(n);
}

const DATE_FIELDS = ['fecha', 'fecha_pago', 'fecha_factura'];
const NUMERIC_FIELDS = ['cantidad', 'precio_unitario', 'precio_total', 'monto', 'porcentaje', 'subtotal', 'monto_total'];

function buildSolicitudDiff(
  oldData: Record<string, unknown>,
  newData: Record<string, unknown>,
  fields: string[],
): CambioSimple[] {
  const cambios: CambioSimple[] = [];
  for (const field of fields) {
    let oldVal: string;
    let newVal: string;
    if (DATE_FIELDS.includes(field)) {
      oldVal = normalizeDate(oldData[field]);
      newVal = normalizeDate(newData[field]);
    } else if (NUMERIC_FIELDS.includes(field)) {
      oldVal = normalizeNumeric(oldData[field]);
      newVal = normalizeNumeric(newData[field]);
    } else {
      oldVal = String(oldData[field] ?? '');
      newVal = String(newData[field] ?? '');
    }
    if (oldVal !== newVal) {
      cambios.push({ campo: field, anterior: oldVal, nuevo: newVal });
    }
  }
  return cambios;
}

// --- GET /:id/pdf — Generar PDF (ANTES del middleware global de auth) ---
// Token se inyecta desde query param en server.ts para soportar window.open
router.get(
  '/:id/pdf',
  [param('id').isInt()],
  authenticateToken,
  asyncHandler(
    async (req: Request<{ id: string }>, res: Response): Promise<void> => {
      const { id } = req.params;

      const solicitud = await query<SolicitudRow>(
        'SELECT numero FROM solicitudes_pago WHERE id = $1',
        [id],
      );
      if (solicitud.rows.length === 0) {
        res
          .status(404)
          .json({ success: false, message: 'Solicitud no encontrada' });
        return;
      }

      const finalBuffer = await generateFullPDF(parseInt(id));

      res.set({
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="SP-${solicitud.rows[0].numero}.pdf"`,
      });
      res.send(finalBuffer);
    },
  ),
);

// Todas las rutas requieren autenticación
router.use(authenticateToken);

// --- Interfaces ---

interface SolicitudRow {
  id: number;
  proyecto_id: number | null;
  numero: string;
  fecha: string;
  proveedor: string;
  preparado_por: number;
  solicitado_por: number | null;
  requisicion_id: number | null;
  subtotal: number;
  descuentos: number;
  impuestos: number;
  monto_total: number;
  estado: string;
  observaciones: string | null;
  beneficiario: string | null;
  banco: string | null;
  tipo_cuenta: string | null;
  numero_cuenta: string | null;
  urgente: boolean;
  pinellas_paga: boolean;
  codigo_verificacion: string;
  created_at: Date;
  updated_at: Date;
  proyecto_nombre?: string;
  preparado_nombre?: string;
  solicitado_nombre?: string;
  requisicion_numero?: string;
}

interface ItemRow {
  id: number;
  solicitud_pago_id: number;
  cantidad: number;
  unidad: string;
  descripcion: string;
  descripcion_detallada: string | null;
  precio_unitario: number;
  precio_total: number;
  orden: number;
}

interface AjusteRow {
  id: number;
  solicitud_pago_id: number;
  tipo: string;
  descripcion: string;
  porcentaje: number | null;
  monto: number;
  orden: number;
}

interface CreateBody {
  proyecto_id: number;
  fecha?: string;
  proveedor: string;
  solicitado_por?: number;
  requisicion_id?: number;
  observaciones?: string;
  beneficiario?: string;
  banco?: string;
  tipo_cuenta?: string;
  numero_cuenta?: string;
  urgente?: boolean;
  pinellas_paga?: boolean;
  items: Array<{
    cantidad: number;
    unidad?: string;
    descripcion: string;
    descripcion_detallada?: string;
    precio_unitario: number;
  }>;
  ajustes?: Array<{
    tipo: string;
    descripcion: string;
    porcentaje?: number;
    monto: number;
  }>;
}

// --- Helpers ---

const TRANSICIONES: Record<string, string[]> = {
  pendiente: ['rechazada'],
  aprobada: ['pagada'],
  rechazada: ['pendiente'],
  pagada: ['facturada', 'devolucion'],
  facturada: ['devolucion'],
  devolucion: [],
};

function generateCodigoVerificacion(): string {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(8);
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += chars[bytes[i] % chars.length];
  }
  return code;
}

async function generateNumero(
  projectId: number,
  client?: { query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
): Promise<string> {
  const q = client
    ? <T>(text: string, params?: unknown[]) => client.query(text, params) as Promise<{ rows: T[] }>
    : <T>(text: string, params?: unknown[]) => query<T & import('pg').QueryResultRow>(text, params).then(r => r);

  const project = await q<{ sp_prefijo: string | null }>(
    'SELECT sp_prefijo FROM proyectos WHERE id = $1',
    [projectId],
  );

  if (project.rows.length === 0) throw new Error('Proyecto no encontrado');

  const prefijo = project.rows[0].sp_prefijo;
  if (!prefijo) throw new Error('PREFIJO_NO_CONFIGURADO');

  const count = await q<{ total: string }>(
    "SELECT COALESCE(MAX(CAST(SPLIT_PART(numero, '-', 2) AS INTEGER)), 0)::text as total FROM solicitudes_pago WHERE proyecto_id = $1",
    [projectId],
  );
  const nextNum = parseInt(count.rows[0].total) + 1;

  return `${prefijo}-${String(nextNum).padStart(3, '0')}`;
}

// --- GET /pending-approval-count — Contar solicitudes pendientes de aprobación del usuario actual ---
router.get(
  '/pending-approval-count',
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.id;

    const result = await query<{ total: number; proyecto_id: number }>(
      `
    SELECT sp.proyecto_id, COUNT(*)::int as total
    FROM solicitudes_pago sp
    JOIN project_approval_settings pas ON pas.proyecto_id = sp.proyecto_id
      AND pas.user_id = $1 AND pas.activo = true
    WHERE sp.estado = 'pendiente'
      AND pas.orden = (
        SELECT COUNT(*) + 1
        FROM solicitud_aprobaciones sa
        WHERE sa.solicitud_pago_id = sp.id AND sa.accion = 'aprobado'
      )
    GROUP BY sp.proyecto_id
  `,
      [userId],
    );

    const total = result.rows.reduce((sum, r) => sum + r.total, 0);

    res.json({
      success: true,
      total,
      por_proyecto: result.rows,
    });
  }),
);

// --- GET /reembolsos/pendientes — Solicitudes con pinellas_paga y estado de reembolso ---
router.get(
  '/reembolsos/pendientes',
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    let projectFilter = '';
    const params: unknown[] = [];
    const userRol = req.user!.rol;

    if (
      userRol === 'usuario' &&
      !req.user!.permissions?.acceso_global
    ) {
      params.push(req.user!.id);
      projectFilter = ` AND sp.proyecto_id IN (SELECT proyecto_id FROM user_project_access WHERE user_id = $${params.length})`;
    }

    const result = await query(`
    SELECT sp.id, sp.numero, sp.proveedor, sp.monto_total, sp.estado, sp.fecha, sp.urgente,
      COALESCE(p.nombre_corto, p.nombre) as proyecto_nombre,
      CASE WHEN rp.id IS NOT NULL THEN true ELSE false END as reembolso_registrado,
      rp.fecha_reembolso, rp.comprobante_nombre
    FROM solicitudes_pago sp
    LEFT JOIN proyectos p ON sp.proyecto_id = p.id
    LEFT JOIN reembolsos_pinellas rp ON rp.solicitud_id = sp.id
    WHERE sp.pinellas_paga = true${projectFilter}
    ORDER BY rp.id IS NOT NULL ASC, sp.created_at DESC
  `, params);

    res.json({ success: true, solicitudes: result.rows });
  }),
);

// Helper: enrich solicitudes with aprobadores_estado
async function enrichWithAprobadoresEstado(
  solicitudes: SolicitudRow[],
): Promise<
  (SolicitudRow & {
    aprobadores_estado: { nombre: string; estado: string }[];
  })[]
> {
  if (solicitudes.length === 0) return [];

  const proyectoIds = [
    ...new Set(solicitudes.map((s) => s.proyecto_id).filter(Boolean)),
  ] as number[];
  const solicitudIds = solicitudes.map((s) => s.id);

  if (proyectoIds.length === 0) {
    return solicitudes.map((s) => ({ ...s, aprobadores_estado: [] }));
  }

  const [aprobadoresRes, aprobacionesRes, reembolsosRes] = await Promise.all([
    query<{
      proyecto_id: number;
      user_id: number;
      orden: number;
      nombre: string;
    }>(
      `SELECT pas.proyecto_id, pas.user_id, pas.orden, u.nombre
       FROM project_approval_settings pas
       JOIN users u ON pas.user_id = u.id
       WHERE pas.proyecto_id = ANY($1::int[]) AND pas.activo = true
       ORDER BY pas.proyecto_id, pas.orden`,
      [proyectoIds],
    ),
    query<{ solicitud_pago_id: number; user_id: number; accion: string }>(
      `SELECT sa.solicitud_pago_id, sa.user_id, sa.accion
       FROM solicitud_aprobaciones sa
       WHERE sa.solicitud_pago_id = ANY($1::int[])`,
      [solicitudIds],
    ),
    query<{ solicitud_id: number }>(
      `SELECT rp.solicitud_id
       FROM reembolsos_pinellas rp
       WHERE rp.solicitud_id = ANY($1::int[])`,
      [solicitudIds],
    ),
  ]);

  // Index approvers by proyecto_id
  const aprobadoresPorProyecto = new Map<
    number,
    { user_id: number; nombre: string }[]
  >();
  for (const row of aprobadoresRes.rows) {
    if (!aprobadoresPorProyecto.has(row.proyecto_id)) {
      aprobadoresPorProyecto.set(row.proyecto_id, []);
    }
    aprobadoresPorProyecto
      .get(row.proyecto_id)!
      .push({ user_id: row.user_id, nombre: row.nombre });
  }

  // Index approvals by solicitud_id + user_id
  const aprobacionesMap = new Map<string, string>();
  for (const row of aprobacionesRes.rows) {
    aprobacionesMap.set(`${row.solicitud_pago_id}-${row.user_id}`, row.accion);
  }

  // Set of solicitud IDs that have reembolso registered
  const reembolsoIds = new Set(reembolsosRes.rows.map((r) => r.solicitud_id));

  return solicitudes.map((sol) => {
    const aprobadores = sol.proyecto_id
      ? aprobadoresPorProyecto.get(sol.proyecto_id) || []
      : [];
    const aprobadores_estado = aprobadores.map((a) => ({
      nombre: a.nombre,
      estado: aprobacionesMap.get(`${sol.id}-${a.user_id}`) || 'pendiente',
    }));
    return {
      ...sol,
      aprobadores_estado,
      reembolso_registrado: reembolsoIds.has(sol.id),
    };
  });
}

// --- GET / — Listar todas (global) ---
router.get(
  '/',
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const { estado, proyecto_id } = req.query;
    const currentUserId = req.user!.id;

    let whereClause = 'WHERE 1=1';
    const params: unknown[] = [currentUserId];
    let paramCount = 1;

    // Filter by project access for non-admin users without acceso_global
    const userRol = req.user!.rol;
    if (
      userRol === 'usuario' &&
      !req.user!.permissions?.acceso_global
    ) {
      paramCount++;
      whereClause += ` AND sp.proyecto_id IN (SELECT proyecto_id FROM user_project_access WHERE user_id = $${paramCount})`;
      params.push(currentUserId);
    }

    if (estado && estado !== 'all') {
      const estados = (estado as string)
        .split(',')
        .map((e) => e.trim())
        .filter(Boolean);
      if (estados.length === 1) {
        paramCount++;
        whereClause += ` AND sp.estado = $${paramCount}`;
        params.push(estados[0]);
      } else if (estados.length > 1) {
        paramCount++;
        whereClause += ` AND sp.estado = ANY($${paramCount}::text[])`;
        params.push(estados);
      }
    }

    if (proyecto_id) {
      paramCount++;
      whereClause += ` AND sp.proyecto_id = $${paramCount}`;
      params.push(proyecto_id);
    }

    let revisadaJoin = '';
    let revisadaSelect = '';

    if (req.query.pending_my_approval === 'true') {
      paramCount++;
      whereClause += ` AND sp.estado = 'pendiente'
      AND EXISTS (
        SELECT 1 FROM project_approval_settings pas
        WHERE pas.proyecto_id = sp.proyecto_id
          AND pas.user_id = $${paramCount} AND pas.activo = true
          AND pas.orden = (
            SELECT COUNT(*) + 1
            FROM solicitud_aprobaciones sa
            WHERE sa.solicitud_pago_id = sp.id AND sa.accion = 'aprobado'
          )
      )`;
      params.push(currentUserId);

      paramCount++;
      revisadaJoin = `LEFT JOIN solicitud_revisiones sr ON sr.solicitud_pago_id = sp.id AND sr.user_id = $${paramCount}`;
      revisadaSelect =
        ', CASE WHEN sr.id IS NOT NULL THEN true ELSE false END as revisada';
      params.push(currentUserId);
    }

    const result = await query<SolicitudRow>(
      `
    SELECT sp.*,
      COALESCE(p.nombre_corto, p.nombre) as proyecto_nombre,
      u1.nombre as preparado_nombre,
      u2.nombre as solicitado_nombre,
      CASE WHEN sp.estado = 'pendiente' AND EXISTS (
        SELECT 1 FROM project_approval_settings pas
        WHERE pas.proyecto_id = sp.proyecto_id
          AND pas.user_id = $1 AND pas.activo = true
          AND pas.orden = (
            SELECT COUNT(*) + 1
            FROM solicitud_aprobaciones sa
            WHERE sa.solicitud_pago_id = sp.id AND sa.accion = 'aprobado'
          )
      ) THEN true ELSE false END as es_mi_turno
      ${revisadaSelect}
    FROM solicitudes_pago sp
    LEFT JOIN proyectos p ON sp.proyecto_id = p.id
    LEFT JOIN users u1 ON sp.preparado_por = u1.id
    LEFT JOIN users u2 ON sp.solicitado_por = u2.id
    ${revisadaJoin}
    ${whereClause}
    ORDER BY sp.created_at DESC
  `,
      params,
    );

    const enriched = await enrichWithAprobadoresEstado(result.rows);
    res.json({ success: true, solicitudes: enriched });
  }),
);

// --- GET /project/:projectId — Listar del proyecto ---
router.get(
  '/project/:projectId',
  asyncHandler(
    async (
      req: Request<{ projectId: string }>,
      res: Response,
    ): Promise<void> => {
      const { projectId } = req.params;
      const { estado } = req.query;
      const currentUserId = req.user!.id;

      let whereClause = 'WHERE sp.proyecto_id = $1';
      const params: unknown[] = [projectId, currentUserId];
      let paramCount = 2;

      if (estado && estado !== 'all') {
        const estados = (estado as string)
          .split(',')
          .map((e) => e.trim())
          .filter(Boolean);
        if (estados.length === 1) {
          paramCount++;
          whereClause += ` AND sp.estado = $${paramCount}`;
          params.push(estados[0]);
        } else if (estados.length > 1) {
          paramCount++;
          whereClause += ` AND sp.estado = ANY($${paramCount}::text[])`;
          params.push(estados);
        }
      }

      let revisadaJoin = '';
      let revisadaSelect = '';

      if (req.query.pending_my_approval === 'true') {
        paramCount++;
        whereClause += ` AND sp.estado = 'pendiente'
      AND EXISTS (
        SELECT 1 FROM project_approval_settings pas
        WHERE pas.proyecto_id = sp.proyecto_id
          AND pas.user_id = $${paramCount} AND pas.activo = true
          AND pas.orden = (
            SELECT COUNT(*) + 1
            FROM solicitud_aprobaciones sa
            WHERE sa.solicitud_pago_id = sp.id AND sa.accion = 'aprobado'
          )
      )`;
        params.push(currentUserId);

        paramCount++;
        revisadaJoin = `LEFT JOIN solicitud_revisiones sr ON sr.solicitud_pago_id = sp.id AND sr.user_id = $${paramCount}`;
        revisadaSelect =
          ', CASE WHEN sr.id IS NOT NULL THEN true ELSE false END as revisada';
        params.push(currentUserId);
      }

      const result = await query<SolicitudRow>(
        `
    SELECT sp.*,
      u1.nombre as preparado_nombre,
      u2.nombre as solicitado_nombre,
      r.numero as requisicion_numero,
      CASE WHEN sp.estado = 'pendiente' AND EXISTS (
        SELECT 1 FROM project_approval_settings pas
        WHERE pas.proyecto_id = sp.proyecto_id
          AND pas.user_id = $2 AND pas.activo = true
          AND pas.orden = (
            SELECT COUNT(*) + 1
            FROM solicitud_aprobaciones sa
            WHERE sa.solicitud_pago_id = sp.id AND sa.accion = 'aprobado'
          )
      ) THEN true ELSE false END as es_mi_turno
      ${revisadaSelect}
    FROM solicitudes_pago sp
    LEFT JOIN users u1 ON sp.preparado_por = u1.id
    LEFT JOIN users u2 ON sp.solicitado_por = u2.id
    LEFT JOIN requisiciones r ON sp.requisicion_id = r.id
    ${revisadaJoin}
    ${whereClause}
    ORDER BY sp.created_at DESC
  `,
        params,
      );

      const [enriched, project] = await Promise.all([
        enrichWithAprobadoresEstado(result.rows),
        query<{ sp_prefijo: string | null }>(
          'SELECT sp_prefijo FROM proyectos WHERE id = $1',
          [projectId],
        ),
      ]);

      res.json({
        success: true,
        solicitudes: enriched,
        sp_prefijo: project.rows[0]?.sp_prefijo || null,
      });
    },
  ),
);

// --- GET /project/:projectId/next-number — Próximo número ---
router.get(
  '/project/:projectId/next-number',
  asyncHandler(
    async (
      req: Request<{ projectId: string }>,
      res: Response,
    ): Promise<void> => {
      const { projectId } = req.params;

      try {
        const numero = await generateNumero(parseInt(projectId));
        res.json({ success: true, numero });
      } catch (err) {
        const error = err as Error;
        if (error.message === 'PREFIJO_NO_CONFIGURADO') {
          res.status(400).json({
            success: false,
            message:
              'El proyecto no tiene prefijo configurado para solicitudes de pago',
          });
          return;
        }
        throw err;
      }
    },
  ),
);

// --- PUT /project/:projectId/prefijo — Configurar prefijo ---
router.put(
  '/project/:projectId/prefijo',
  [
    body('prefijo')
      .trim()
      .isLength({ min: 1, max: 20 })
      .withMessage('Prefijo debe tener entre 1 y 20 caracteres'),
  ],
  asyncHandler(
    async (
      req: Request<{ projectId: string }>,
      res: Response,
    ): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({
          success: false,
          message: 'Datos inválidos',
          errors: errors.array(),
        });
        return;
      }

      const { projectId } = req.params;
      const { prefijo } = req.body;

      await query('UPDATE proyectos SET sp_prefijo = $1 WHERE id = $2', [
        prefijo,
        projectId,
      ]);

      res.json({ success: true, message: 'Prefijo actualizado', prefijo });
    },
  ),
);

// --- GET /:id/correcciones — Historial de correcciones ---
router.get(
  '/:id/correcciones',
  [param('id').isInt()],
  asyncHandler(
    async (req: Request<{ id: string }>, res: Response): Promise<void> => {
      const { id } = req.params;

      const correcciones = await query(
        `
        SELECT c.id, c.motivo, c.cambios, c.version_pdf, c.created_at,
          u.nombre as usuario_nombre
        FROM correcciones_solicitud c
        JOIN users u ON c.user_id = u.id
        WHERE c.solicitud_pago_id = $1
        ORDER BY c.created_at DESC
        `,
        [id],
      );

      res.json({ success: true, data: correcciones.rows });
    },
  ),
);

// --- GET /:id — Detalle completo ---
router.get(
  '/:id',
  [param('id').isInt()],
  asyncHandler(
    async (req: Request<{ id: string }>, res: Response): Promise<void> => {
      const { id } = req.params;

      const solicitud = await query<SolicitudRow>(
        `
    SELECT sp.*,
      p.nombre as proyecto_nombre,
      u1.nombre as preparado_nombre,
      u2.nombre as solicitado_nombre,
      r.numero as requisicion_numero,
      (SELECT COUNT(*) FROM correcciones_solicitud WHERE solicitud_pago_id = sp.id) as correcciones_count
    FROM solicitudes_pago sp
    LEFT JOIN proyectos p ON sp.proyecto_id = p.id
    LEFT JOIN users u1 ON sp.preparado_por = u1.id
    LEFT JOIN users u2 ON sp.solicitado_por = u2.id
    LEFT JOIN requisiciones r ON sp.requisicion_id = r.id
    WHERE sp.id = $1
  `,
        [id],
      );

      if (solicitud.rows.length === 0) {
        res
          .status(404)
          .json({ success: false, message: 'Solicitud no encontrada' });
        return;
      }

      const items = await query<ItemRow>(
        'SELECT * FROM solicitud_pago_items WHERE solicitud_pago_id = $1 ORDER BY orden, id',
        [id],
      );

      const ajustes = await query<AjusteRow>(
        'SELECT * FROM solicitud_pago_ajustes WHERE solicitud_pago_id = $1 ORDER BY orden, id',
        [id],
      );

      // Aprobaciones de esta solicitud
      const aprobaciones = await query(
        `
    SELECT sa.*, u.nombre as usuario_nombre
    FROM solicitud_aprobaciones sa
    JOIN users u ON sa.user_id = u.id
    WHERE sa.solicitud_pago_id = $1
    ORDER BY sa.orden
  `,
        [id],
      );

      // Adjuntos (solo normales, no comprobantes)
      const adjuntos = await query(
        `
    SELECT a.*, u.nombre as subido_por_nombre
    FROM solicitud_pago_adjuntos a
    LEFT JOIN users u ON a.subido_por = u.id
    WHERE a.solicitud_pago_id = $1 AND (a.tipo_adjunto = 'adjunto' OR a.tipo_adjunto IS NULL)
    ORDER BY a.created_at DESC
  `,
        [id],
      );

      // Aprobadores configurados del proyecto
      const proyectoId = solicitud.rows[0].proyecto_id;
      const aprobadoresProyecto = await query(
        `
    SELECT pas.user_id, pas.orden, u.nombre, u.email
    FROM project_approval_settings pas
    JOIN users u ON pas.user_id = u.id
    WHERE pas.proyecto_id = $1 AND pas.activo = true
    ORDER BY pas.orden
  `,
        [proyectoId],
      );

      // Comprobante de pago (si está pagada o facturada)
      let comprobante = null;
      if (
        solicitud.rows[0].estado === 'pagada' ||
        solicitud.rows[0].estado === 'facturada'
      ) {
        const compResult = await query<{
          fecha_pago: string;
          registrado_por_nombre: string;
        }>(
          `
      SELECT cp.fecha_pago, u.nombre as registrado_por_nombre
      FROM comprobantes_pago cp
      LEFT JOIN users u ON cp.registrado_por = u.id
      WHERE cp.solicitud_pago_id = $1
    `,
          [id],
        );

        if (compResult.rows.length > 0) {
          const compAdjuntos = await query(
            `
        SELECT a.*, u.nombre as subido_por_nombre
        FROM solicitud_pago_adjuntos a
        LEFT JOIN users u ON a.subido_por = u.id
        WHERE a.solicitud_pago_id = $1 AND a.tipo_adjunto = 'comprobante'
        ORDER BY a.created_at DESC
      `,
            [id],
          );

          comprobante = {
            ...compResult.rows[0],
            adjuntos: compAdjuntos.rows,
          };
        }
      }

      // Factura (si está facturada)
      let factura = null;
      if (solicitud.rows[0].estado === 'facturada') {
        const factResult = await query<{
          fecha_factura: string;
          numero_factura: string | null;
          tipo: string;
          registrado_por_nombre: string;
        }>(
          `
      SELECT fs.fecha_factura, fs.numero_factura, COALESCE(fs.tipo, 'factura') as tipo, u.nombre as registrado_por_nombre
      FROM facturas_solicitud fs
      LEFT JOIN users u ON fs.registrado_por = u.id
      WHERE fs.solicitud_pago_id = $1
    `,
          [id],
        );

        if (factResult.rows.length > 0) {
          const factAdjuntos = await query(
            `
        SELECT a.*, u.nombre as subido_por_nombre
        FROM solicitud_pago_adjuntos a
        LEFT JOIN users u ON a.subido_por = u.id
        WHERE a.solicitud_pago_id = $1 AND a.tipo_adjunto = 'factura'
        ORDER BY a.created_at DESC
      `,
            [id],
          );

          factura = {
            ...factResult.rows[0],
            adjuntos: factAdjuntos.rows,
          };
        }
      }

      // Reembolso a Pinellas (si aplica)
      let reembolso = null;
      if (solicitud.rows[0].pinellas_paga) {
        const reembolsoResult = await query<{
          id: number;
          comprobante_url: string | null;
          comprobante_nombre: string | null;
          fecha_reembolso: string;
          registrado_por_nombre: string;
          created_at: string;
        }>(
          `
      SELECT rp.*, u.nombre as registrado_por_nombre
      FROM reembolsos_pinellas rp
      LEFT JOIN users u ON rp.registrado_por = u.id
      WHERE rp.solicitud_id = $1
    `,
          [id],
        );
        if (reembolsoResult.rows.length > 0) {
          reembolso = reembolsoResult.rows[0];
        }
      }

      // Devolución (si aplica)
      let devolucion = null;
      if (solicitud.rows[0].estado === 'devolucion') {
        const devResult = await query<{
          id: number;
          fecha_devolucion: string;
          motivo: string;
          comprobante_url: string;
          comprobante_nombre: string;
          registrado_por_nombre: string;
          created_at: string;
        }>(
          `
      SELECT ds.*, u.nombre as registrado_por_nombre
      FROM devoluciones_solicitud ds
      LEFT JOIN users u ON ds.registrado_por = u.id
      WHERE ds.solicitud_id = $1
    `,
          [id],
        );
        if (devResult.rows.length > 0) {
          devolucion = devResult.rows[0];
        }
      }

      // Calculate puede_eliminar (mirrors DELETE /:id logic)
      const sol = solicitud.rows[0];
      const isAdmin = req.user?.rol === 'admin';
      const testProjectId = process.env.TEST_PROJECT_ID ? parseInt(process.env.TEST_PROJECT_ID) : null;
      const isEstadoProtegido = sol.estado === 'pagada' || sol.estado === 'facturada' || sol.estado === 'devolucion';
      let puede_eliminar = false;
      if (isAdmin) {
        // Admin can delete anything except protected states outside test project
        puede_eliminar = !isEstadoProtegido || sol.proyecto_id === testProjectId;
      } else {
        // Non-admin: only pendiente, own solicitud, no approvals
        puede_eliminar =
          sol.estado === 'pendiente' &&
          aprobaciones.rows.length === 0 &&
          (sol.preparado_por === req.user?.id || !!req.user?.permissions?.solicitudes_editar_todas);
      }

      res.json({
        success: true,
        solicitud: solicitud.rows[0],
        items: items.rows,
        ajustes: ajustes.rows,
        adjuntos: adjuntos.rows,
        aprobaciones: aprobaciones.rows,
        aprobadores_proyecto: aprobadoresProyecto.rows,
        comprobante,
        factura,
        reembolso,
        devolucion,
        puede_eliminar,
      });
    },
  ),
);

// --- POST / — Crear solicitud ---
router.post(
  '/',
  [
    body('proyecto_id').isInt().withMessage('Proyecto requerido'),
    body('proveedor').trim().notEmpty().withMessage('Proveedor requerido'),
    body('items')
      .isArray({ min: 1 })
      .withMessage('Debe incluir al menos un item'),
  ],
  asyncHandler(
    async (
      req: Request<object, object, CreateBody>,
      res: Response,
    ): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({
          success: false,
          message: 'Datos inválidos',
          errors: errors.array(),
        });
        return;
      }

      const {
        proyecto_id,
        fecha,
        proveedor,
        solicitado_por,
        requisicion_id,
        observaciones,
        beneficiario,
        banco,
        tipo_cuenta,
        numero_cuenta,
        urgente,
        pinellas_paga,
        items,
        ajustes = [],
      } = req.body;

      // Verificar que el proyecto tiene aprobadores configurados
      const approvers = await query(
        'SELECT id FROM project_approval_settings WHERE proyecto_id = $1 AND activo = true',
        [proyecto_id],
      );
      if (approvers.rows.length === 0) {
        res.status(400).json({
          success: false,
          message:
            'Configure aprobadores en la sección de Miembros antes de crear solicitudes',
        });
        return;
      }

      // Calcular totales antes de la transacción
      const itemsCalculados = items.map((item, index) => ({
        ...item,
        precio_total: (item.cantidad || 1) * (item.precio_unitario || 0),
        orden: index,
      }));

      const subtotal = itemsCalculados.reduce(
        (sum, item) => sum + item.precio_total,
        0,
      );

      const ajustesCalculados = ajustes.map((ajuste, index) => ({
        ...ajuste,
        monto: ajuste.porcentaje
          ? (subtotal * ajuste.porcentaje) / 100
          : ajuste.monto,
        orden: index,
      }));

      const totalDescuentos = ajustesCalculados
        .filter((a) => a.tipo === 'descuento')
        .reduce((sum, a) => sum + Math.abs(a.monto), 0);

      const totalImpuestos = ajustesCalculados
        .filter((a) => a.tipo === 'impuesto')
        .reduce((sum, a) => sum + Math.abs(a.monto), 0);

      const montoTotal = subtotal - totalDescuentos + totalImpuestos;

      const codigoVerificacion = generateCodigoVerificacion();

      // Transaction with advisory lock to prevent duplicate numero
      const client = await pool.connect();
      let result: { rows: SolicitudRow[] };
      try {
        await client.query('BEGIN');
        // Advisory lock on proyecto_id serializes number generation per project
        await client.query('SELECT pg_advisory_xact_lock($1)', [proyecto_id]);

        let numero: string;
        try {
          numero = await generateNumero(proyecto_id, client);
        } catch (err) {
          const error = err as Error;
          if (error.message === 'PREFIJO_NO_CONFIGURADO') {
            await client.query('ROLLBACK');
            res.status(400).json({
              success: false,
              message:
                'Configure el prefijo del proyecto antes de crear solicitudes',
            });
            return;
          }
          throw err;
        }

        result = await client.query(
          `
    INSERT INTO solicitudes_pago (
      proyecto_id, numero, fecha, proveedor, preparado_por, solicitado_por,
      requisicion_id, subtotal, descuentos, impuestos, monto_total,
      estado, observaciones, beneficiario, banco, tipo_cuenta, numero_cuenta, urgente,
      pinellas_paga, codigo_verificacion
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pendiente', $12, $13, $14, $15, $16, $17, $18, $19)
    RETURNING *
  `,
          [
            proyecto_id,
            numero,
            fecha || new Date().toISOString().split('T')[0],
            proveedor,
            req.user!.id,
            solicitado_por || null,
            requisicion_id || null,
            subtotal,
            totalDescuentos,
            totalImpuestos,
            montoTotal,
            observaciones || null,
            beneficiario || null,
            banco || null,
            tipo_cuenta || null,
            numero_cuenta || null,
            urgente || false,
            pinellas_paga || false,
            codigoVerificacion,
          ],
        );

        const solicitudId = result.rows[0].id;

        // Insertar items
        for (const item of itemsCalculados) {
          await client.query(
            `
      INSERT INTO solicitud_pago_items (solicitud_pago_id, cantidad, unidad, descripcion, descripcion_detallada, precio_unitario, precio_total, orden)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `,
            [
              solicitudId,
              item.cantidad || 1,
              item.unidad || 'unidad',
              item.descripcion,
              item.descripcion_detallada || null,
              item.precio_unitario,
              item.precio_total,
              item.orden,
            ],
          );
        }

        // Insertar ajustes
        for (const ajuste of ajustesCalculados) {
          await client.query(
            `
      INSERT INTO solicitud_pago_ajustes (solicitud_pago_id, tipo, descripcion, porcentaje, monto, orden)
      VALUES ($1, $2, $3, $4, $5, $6)
    `,
            [
              solicitudId,
              ajuste.tipo,
              ajuste.descripcion,
              ajuste.porcentaje || null,
              ajuste.monto,
              ajuste.orden,
            ],
          );
        }

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      res.status(201).json({
        success: true,
        message: 'Solicitud de pago creada',
        solicitud: result.rows[0],
      });

      // Notificar al primer aprobador si es urgente (fire and forget)
      if (urgente) {
        (async () => {
          try {
            const aprobadorResult = await query<{
              nombre: string;
              email: string;
            }>(
              `SELECT u.nombre, u.email FROM project_approval_settings pas
           JOIN users u ON u.id = pas.user_id
           WHERE pas.proyecto_id = $1 AND pas.activo = true
           ORDER BY pas.orden ASC LIMIT 1`,
              [proyecto_id],
            );
            if (
              aprobadorResult.rows.length === 0 ||
              !aprobadorResult.rows[0].email
            )
              return;

            const proyectoResult = await query<{ nombre_corto: string }>(
              'SELECT nombre_corto FROM proyectos WHERE id = $1',
              [proyecto_id],
            );
            const nombreProyecto =
              proyectoResult.rows[0]?.nombre_corto || 'Proyecto';
            const { nombre: aprobadorNombre, email: aprobadorEmail } =
              aprobadorResult.rows[0];

            await sendEmail(
              aprobadorEmail,
              `⚠️ Solicitud Urgente: ${result.rows[0].numero} - ${proveedor}`,
              `<div style="font-family: Arial, sans-serif; max-width: 600px;">
            <h2 style="color: #d97706;">⚠️ Solicitud de Pago Urgente</h2>
            <p>Hola ${aprobadorNombre},</p>
            <p>Se ha creado una solicitud de pago <strong>urgente</strong> que requiere tu aprobación:</p>
            <table style="border-collapse: collapse; width: 100%; margin: 16px 0;">
              <tr><td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Número</td><td style="padding: 8px; border: 1px solid #ddd;">${result.rows[0].numero}</td></tr>
              <tr><td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Proveedor</td><td style="padding: 8px; border: 1px solid #ddd;">${proveedor}</td></tr>
              <tr><td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Monto Total</td><td style="padding: 8px; border: 1px solid #ddd;">$${montoTotal.toFixed(2)}</td></tr>
              <tr><td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Proyecto</td><td style="padding: 8px; border: 1px solid #ddd;">${nombreProyecto}</td></tr>
            </table>
            <p><a href="https://sistema.pinellaspanama.com" style="background: #d97706; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px;">Ir al Sistema</a></p>
          </div>`,
            );
          } catch (err) {
            console.error('Error enviando email de solicitud urgente:', err);
          }
        })();
      }
    },
  ),
);

// --- PUT /:id — Editar solicitud ---
router.put(
  '/:id',
  [
    param('id').isInt(),
    body('proveedor').trim().notEmpty().withMessage('Proveedor requerido'),
    body('items')
      .isArray({ min: 1 })
      .withMessage('Debe incluir al menos un item'),
  ],
  asyncHandler(
    async (
      req: Request<{ id: string }, object, CreateBody>,
      res: Response,
    ): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({
          success: false,
          message: 'Datos inválidos',
          errors: errors.array(),
        });
        return;
      }

      const { id } = req.params;

      // Verificar que existe y está en estado editable
      const existing = await query<SolicitudRow & { preparado_por: number }>(
        'SELECT id, estado, preparado_por FROM solicitudes_pago WHERE id = $1',
        [id],
      );
      if (existing.rows.length === 0) {
        res
          .status(404)
          .json({ success: false, message: 'Solicitud no encontrada' });
        return;
      }
      if (!['pendiente'].includes(existing.rows[0].estado)) {
        res.status(400).json({
          success: false,
          message: 'Solo se pueden editar solicitudes en estado pendiente',
        });
        return;
      }

      // Verificar permisos: admin/co-admin pasan; usuario con solicitudes_editar_todas pasa; sino verificar propiedad
      if (
        req.user?.rol === 'usuario' &&
        !req.user?.permissions?.solicitudes_editar_todas
      ) {
        if (existing.rows[0].preparado_por !== req.user.id) {
          res.status(403).json({
            success: false,
            message: 'Solo puedes editar tus propias solicitudes',
          });
          return;
        }
      }

      // Verificar estado de aprobaciones
      const aprobacionesResult = await query<{ count: string }>(
        'SELECT COUNT(*) as count FROM solicitud_aprobaciones WHERE solicitud_pago_id = $1 AND accion = $2',
        [id, 'aprobado'],
      );
      const aprobacionesCount = parseInt(aprobacionesResult.rows[0].count);

      const aprobadoresTotalResult = await query<{ count: string }>(
        'SELECT COUNT(*) as count FROM project_approval_settings WHERE proyecto_id = $1 AND activo = true',
        [existing.rows[0].proyecto_id],
      );
      const aprobadoresTotal = parseInt(aprobadoresTotalResult.rows[0].count);

      if (
        aprobacionesCount > 0 &&
        aprobadoresTotal > 0 &&
        aprobacionesCount >= aprobadoresTotal
      ) {
        res.status(403).json({
          success: false,
          message:
            'No se puede editar una solicitud con todas las aprobaciones completas',
        });
        return;
      }

      const tieneAprobacionesParciales = aprobacionesCount > 0;

      const {
        fecha,
        proveedor,
        solicitado_por,
        requisicion_id,
        observaciones,
        beneficiario,
        banco,
        tipo_cuenta,
        numero_cuenta,
        urgente,
        pinellas_paga,
        items,
        ajustes = [],
      } = req.body;

      // Recalcular totales
      const itemsCalculados = items.map((item, index) => ({
        ...item,
        precio_total: (item.cantidad || 1) * (item.precio_unitario || 0),
        orden: index,
      }));

      const subtotal = itemsCalculados.reduce(
        (sum, item) => sum + item.precio_total,
        0,
      );

      const ajustesCalculados = ajustes.map((ajuste, index) => ({
        ...ajuste,
        monto: ajuste.porcentaje
          ? (subtotal * ajuste.porcentaje) / 100
          : ajuste.monto,
        orden: index,
      }));

      const totalDescuentos = ajustesCalculados
        .filter((a) => a.tipo === 'descuento')
        .reduce((sum, a) => sum + Math.abs(a.monto), 0);
      const totalImpuestos = ajustesCalculados
        .filter((a) => a.tipo === 'impuesto')
        .reduce((sum, a) => sum + Math.abs(a.monto), 0);
      const montoTotal = subtotal - totalDescuentos + totalImpuestos;

      // Actualizar solicitud
      const result = await query<SolicitudRow>(
        `
    UPDATE solicitudes_pago SET
      fecha = $1, proveedor = $2, solicitado_por = $3, requisicion_id = $4,
      subtotal = $5, descuentos = $6, impuestos = $7, monto_total = $8,
      observaciones = $9, beneficiario = $10, banco = $11, tipo_cuenta = $12,
      numero_cuenta = $13, urgente = $14, pinellas_paga = $15, updated_at = CURRENT_TIMESTAMP
    WHERE id = $16 RETURNING *
  `,
        [
          fecha || new Date().toISOString().split('T')[0],
          proveedor,
          solicitado_por || null,
          requisicion_id || null,
          subtotal,
          totalDescuentos,
          totalImpuestos,
          montoTotal,
          observaciones || null,
          beneficiario || null,
          banco || null,
          tipo_cuenta || null,
          numero_cuenta || null,
          urgente || false,
          pinellas_paga || false,
          id,
        ],
      );

      // Reemplazar items
      await query(
        'DELETE FROM solicitud_pago_items WHERE solicitud_pago_id = $1',
        [id],
      );
      for (const item of itemsCalculados) {
        await query(
          `
      INSERT INTO solicitud_pago_items (solicitud_pago_id, cantidad, unidad, descripcion, descripcion_detallada, precio_unitario, precio_total, orden)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `,
          [
            id,
            item.cantidad || 1,
            item.unidad || 'unidad',
            item.descripcion,
            item.descripcion_detallada || null,
            item.precio_unitario,
            item.precio_total,
            item.orden,
          ],
        );
      }

      // Reemplazar ajustes
      await query(
        'DELETE FROM solicitud_pago_ajustes WHERE solicitud_pago_id = $1',
        [id],
      );
      for (const ajuste of ajustesCalculados) {
        await query(
          `
      INSERT INTO solicitud_pago_ajustes (solicitud_pago_id, tipo, descripcion, porcentaje, monto, orden)
      VALUES ($1, $2, $3, $4, $5, $6)
    `,
          [
            id,
            ajuste.tipo,
            ajuste.descripcion,
            ajuste.porcentaje || null,
            ajuste.monto,
            ajuste.orden,
          ],
        );
      }

      // Si tenía aprobaciones parciales, anularlas y resetear estado
      if (tieneAprobacionesParciales) {
        await query(
          'DELETE FROM solicitud_aprobaciones WHERE solicitud_pago_id = $1',
          [id],
        );
        await query(
          'DELETE FROM solicitud_revisiones WHERE solicitud_pago_id = $1',
          [id],
        );
        await query(
          'UPDATE solicitudes_pago SET estado = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
          ['pendiente', id],
        );
      }

      res.json({
        success: true,
        message: 'Solicitud actualizada',
        solicitud: result.rows[0],
        aprobaciones_anuladas: tieneAprobacionesParciales,
      });
    },
  ),
);

// --- PATCH /:id/pinellas-paga — Toggle pinellas_paga ---
router.patch(
  '/:id/pinellas-paga',
  [
    param('id').isInt(),
    body('pinellas_paga')
      .isBoolean()
      .withMessage('pinellas_paga debe ser booleano'),
  ],
  asyncHandler(
    async (req: Request<{ id: string }>, res: Response): Promise<void> => {
      const { id } = req.params;
      const { pinellas_paga } = req.body;

      const existing = await query<SolicitudRow>(
        'SELECT id, estado, pinellas_paga, preparado_por FROM solicitudes_pago WHERE id = $1',
        [id],
      );
      if (existing.rows.length === 0) {
        res
          .status(404)
          .json({ success: false, message: 'Solicitud no encontrada' });
        return;
      }

      const sol = existing.rows[0];
      const userId = req.user!.id;
      const userRol = req.user!.rol;
      const isAdminOrCoAdmin =
        userRol === 'admin' || userRol === 'co-admin';
      const isCreator = sol.preparado_por === userId;

      if (!isAdminOrCoAdmin && !isCreator) {
        res.status(403).json({
          success: false,
          message: 'No tienes permiso para cambiar este campo',
        });
        return;
      }

      // Block toggle ON if solicitud reached pagada/facturada without being marked
      if (
        pinellas_paga === true &&
        !sol.pinellas_paga &&
        (sol.estado === 'pagada' || sol.estado === 'facturada')
      ) {
        res.status(400).json({
          success: false,
          message:
            'No se puede marcar como "Pinellas paga" una solicitud que ya fue pagada o facturada sin esta marca',
        });
        return;
      }

      await query(
        'UPDATE solicitudes_pago SET pinellas_paga = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        [pinellas_paga, id],
      );

      res.json({ success: true, message: 'Campo pinellas_paga actualizado' });
    },
  ),
);

// --- PATCH /:id/estado — Cambiar estado ---
router.patch(
  '/:id/estado',
  [
    param('id').isInt(),
    body('estado')
      .isIn(['pendiente', 'rechazada', 'pagada'])
      .withMessage('Estado inválido'),
  ],
  asyncHandler(
    async (req: Request<{ id: string }>, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({
          success: false,
          message: 'Datos inválidos',
          errors: errors.array(),
        });
        return;
      }

      const { id } = req.params;
      const { estado } = req.body;

      const existing = await query<SolicitudRow>(
        'SELECT id, estado FROM solicitudes_pago WHERE id = $1',
        [id],
      );
      if (existing.rows.length === 0) {
        res
          .status(404)
          .json({ success: false, message: 'Solicitud no encontrada' });
        return;
      }

      const estadoActual = existing.rows[0].estado;
      const permitidos = TRANSICIONES[estadoActual] || [];

      if (!permitidos.includes(estado)) {
        res.status(400).json({
          success: false,
          message: `No se puede cambiar de "${estadoActual}" a "${estado}"`,
        });
        return;
      }

      // Si se reenvía (rechazada → pendiente), limpiar aprobaciones anteriores
      if (estadoActual === 'rechazada' && estado === 'pendiente') {
        await query(
          'DELETE FROM solicitud_aprobaciones WHERE solicitud_pago_id = $1',
          [id],
        );
      }

      const result = await query<SolicitudRow>(
        'UPDATE solicitudes_pago SET estado = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *',
        [estado, id],
      );

      res.json({
        success: true,
        message: `Estado cambiado a ${estado}`,
        solicitud: result.rows[0],
      });
    },
  ),
);

// --- Multer config for comprobante upload ---
const comprobanteUpload = multer({
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

function sanitizeFilename(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_');
}

// --- POST /:id/corregir — Modo corrección admin ---
router.post(
  '/:id/corregir',
  [param('id').isInt()],
  requireRole(['admin']),
  (req: Request, res: Response, next: NextFunction) => {
    comprobanteUpload.fields([
      { name: 'archivos_comprobante', maxCount: 5 },
      { name: 'archivos_factura', maxCount: 5 },
    ])(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          res.status(400).json({ success: false, message: 'El archivo excede el limite de 10MB' });
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
  },
  asyncHandler(
    async (req: Request<{ id: string }>, res: Response): Promise<void> => {
      const { id } = req.params;
      const userId = req.user!.id;
      const { motivo, updated_at, items, ajustes, ...solicitudFields } = req.body;
      const files = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined;

      // Validate motivo
      if (!motivo || !motivo.trim()) {
        res.status(400).json({ success: false, message: 'El motivo de la corrección es obligatorio' });
        return;
      }

      // Load current state
      const currentResult = await query<SolicitudRow & { nombre_corto: string }>(
        `SELECT sp.*, COALESCE(p.nombre_corto, p.nombre) as nombre_corto
         FROM solicitudes_pago sp
         LEFT JOIN proyectos p ON sp.proyecto_id = p.id
         WHERE sp.id = $1`,
        [id],
      );
      if (currentResult.rows.length === 0) {
        res.status(404).json({ success: false, message: 'Solicitud no encontrada' });
        return;
      }

      const current = currentResult.rows[0];

      // Validate estado
      if (current.estado !== 'pagada' && current.estado !== 'facturada') {
        res.status(400).json({ success: false, message: 'Solo se pueden corregir solicitudes pagadas o facturadas' });
        return;
      }

      // Optimistic lock check
      if (updated_at && new Date(current.updated_at).getTime() !== new Date(updated_at).getTime()) {
        res.status(409).json({ success: false, message: 'La solicitud fue modificada por otro usuario. Recargue e intente de nuevo.' });
        return;
      }

      // Parse items and ajustes from body (sent as JSON strings in multipart)
      const parsedItems = typeof items === 'string' ? JSON.parse(items) : items || [];
      const parsedAjustes = typeof ajustes === 'string' ? JSON.parse(ajustes) : ajustes || [];

      if (!Array.isArray(parsedItems) || parsedItems.length === 0) {
        res.status(400).json({ success: false, message: 'Debe incluir al menos un item' });
        return;
      }

      // Build diff for solicitud fields
      const solicitudDiffFields = [
        'proveedor', 'fecha', 'observaciones', 'beneficiario',
        'banco', 'tipo_cuenta', 'numero_cuenta',
      ];
      const cambios: Cambio[] = buildSolicitudDiff(
        current as unknown as Record<string, unknown>,
        solicitudFields,
        solicitudDiffFields.filter((f) => solicitudFields[f] !== undefined),
      );

      // Load current comprobante and factura for diff
      const currentComprobante = await query<{ fecha_pago: string }>(
        'SELECT fecha_pago FROM comprobantes_pago WHERE solicitud_pago_id = $1',
        [id],
      );
      const currentFactura = await query<{ fecha_factura: string; numero_factura: string; tipo: string }>(
        'SELECT fecha_factura, numero_factura, COALESCE(tipo, \'factura\') as tipo FROM facturas_solicitud WHERE solicitud_pago_id = $1',
        [id],
      );

      // Diff comprobante fields
      if (solicitudFields.fecha_pago !== undefined && currentComprobante.rows.length > 0) {
        const oldFechaPago = normalizeDate(currentComprobante.rows[0].fecha_pago);
        const newFechaPago = normalizeDate(solicitudFields.fecha_pago);
        if (oldFechaPago !== newFechaPago) {
          cambios.push({ campo: 'fecha_pago', anterior: oldFechaPago, nuevo: newFechaPago });
        }
      }

      // Diff factura fields
      if (currentFactura.rows.length > 0) {
        const factFields = ['fecha_factura', 'numero_factura', 'tipo'];
        for (const f of factFields) {
          if (solicitudFields[f] !== undefined) {
            let oldVal: string;
            let newVal: string;
            if (DATE_FIELDS.includes(f)) {
              oldVal = normalizeDate(currentFactura.rows[0][f as keyof typeof currentFactura.rows[0]]);
              newVal = normalizeDate(solicitudFields[f]);
            } else {
              oldVal = String(currentFactura.rows[0][f as keyof typeof currentFactura.rows[0]] ?? '');
              newVal = String(solicitudFields[f] ?? '');
            }
            if (oldVal !== newVal) {
              cambios.push({ campo: f, anterior: oldVal, nuevo: newVal });
            }
          }
        }
      }

      // Diff items
      const currentItems = await query<ItemRow>(
        'SELECT * FROM solicitud_pago_items WHERE solicitud_pago_id = $1 ORDER BY orden, id',
        [id],
      );

      const currentItemsMap = new Map(currentItems.rows.map((item) => [item.id, item]));
      const submittedItemIds = new Set(parsedItems.filter((i: { id?: number }) => i.id).map((i: { id: number }) => i.id));

      // Items removed
      for (const oldItem of currentItems.rows) {
        if (!submittedItemIds.has(oldItem.id)) {
          cambios.push({
            campo: 'item_eliminado',
            descripcion: oldItem.descripcion,
            anterior: {
              cantidad: oldItem.cantidad,
              unidad: oldItem.unidad,
              precio_unitario: oldItem.precio_unitario,
              precio_total: oldItem.precio_total,
            },
          });
        }
      }

      // Items modified or added
      for (const newItem of parsedItems) {
        if (newItem.id && currentItemsMap.has(newItem.id)) {
          const oldItem = currentItemsMap.get(newItem.id)!;
          const itemCambios: { campo: string; anterior: string; nuevo: string }[] = [];
          const itemFields = ['descripcion', 'cantidad', 'unidad', 'precio_unitario'];
          for (const f of itemFields) {
            let oldVal: string;
            let newVal: string;
            if (NUMERIC_FIELDS.includes(f)) {
              oldVal = normalizeNumeric(oldItem[f as keyof typeof oldItem]);
              newVal = normalizeNumeric(newItem[f]);
            } else {
              oldVal = String(oldItem[f as keyof typeof oldItem] ?? '');
              newVal = String(newItem[f] ?? '');
            }
            if (oldVal !== newVal) {
              itemCambios.push({ campo: f, anterior: oldVal, nuevo: newVal });
            }
          }
          if (itemCambios.length > 0) {
            cambios.push({
              campo: 'item',
              item_id: newItem.id,
              descripcion: oldItem.descripcion,
              cambios: itemCambios,
            });
          }
        } else if (!newItem.id) {
          cambios.push({
            campo: 'item_agregado',
            descripcion: newItem.descripcion,
            nuevo: {
              cantidad: newItem.cantidad,
              unidad: newItem.unidad,
              precio_unitario: newItem.precio_unitario,
            },
          });
        }
      }

      // Diff files
      const comprobanteFiles = files?.archivos_comprobante;
      const facturaFiles = files?.archivos_factura;
      if (comprobanteFiles && comprobanteFiles.length > 0) {
        cambios.push({
          campo: 'comprobante',
          anterior: '(archivos anteriores)',
          nuevo: comprobanteFiles.map((f) => f.originalname).join(', '),
        });
      }
      if (facturaFiles && facturaFiles.length > 0) {
        cambios.push({
          campo: 'factura',
          anterior: '(archivos anteriores)',
          nuevo: facturaFiles.map((f) => f.originalname).join(', '),
        });
      }

      // Reject if nothing changed
      if (cambios.length === 0) {
        res.status(400).json({ success: false, message: 'No se detectaron cambios' });
        return;
      }

      // Calculate new totals from items
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const itemsCalculados = parsedItems.map((item: any) => {
        const cantidad = parseFloat(String(item.cantidad)) || 1;
        const precioUnitario = parseFloat(String(item.precio_unitario)) || 0;
        return { ...item, cantidad, precio_unitario: precioUnitario, precio_total: cantidad * precioUnitario };
      });

      const newSubtotal = itemsCalculados.reduce(
        (sum: number, item: { precio_total: number }) => sum + item.precio_total,
        0,
      );

      const ajustesCalculados = parsedAjustes.map((a: { tipo?: string; monto?: number; porcentaje?: number; [key: string]: unknown }) => ({
        ...a,
        monto: parseFloat(String(a.monto)) || 0,
        porcentaje: a.porcentaje ? parseFloat(String(a.porcentaje)) : null,
      }));

      const newImpuestos = ajustesCalculados
        .filter((a: { tipo: string }) => a.tipo === 'impuesto' || a.tipo === 'aumento')
        .reduce((sum: number, a: { monto: number }) => sum + a.monto, 0);

      const newDescuentos = ajustesCalculados
        .filter((a: { tipo: string }) => a.tipo === 'descuento' || a.tipo === 'disminucion')
        .reduce((sum: number, a: { monto: number }) => sum + a.monto, 0);

      const newMontoTotal = newSubtotal + newImpuestos - newDescuentos;

      // Check if totals changed and add to diff (round to 2 decimals to avoid float noise)
      const oldSubtotal = Math.round(parseFloat(String(current.subtotal)) * 100) / 100;
      const roundedNewSubtotal = Math.round(newSubtotal * 100) / 100;
      const oldMontoTotal = Math.round(parseFloat(String(current.monto_total)) * 100) / 100;
      const roundedNewMontoTotal = Math.round(newMontoTotal * 100) / 100;
      if (oldSubtotal !== roundedNewSubtotal) {
        cambios.push({ campo: 'subtotal', anterior: String(oldSubtotal), nuevo: String(roundedNewSubtotal) });
      }
      if (oldMontoTotal !== roundedNewMontoTotal) {
        cambios.push({ campo: 'monto_total', anterior: String(oldMontoTotal), nuevo: String(roundedNewMontoTotal) });
      }

      // --- Execute transaction ---
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Update solicitud main fields
        const updateFields: string[] = [];
        const updateValues: unknown[] = [];
        let paramIndex = 1;

        for (const field of solicitudDiffFields) {
          if (solicitudFields[field] !== undefined) {
            updateFields.push(`${field} = $${paramIndex}`);
            updateValues.push(solicitudFields[field]);
            paramIndex++;
          }
        }

        // Always update totals and updated_at
        updateFields.push(`subtotal = $${paramIndex}`);
        updateValues.push(newSubtotal);
        paramIndex++;
        updateFields.push(`descuentos = $${paramIndex}`);
        updateValues.push(newDescuentos);
        paramIndex++;
        updateFields.push(`impuestos = $${paramIndex}`);
        updateValues.push(newImpuestos);
        paramIndex++;
        updateFields.push(`monto_total = $${paramIndex}`);
        updateValues.push(newMontoTotal);
        paramIndex++;
        updateFields.push(`updated_at = CURRENT_TIMESTAMP`);

        updateValues.push(id);
        await client.query(
          `UPDATE solicitudes_pago SET ${updateFields.join(', ')} WHERE id = $${paramIndex}`,
          updateValues,
        );

        // Replace items
        await client.query('DELETE FROM solicitud_pago_items WHERE solicitud_pago_id = $1', [id]);
        for (let i = 0; i < itemsCalculados.length; i++) {
          const item = itemsCalculados[i];
          await client.query(
            `INSERT INTO solicitud_pago_items (solicitud_pago_id, cantidad, unidad, descripcion, descripcion_detallada, precio_unitario, precio_total, orden)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              id,
              item.cantidad,
              item.unidad || 'unidad',
              item.descripcion,
              item.descripcion_detallada || null,
              item.precio_unitario,
              item.precio_total,
              i,
            ],
          );
        }

        // Replace ajustes
        await client.query('DELETE FROM solicitud_pago_ajustes WHERE solicitud_pago_id = $1', [id]);
        for (let i = 0; i < ajustesCalculados.length; i++) {
          const ajuste = ajustesCalculados[i];
          await client.query(
            `INSERT INTO solicitud_pago_ajustes (solicitud_pago_id, tipo, descripcion, porcentaje, monto, orden)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [id, ajuste.tipo, ajuste.descripcion, ajuste.porcentaje, ajuste.monto, i],
          );
        }

        // Update comprobante fields
        if (solicitudFields.fecha_pago !== undefined && currentComprobante.rows.length > 0) {
          await client.query(
            'UPDATE comprobantes_pago SET fecha_pago = $1 WHERE solicitud_pago_id = $2',
            [solicitudFields.fecha_pago, id],
          );
        }

        // Update factura fields
        if (currentFactura.rows.length > 0) {
          const factUpdates: string[] = [];
          const factValues: unknown[] = [];
          let fIdx = 1;
          if (solicitudFields.fecha_factura !== undefined) {
            factUpdates.push(`fecha_factura = $${fIdx}`);
            factValues.push(solicitudFields.fecha_factura);
            fIdx++;
          }
          if (solicitudFields.numero_factura !== undefined) {
            factUpdates.push(`numero_factura = $${fIdx}`);
            factValues.push(solicitudFields.numero_factura || null);
            fIdx++;
          }
          if (solicitudFields.tipo !== undefined) {
            factUpdates.push(`tipo = $${fIdx}`);
            factValues.push(solicitudFields.tipo);
            fIdx++;
          }
          if (factUpdates.length > 0) {
            factValues.push(id);
            await client.query(
              `UPDATE facturas_solicitud SET ${factUpdates.join(', ')} WHERE solicitud_pago_id = $${fIdx}`,
              factValues,
            );
          }
        }

        // Upload replacement comprobante files
        if (comprobanteFiles && comprobanteFiles.length > 0) {
          await client.query(
            `DELETE FROM solicitud_pago_adjuntos WHERE solicitud_pago_id = $1 AND tipo_adjunto = 'comprobante'`,
            [id],
          );
          for (const file of comprobanteFiles) {
            const uuid = crypto.randomUUID();
            const safeName = sanitizeFilename(file.originalname);
            const r2Key = `solicitudes-pago/${id}/comprobantes/${uuid}_${safeName}`;
            await uploadFile(r2Key, file.buffer, file.mimetype);
            await client.query(
              `INSERT INTO solicitud_pago_adjuntos (solicitud_pago_id, nombre_original, r2_key, tipo_mime, tamano, subido_por, tipo_adjunto)
               VALUES ($1, $2, $3, $4, $5, $6, 'comprobante')`,
              [id, file.originalname, r2Key, file.mimetype, file.size, userId],
            );
          }
        }

        // Upload replacement factura files
        if (facturaFiles && facturaFiles.length > 0) {
          await client.query(
            `DELETE FROM solicitud_pago_adjuntos WHERE solicitud_pago_id = $1 AND tipo_adjunto = 'factura'`,
            [id],
          );
          for (const file of facturaFiles) {
            const uuid = crypto.randomUUID();
            const safeName = sanitizeFilename(file.originalname);
            const r2Key = `solicitudes-pago/${id}/facturas/${uuid}_${safeName}`;
            await uploadFile(r2Key, file.buffer, file.mimetype);
            await client.query(
              `INSERT INTO solicitud_pago_adjuntos (solicitud_pago_id, nombre_original, r2_key, tipo_mime, tamano, subido_por, tipo_adjunto)
               VALUES ($1, $2, $3, $4, $5, $6, 'factura')`,
              [id, file.originalname, r2Key, file.mimetype, file.size, userId],
            );
          }
        }

        // Insert correction record
        const versionPdf: string | null = null;
        await client.query(
          `INSERT INTO correcciones_solicitud (solicitud_pago_id, user_id, motivo, cambios, version_pdf)
           VALUES ($1, $2, $3, $4, $5)`,
          [id, userId, motivo.trim(), JSON.stringify(cambios), versionPdf],
        );

        // Audit log
        await registrarAudit(userId, 'correccion', 'solicitud_pago', parseInt(id), {
          numero: current.numero,
          motivo: motivo.trim(),
          cambios_count: cambios.length,
        });

        await client.query('COMMIT');

        // Post-transaction: generate versioned PDF if archived PDF exists
        if (current.estado === 'pagada' || current.estado === 'facturada') {
          try {
            const nombreCorto = current.nombre_corto;
            const numero = current.numero;
            const baseKey = `${nombreCorto}/solicitudes/${numero}.pdf`;

            // Check if base PDF exists
            try {
              await downloadFile(baseKey);
            } catch {
              // No base PDF exists, skip versioning
              res.json({ success: true, message: 'Corrección guardada exitosamente' });
              return;
            }

            // Count total corrections for version number
            const countResult = await query<{ count: string }>(
              'SELECT COUNT(*) as count FROM correcciones_solicitud WHERE solicitud_pago_id = $1',
              [id],
            );
            const version = parseInt(countResult.rows[0].count) + 1;

            const pdfBuffer = await generateFullPDF(parseInt(id));
            const versionKey = `${nombreCorto}/solicitudes/${numero}-v${version}.pdf`;
            await uploadFile(versionKey, pdfBuffer, 'application/pdf');

            // Update the correction record with the PDF key
            await query(
              `UPDATE correcciones_solicitud SET version_pdf = $1
               WHERE id = (
                 SELECT id FROM correcciones_solicitud
                 WHERE solicitud_pago_id = $2 AND version_pdf IS NULL
                 ORDER BY created_at DESC LIMIT 1
               )`,
              [versionKey, id],
            );
          } catch (pdfErr) {
            console.error('Error generating versioned PDF:', pdfErr);
            // Don't fail the whole correction — data is already saved
          }
        }

        res.json({ success: true, message: 'Corrección guardada exitosamente' });
      } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error en corrección de solicitud:', err);
        throw err;
      } finally {
        client.release();
      }
    },
  ),
);

// --- POST /:id/registrar-pago — Registrar pago con comprobante ---
router.post(
  '/:id/registrar-pago',
  [param('id').isInt()],
  checkPermission('registrar_pago'),
  (req: Request, res: Response, next: NextFunction) => {
    comprobanteUpload.array('archivos', 5)(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          res.status(400).json({
            success: false,
            message: 'El archivo excede el limite de 10MB',
          });
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
  },
  asyncHandler(
    async (req: Request<{ id: string }>, res: Response): Promise<void> => {
      const { id } = req.params;
      const { fecha_pago } = req.body;
      const files = req.files as Express.Multer.File[];
      const userId = req.user!.id;

      if (!fecha_pago) {
        res
          .status(400)
          .json({ success: false, message: 'La fecha de pago es obligatoria' });
        return;
      }

      if (!files || files.length === 0) {
        res.status(400).json({
          success: false,
          message: 'Debe adjuntar al menos un comprobante',
        });
        return;
      }

      // Verificar que la solicitud existe y está aprobada
      const solicitud = await query<SolicitudRow & { nombre_corto: string }>(
        `SELECT sp.id, sp.numero, sp.estado, COALESCE(p.nombre_corto, p.nombre) as nombre_corto
         FROM solicitudes_pago sp
         LEFT JOIN proyectos p ON sp.proyecto_id = p.id
         WHERE sp.id = $1`,
        [id],
      );
      if (solicitud.rows.length === 0) {
        res
          .status(404)
          .json({ success: false, message: 'Solicitud no encontrada' });
        return;
      }
      if (solicitud.rows[0].estado !== 'aprobada') {
        res.status(400).json({
          success: false,
          message: 'Solo se puede registrar pago de solicitudes aprobadas',
        });
        return;
      }

      // Crear comprobante
      await query(
        'INSERT INTO comprobantes_pago (solicitud_pago_id, fecha_pago, registrado_por) VALUES ($1, $2, $3)',
        [id, fecha_pago, userId],
      );

      // Upload archivos a R2 y registrar en adjuntos
      const archivosInfo: string[] = [];
      for (const file of files) {
        const uuid = crypto.randomUUID();
        const safeName = sanitizeFilename(file.originalname);
        const r2Key = `solicitudes-pago/${id}/comprobantes/${uuid}_${safeName}`;

        await uploadFile(r2Key, file.buffer, file.mimetype);

        await query(
          `
      INSERT INTO solicitud_pago_adjuntos (solicitud_pago_id, nombre_original, r2_key, tipo_mime, tamano, subido_por, tipo_adjunto)
      VALUES ($1, $2, $3, $4, $5, $6, 'comprobante')
    `,
          [id, file.originalname, r2Key, file.mimetype, file.size, userId],
        );

        archivosInfo.push(file.originalname);
      }

      // Cambiar estado a pagada
      await query(
        'UPDATE solicitudes_pago SET estado = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        ['pagada', id],
      );

      // Archive immutable PDF copy to R2
      try {
        const pdfBuffer = await generateFullPDF(parseInt(id));
        const nombreCorto = solicitud.rows[0].nombre_corto;
        const numero = solicitud.rows[0].numero;
        const archiveKey = `${nombreCorto}/solicitudes/${numero}.pdf`;
        await uploadFile(archiveKey, pdfBuffer, 'application/pdf');
      } catch (archiveErr) {
        // Rollback estado change if archive fails
        await query(
          'UPDATE solicitudes_pago SET estado = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
          ['aprobada', id],
        );
        console.error('Error archiving PDF at pagada:', archiveErr);
        res.status(500).json({
          success: false,
          message: 'Error al guardar copia del PDF. Intente nuevamente.',
        });
        return;
      }

      await registrarAudit(
        userId,
        'registrar_pago',
        'solicitud_pago',
        parseInt(id),
        {
          numero: solicitud.rows[0].numero,
          fecha_pago,
          archivos: archivosInfo,
        },
      );

      res.json({ success: true, message: 'Pago registrado exitosamente' });
    },
  ),
);

// --- POST /:id/registrar-factura — Registrar factura de proveedor ---
router.post(
  '/:id/registrar-factura',
  [param('id').isInt()],
  checkPermission('registrar_pago'),
  (req: Request, res: Response, next: NextFunction) => {
    comprobanteUpload.array('archivos', 5)(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          res.status(400).json({
            success: false,
            message: 'El archivo excede el limite de 10MB',
          });
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
  },
  asyncHandler(
    async (req: Request<{ id: string }>, res: Response): Promise<void> => {
      const { id } = req.params;
      const { fecha_factura, numero_factura, tipo } = req.body;
      const tipoDoc = tipo === 'recibo' ? 'recibo' : 'factura';
      const files = req.files as Express.Multer.File[];
      const userId = req.user!.id;

      if (!fecha_factura) {
        res.status(400).json({
          success: false,
          message: `La fecha es obligatoria`,
        });
        return;
      }

      if (!files || files.length === 0) {
        res.status(400).json({
          success: false,
          message: `Debe adjuntar al menos un archivo`,
        });
        return;
      }

      // Verificar que la solicitud existe y está pagada
      const solicitud = await query<SolicitudRow & { nombre_corto: string }>(
        `SELECT sp.id, sp.numero, sp.estado, COALESCE(p.nombre_corto, p.nombre) as nombre_corto
         FROM solicitudes_pago sp
         LEFT JOIN proyectos p ON sp.proyecto_id = p.id
         WHERE sp.id = $1`,
        [id],
      );
      if (solicitud.rows.length === 0) {
        res
          .status(404)
          .json({ success: false, message: 'Solicitud no encontrada' });
        return;
      }
      if (solicitud.rows[0].estado !== 'pagada') {
        res.status(400).json({
          success: false,
          message: 'Solo se puede registrar factura de solicitudes pagadas',
        });
        return;
      }

      // Crear registro de factura/recibo
      await query(
        'INSERT INTO facturas_solicitud (solicitud_pago_id, fecha_factura, numero_factura, registrado_por, tipo) VALUES ($1, $2, $3, $4, $5)',
        [id, fecha_factura, numero_factura || null, userId, tipoDoc],
      );

      // Upload archivos a R2 y registrar en adjuntos
      const archivosInfo: string[] = [];
      for (const file of files) {
        const uuid = crypto.randomUUID();
        const safeName = sanitizeFilename(file.originalname);
        const r2Key = `solicitudes-pago/${id}/facturas/${uuid}_${safeName}`;

        await uploadFile(r2Key, file.buffer, file.mimetype);

        await query(
          `
      INSERT INTO solicitud_pago_adjuntos (solicitud_pago_id, nombre_original, r2_key, tipo_mime, tamano, subido_por, tipo_adjunto)
      VALUES ($1, $2, $3, $4, $5, $6, 'factura')
    `,
          [id, file.originalname, r2Key, file.mimetype, file.size, userId],
        );

        archivosInfo.push(file.originalname);
      }

      // Cambiar estado a facturada
      await query(
        'UPDATE solicitudes_pago SET estado = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        ['facturada', id],
      );

      // Archive immutable copy of factura file to project folder
      try {
        const nombreCorto = solicitud.rows[0].nombre_corto;
        const numero = solicitud.rows[0].numero;
        const firstFile = files[0];
        const archiveKey = `${nombreCorto}/solicitudes/${numero}-factura.pdf`;
        await uploadFile(archiveKey, firstFile.buffer, firstFile.mimetype);
      } catch (archiveErr) {
        console.error('Error archiving factura file:', archiveErr);
      }

      await registrarAudit(
        userId,
        'registrar_factura',
        'solicitud_pago',
        parseInt(id),
        {
          numero: solicitud.rows[0].numero,
          tipo: tipoDoc,
          fecha_factura,
          numero_factura: numero_factura || null,
          archivos: archivosInfo,
        },
      );

      res.json({ success: true, message: 'Factura registrada exitosamente' });
    },
  ),
);

// --- POST /aprobar-masivo — Aprobación masiva con verificación de contraseña ---
router.post(
  '/aprobar-masivo',
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const { ids, password } = req.body;
    const userId = req.user!.id;

    if (!Array.isArray(ids) || ids.length === 0) {
      res
        .status(400)
        .json({ success: false, message: 'Se requiere un array de IDs' });
      return;
    }

    if (!password) {
      res
        .status(400)
        .json({ success: false, message: 'Se requiere la contraseña' });
      return;
    }

    // Verificar contraseña
    const userResult = await query<{ password: string }>(
      'SELECT password FROM users WHERE id = $1',
      [userId],
    );
    if (userResult.rows.length === 0) {
      res
        .status(401)
        .json({ success: false, message: 'Usuario no encontrado' });
      return;
    }

    const isValidPassword = await bcrypt.compare(
      password,
      userResult.rows[0].password,
    );
    if (!isValidPassword) {
      res
        .status(401)
        .json({ success: false, message: 'Contraseña incorrecta' });
      return;
    }

    const resultados: { id: number; aprobada: boolean; error?: string }[] = [];

    for (const solicitudId of ids) {
      try {
        const solicitud = await query<SolicitudRow>(
          'SELECT * FROM solicitudes_pago WHERE id = $1',
          [solicitudId],
        );
        if (solicitud.rows.length === 0) {
          resultados.push({
            id: solicitudId,
            aprobada: false,
            error: 'No encontrada',
          });
          continue;
        }

        if (solicitud.rows[0].estado !== 'pendiente') {
          resultados.push({
            id: solicitudId,
            aprobada: false,
            error: 'No está pendiente',
          });
          continue;
        }

        // Verificar revisada
        const revision = await query(
          'SELECT id FROM solicitud_revisiones WHERE solicitud_pago_id = $1 AND user_id = $2',
          [solicitudId, userId],
        );
        if (revision.rows.length === 0) {
          resultados.push({
            id: solicitudId,
            aprobada: false,
            error: 'No está revisada',
          });
          continue;
        }

        // Verificar turno
        const aprobadores = await query<{ user_id: number; orden: number }>(
          'SELECT user_id, orden FROM project_approval_settings WHERE proyecto_id = $1 AND activo = true ORDER BY orden',
          [solicitud.rows[0].proyecto_id],
        );
        const aprobaciones = await query<{ user_id: number }>(
          'SELECT user_id FROM solicitud_aprobaciones WHERE solicitud_pago_id = $1 ORDER BY orden',
          [solicitudId],
        );
        const aprobacionesHechas = aprobaciones.rows.length;
        const siguienteAprobador = aprobadores.rows[aprobacionesHechas];

        if (!siguienteAprobador || siguienteAprobador.user_id !== userId) {
          resultados.push({
            id: solicitudId,
            aprobada: false,
            error: 'No es tu turno',
          });
          continue;
        }

        // Aprobar
        await query(
          "INSERT INTO solicitud_aprobaciones (solicitud_pago_id, user_id, orden, accion) VALUES ($1, $2, $3, 'aprobado')",
          [solicitudId, userId, siguienteAprobador.orden],
        );

        if (aprobacionesHechas + 1 >= aprobadores.rows.length) {
          await query(
            'UPDATE solicitudes_pago SET estado = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
            ['aprobada', solicitudId],
          );
        }

        // Limpiar revisión
        await query(
          'DELETE FROM solicitud_revisiones WHERE solicitud_pago_id = $1 AND user_id = $2',
          [solicitudId, userId],
        );

        resultados.push({ id: solicitudId, aprobada: true });
      } catch (err) {
        console.error(`Error aprobando solicitud ${solicitudId}:`, err);
        resultados.push({
          id: solicitudId,
          aprobada: false,
          error: 'Error interno',
        });
      }
    }

    const aprobadas = resultados.filter((r) => r.aprobada).length;
    res.json({
      success: true,
      message: `${aprobadas} de ${ids.length} solicitudes aprobadas`,
      aprobadas,
      total: ids.length,
      resultados,
    });
  }),
);

// --- POST /:id/aprobar — Aprobar solicitud ---
router.post(
  '/:id/aprobar',
  [param('id').isInt()],
  asyncHandler(
    async (req: Request<{ id: string }>, res: Response): Promise<void> => {
      const { id } = req.params;
      const userId = req.user!.id;
      const { password } = req.body;

      // Verificar contraseña
      if (!password) {
        res.status(400).json({
          success: false,
          message: 'Se requiere contraseña para aprobar',
        });
        return;
      }
      const userResult = await query<{ password: string }>(
        'SELECT password FROM users WHERE id = $1',
        [userId],
      );
      if (userResult.rows.length === 0) {
        res
          .status(404)
          .json({ success: false, message: 'Usuario no encontrado' });
        return;
      }
      const isValidPassword = await bcrypt.compare(
        password,
        userResult.rows[0].password,
      );
      if (!isValidPassword) {
        res
          .status(401)
          .json({ success: false, message: 'Contraseña incorrecta' });
        return;
      }

      // Obtener la solicitud
      const solicitud = await query<SolicitudRow>(
        'SELECT * FROM solicitudes_pago WHERE id = $1',
        [id],
      );
      if (solicitud.rows.length === 0) {
        res
          .status(404)
          .json({ success: false, message: 'Solicitud no encontrada' });
        return;
      }

      if (solicitud.rows[0].estado !== 'pendiente') {
        res.status(400).json({
          success: false,
          message: 'Solo se pueden aprobar solicitudes en estado pendiente',
        });
        return;
      }

      // Obtener aprobadores del proyecto
      const aprobadores = await query<{ user_id: number; orden: number }>(
        'SELECT user_id, orden FROM project_approval_settings WHERE proyecto_id = $1 AND activo = true ORDER BY orden',
        [solicitud.rows[0].proyecto_id],
      );

      // Obtener aprobaciones existentes
      const aprobaciones = await query<{ user_id: number; orden: number }>(
        'SELECT user_id, orden FROM solicitud_aprobaciones WHERE solicitud_pago_id = $1 ORDER BY orden',
        [id],
      );

      // Determinar cuál es el turno actual
      const aprobacionesHechas = aprobaciones.rows.length;
      const siguienteAprobador = aprobadores.rows[aprobacionesHechas];

      if (!siguienteAprobador || siguienteAprobador.user_id !== userId) {
        res.status(403).json({
          success: false,
          message: 'No es tu turno de aprobar esta solicitud',
        });
        return;
      }

      // Registrar aprobación
      await query(
        `
    INSERT INTO solicitud_aprobaciones (solicitud_pago_id, user_id, orden, accion)
    VALUES ($1, $2, $3, 'aprobado')
  `,
        [id, userId, siguienteAprobador.orden],
      );

      // Si es el último aprobador, cambiar estado a aprobada
      const esUltimoAprobador =
        aprobacionesHechas + 1 >= aprobadores.rows.length;
      if (esUltimoAprobador) {
        await query(
          'UPDATE solicitudes_pago SET estado = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
          ['aprobada', id],
        );
      }

      res.json({ success: true, message: 'Solicitud aprobada' });

      // Notificar al siguiente aprobador si es urgente y quedan aprobadores (fire and forget)
      if (solicitud.rows[0].urgente && !esUltimoAprobador) {
        (async () => {
          try {
            // Buscar el siguiente aprobador (el que sigue después del actual)
            const nextAprobador = await query<{
              nombre: string;
              email: string;
            }>(
              `SELECT u.nombre, u.email FROM project_approval_settings pas
           JOIN users u ON u.id = pas.user_id
           WHERE pas.proyecto_id = $1 AND pas.activo = true AND pas.orden > $2
           ORDER BY pas.orden ASC LIMIT 1`,
              [solicitud.rows[0].proyecto_id, siguienteAprobador.orden],
            );
            if (nextAprobador.rows.length === 0 || !nextAprobador.rows[0].email)
              return;

            const proyectoResult = await query<{ nombre_corto: string }>(
              'SELECT nombre_corto FROM proyectos WHERE id = $1',
              [solicitud.rows[0].proyecto_id],
            );
            const nombreProyecto =
              proyectoResult.rows[0]?.nombre_corto || 'Proyecto';
            const sol = solicitud.rows[0];
            const { nombre: nextNombre, email: nextEmail } =
              nextAprobador.rows[0];

            await sendEmail(
              nextEmail,
              `⚠️ Solicitud Urgente: ${sol.numero} - ${sol.proveedor}`,
              `<div style="font-family: Arial, sans-serif; max-width: 600px;">
            <h2 style="color: #d97706;">⚠️ Solicitud de Pago Urgente</h2>
            <p>Hola ${nextNombre},</p>
            <p>Hay una solicitud de pago <strong>urgente</strong> pendiente de tu aprobación:</p>
            <table style="border-collapse: collapse; width: 100%; margin: 16px 0;">
              <tr><td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Número</td><td style="padding: 8px; border: 1px solid #ddd;">${sol.numero}</td></tr>
              <tr><td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Proveedor</td><td style="padding: 8px; border: 1px solid #ddd;">${sol.proveedor}</td></tr>
              <tr><td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Monto Total</td><td style="padding: 8px; border: 1px solid #ddd;">$${parseFloat(sol.monto_total as unknown as string).toFixed(2)}</td></tr>
              <tr><td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Proyecto</td><td style="padding: 8px; border: 1px solid #ddd;">${nombreProyecto}</td></tr>
            </table>
            <p><a href="https://sistema.pinellaspanama.com" style="background: #d97706; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px;">Ir al Sistema</a></p>
          </div>`,
            );
          } catch (err) {
            console.error(
              'Error enviando email de solicitud urgente al siguiente aprobador:',
              err,
            );
          }
        })();
      }
    },
  ),
);

// --- POST /:id/rechazar — Rechazar solicitud ---
router.post(
  '/:id/rechazar',
  [
    param('id').isInt(),
    body('comentario')
      .trim()
      .notEmpty()
      .withMessage('El comentario es obligatorio al rechazar'),
  ],
  asyncHandler(
    async (req: Request<{ id: string }>, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({
          success: false,
          message: 'El comentario es obligatorio al rechazar',
          errors: errors.array(),
        });
        return;
      }

      const { id } = req.params;
      const { comentario } = req.body;
      const userId = req.user!.id;

      // Obtener la solicitud
      const solicitud = await query<SolicitudRow>(
        'SELECT * FROM solicitudes_pago WHERE id = $1',
        [id],
      );
      if (solicitud.rows.length === 0) {
        res
          .status(404)
          .json({ success: false, message: 'Solicitud no encontrada' });
        return;
      }

      if (solicitud.rows[0].estado !== 'pendiente') {
        res.status(400).json({
          success: false,
          message: 'Solo se pueden rechazar solicitudes en estado pendiente',
        });
        return;
      }

      // Obtener aprobadores del proyecto
      const aprobadores = await query<{ user_id: number; orden: number }>(
        'SELECT user_id, orden FROM project_approval_settings WHERE proyecto_id = $1 AND activo = true ORDER BY orden',
        [solicitud.rows[0].proyecto_id],
      );

      // Obtener aprobaciones existentes
      const aprobaciones = await query<{ user_id: number; orden: number }>(
        'SELECT user_id, orden FROM solicitud_aprobaciones WHERE solicitud_pago_id = $1 ORDER BY orden',
        [id],
      );

      // Determinar cuál es el turno actual
      const aprobacionesHechas = aprobaciones.rows.length;
      const siguienteAprobador = aprobadores.rows[aprobacionesHechas];

      if (!siguienteAprobador || siguienteAprobador.user_id !== userId) {
        res.status(403).json({
          success: false,
          message: 'No es tu turno de aprobar/rechazar esta solicitud',
        });
        return;
      }

      // Registrar rechazo
      await query(
        `
    INSERT INTO solicitud_aprobaciones (solicitud_pago_id, user_id, orden, accion, comentario)
    VALUES ($1, $2, $3, 'rechazado', $4)
  `,
        [id, userId, siguienteAprobador.orden, comentario],
      );

      // Cambiar estado a rechazada
      await query(
        'UPDATE solicitudes_pago SET estado = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        ['rechazada', id],
      );

      res.json({ success: true, message: 'Solicitud rechazada' });
    },
  ),
);

// --- POST /:id/revisar — Marcar como revisada ---
router.post(
  '/:id/revisar',
  [param('id').isInt()],
  asyncHandler(
    async (req: Request<{ id: string }>, res: Response): Promise<void> => {
      const { id } = req.params;
      const userId = req.user!.id;

      const solicitud = await query<SolicitudRow>(
        'SELECT * FROM solicitudes_pago WHERE id = $1',
        [id],
      );
      if (solicitud.rows.length === 0) {
        res
          .status(404)
          .json({ success: false, message: 'Solicitud no encontrada' });
        return;
      }

      if (solicitud.rows[0].estado !== 'pendiente') {
        res.status(400).json({
          success: false,
          message: 'Solo se pueden revisar solicitudes pendientes',
        });
        return;
      }

      // Verificar turno
      const aprobadores = await query<{ user_id: number; orden: number }>(
        'SELECT user_id, orden FROM project_approval_settings WHERE proyecto_id = $1 AND activo = true ORDER BY orden',
        [solicitud.rows[0].proyecto_id],
      );
      const aprobaciones = await query<{ user_id: number }>(
        'SELECT user_id FROM solicitud_aprobaciones WHERE solicitud_pago_id = $1 ORDER BY orden',
        [id],
      );
      const siguienteAprobador = aprobadores.rows[aprobaciones.rows.length];
      if (!siguienteAprobador || siguienteAprobador.user_id !== userId) {
        res.status(403).json({
          success: false,
          message: 'No es tu turno de revisar esta solicitud',
        });
        return;
      }

      await query(
        'INSERT INTO solicitud_revisiones (solicitud_pago_id, user_id) VALUES ($1, $2) ON CONFLICT (solicitud_pago_id, user_id) DO NOTHING',
        [id, userId],
      );

      res.json({ success: true, message: 'Solicitud marcada como revisada' });
    },
  ),
);

// --- DELETE /:id/revisar — Desmarcar revisión ---
router.delete(
  '/:id/revisar',
  [param('id').isInt()],
  asyncHandler(
    async (req: Request<{ id: string }>, res: Response): Promise<void> => {
      const { id } = req.params;
      const userId = req.user!.id;

      await query(
        'DELETE FROM solicitud_revisiones WHERE solicitud_pago_id = $1 AND user_id = $2',
        [id, userId],
      );

      res.json({ success: true, message: 'Revisión desmarcada' });
    },
  ),
);

// --- POST /:id/reembolso — Registrar reembolso a Pinellas con comprobante ---
router.post(
  '/:id/reembolso',
  [param('id').isInt()],
  checkPermission('registrar_pago'),
  (req: Request, res: Response, next: NextFunction) => {
    comprobanteUpload.single('comprobante')(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          res.status(400).json({
            success: false,
            message: 'El archivo excede el límite de 10MB',
          });
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
  },
  asyncHandler(
    async (req: Request<{ id: string }>, res: Response): Promise<void> => {
      const { id } = req.params;
      const userId = req.user!.id;
      const { fecha_reembolso } = req.body;

      // Verificar que la solicitud existe y tiene pinellas_paga
      const solicitud = await query<SolicitudRow>(
        'SELECT id, pinellas_paga, numero FROM solicitudes_pago WHERE id = $1',
        [id],
      );
      if (solicitud.rows.length === 0) {
        res
          .status(404)
          .json({ success: false, message: 'Solicitud no encontrada' });
        return;
      }
      if (!solicitud.rows[0].pinellas_paga) {
        res.status(400).json({
          success: false,
          message: 'Esta solicitud no está marcada como "Pinellas paga"',
        });
        return;
      }

      // Verificar que no tenga ya un reembolso
      const existing = await query(
        'SELECT id FROM reembolsos_pinellas WHERE solicitud_id = $1',
        [id],
      );
      if (existing.rows.length > 0) {
        res.status(400).json({
          success: false,
          message: 'Esta solicitud ya tiene un reembolso registrado',
        });
        return;
      }

      // Comprobante es requerido
      const file = req.file;
      if (!file) {
        res.status(400).json({
          success: false,
          message: 'El comprobante de reembolso es requerido',
        });
        return;
      }

      let comprobanteUrl: string | null = null;
      let comprobanteNombre: string | null = null;

      // Upload comprobante a R2
      if (file) {
        const uuid = crypto.randomUUID();
        const safeName = sanitizeFilename(file.originalname);
        const r2Key = `reembolsos/${id}/${uuid}_${safeName}`;

        await uploadFile(r2Key, file.buffer, file.mimetype);
        comprobanteUrl = r2Key;
        comprobanteNombre = file.originalname;
      }

      await query(
        `
    INSERT INTO reembolsos_pinellas (solicitud_id, comprobante_url, comprobante_nombre, fecha_reembolso, registrado_por)
    VALUES ($1, $2, $3, $4, $5)
  `,
        [
          id,
          comprobanteUrl,
          comprobanteNombre,
          fecha_reembolso || new Date().toISOString().split('T')[0],
          userId,
        ],
      );

      await registrarAudit(
        userId,
        'registrar_reembolso',
        'solicitud_pago',
        parseInt(id),
        { numero: solicitud.rows[0].numero },
      );

      res.json({ success: true, message: 'Reembolso registrado' });
    },
  ),
);

// --- POST /:id/devolucion — Registrar devolución total ---
router.post(
  '/:id/devolucion',
  [param('id').isInt()],
  checkPermission('registrar_pago'),
  (req: Request, res: Response, next: NextFunction) => {
    comprobanteUpload.single('comprobante')(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          res.status(400).json({
            success: false,
            message: 'El archivo excede el límite de 10MB',
          });
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
  },
  asyncHandler(
    async (req: Request<{ id: string }>, res: Response): Promise<void> => {
      const { id } = req.params;
      const userId = req.user!.id;
      const { fecha_devolucion, motivo } = req.body;

      if (!fecha_devolucion) {
        res.status(400).json({
          success: false,
          message: 'La fecha de devolución es obligatoria',
        });
        return;
      }

      if (!motivo || !motivo.trim()) {
        res.status(400).json({
          success: false,
          message: 'El motivo de la devolución es obligatorio',
        });
        return;
      }

      const file = req.file;
      if (!file) {
        res.status(400).json({
          success: false,
          message: 'El comprobante de devolución es requerido',
        });
        return;
      }

      // Verificar solicitud existe y estado válido
      const solicitud = await query<SolicitudRow & { nombre_corto: string }>(
        `SELECT sp.id, sp.numero, sp.estado, COALESCE(p.nombre_corto, p.nombre) as nombre_corto
         FROM solicitudes_pago sp
         LEFT JOIN proyectos p ON sp.proyecto_id = p.id
         WHERE sp.id = $1`,
        [id],
      );
      if (solicitud.rows.length === 0) {
        res
          .status(404)
          .json({ success: false, message: 'Solicitud no encontrada' });
        return;
      }
      if (
        solicitud.rows[0].estado !== 'pagada' &&
        solicitud.rows[0].estado !== 'facturada'
      ) {
        res.status(400).json({
          success: false,
          message:
            'Solo se puede registrar devolución en solicitudes pagadas o facturadas',
        });
        return;
      }

      // Verificar que no tenga ya una devolución
      const existing = await query(
        'SELECT id FROM devoluciones_solicitud WHERE solicitud_id = $1',
        [id],
      );
      if (existing.rows.length > 0) {
        res.status(400).json({
          success: false,
          message: 'Esta solicitud ya tiene una devolución registrada',
        });
        return;
      }

      // Upload comprobante a R2
      const uuid = crypto.randomUUID();
      const safeName = sanitizeFilename(file.originalname);
      const r2Key = `devoluciones/${id}/${uuid}_${safeName}`;
      await uploadFile(r2Key, file.buffer, file.mimetype);

      // Insertar registro
      await query(
        `INSERT INTO devoluciones_solicitud (solicitud_id, fecha_devolucion, motivo, comprobante_url, comprobante_nombre, registrado_por)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, fecha_devolucion, motivo.trim(), r2Key, file.originalname, userId],
      );

      // Cambiar estado a devolucion
      await query(
        'UPDATE solicitudes_pago SET estado = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        ['devolucion', id],
      );

      // Archive immutable copy of devolucion comprobante to project folder
      try {
        const nombreCorto = solicitud.rows[0].nombre_corto;
        const numero = solicitud.rows[0].numero;
        const archiveKey = `${nombreCorto}/solicitudes/${numero}-devolucion.pdf`;
        await uploadFile(archiveKey, file.buffer, file.mimetype);
      } catch (archiveErr) {
        console.error('Error archiving devolucion file:', archiveErr);
      }

      await registrarAudit(
        userId,
        'registrar_devolucion',
        'solicitud_pago',
        parseInt(id),
        {
          numero: solicitud.rows[0].numero,
          motivo: motivo.trim(),
          fecha_devolucion,
        },
      );

      res.json({ success: true, message: 'Devolución registrada' });
    },
  ),
);

// --- GET /:id/devolucion/comprobante — Download devolucion comprobante ---
router.get(
  '/:id/devolucion/comprobante',
  [param('id').isInt()],
  asyncHandler(
    async (req: Request<{ id: string }>, res: Response): Promise<void> => {
      const { id } = req.params;
      const result = await query<{ comprobante_url: string }>(
        'SELECT comprobante_url FROM devoluciones_solicitud WHERE solicitud_id = $1',
        [id],
      );
      if (result.rows.length === 0) {
        res
          .status(404)
          .json({ success: false, message: 'Devolución no encontrada' });
        return;
      }
      const url = await getFileSignedUrl(result.rows[0].comprobante_url);
      res.json({ success: true, url });
    },
  ),
);

// --- DELETE /:id — Eliminar solicitud ---
// Admin: puede eliminar cualquier solicitud sin importar estado
// Usuario normal: solo puede eliminar solicitudes pendientes propias (o con permiso solicitudes_editar_todas)
router.delete(
  '/:id',
  [param('id').isInt()],
  asyncHandler(
    async (req: Request<{ id: string }>, res: Response): Promise<void> => {
      const { id } = req.params;
      const isAdmin = req.user?.rol === 'admin';
      const isCoAdmin = req.user?.rol === 'co-admin';

      const existing = await query<SolicitudRow & { preparado_por: number; proyecto_id: number }>(
        'SELECT id, numero, estado, preparado_por, proyecto_id FROM solicitudes_pago WHERE id = $1',
        [id],
      );
      if (existing.rows.length === 0) {
        res
          .status(404)
          .json({ success: false, message: 'Solicitud no encontrada' });
        return;
      }

      // Block deletion of pagada/facturada unless it's the test project
      const testProjectId = process.env.TEST_PROJECT_ID
        ? parseInt(process.env.TEST_PROJECT_ID)
        : null;
      const sol = existing.rows[0];
      if (
        isAdmin &&
        (sol.estado === 'pagada' || sol.estado === 'facturada' || sol.estado === 'devolucion') &&
        sol.proyecto_id !== testProjectId
      ) {
        res.status(400).json({
          success: false,
          message:
            'No se pueden eliminar solicitudes pagadas, facturadas o en devolución',
        });
        return;
      }

      if (!isAdmin) {
        // Co-admin y usuarios normales: solo pendientes
        if (existing.rows[0].estado !== 'pendiente') {
          res.status(400).json({
            success: false,
            message: 'Solo se pueden eliminar solicitudes en estado pendiente',
          });
          return;
        }
        // Usuarios normales: verificar propiedad o permiso
        if (!isCoAdmin) {
          if (!req.user?.permissions?.solicitudes_editar_todas) {
            if (existing.rows[0].preparado_por !== req.user!.id) {
              res.status(403).json({
                success: false,
                message: 'Solo puedes eliminar tus propias solicitudes',
              });
              return;
            }
          }
        }
      }

      // Delete R2 files before deleting from DB (ON DELETE CASCADE only removes DB rows)
      const adjuntosToDelete = await query<{ r2_key: string }>(
        'SELECT r2_key FROM solicitud_pago_adjuntos WHERE solicitud_pago_id = $1',
        [id],
      );
      for (const adj of adjuntosToDelete.rows) {
        try {
          await deleteFile(adj.r2_key);
        } catch (err) {
          console.error('Error deleting R2 file:', adj.r2_key, err);
        }
      }

      // Limpiar tablas relacionadas que no tengan ON DELETE CASCADE
      await query('DELETE FROM devoluciones_solicitud WHERE solicitud_id = $1', [
        id,
      ]);
      await query('DELETE FROM reembolsos_pinellas WHERE solicitud_id = $1', [
        id,
      ]);
      await query(
        'DELETE FROM comprobantes_pago WHERE solicitud_pago_id = $1',
        [id],
      );
      await query(
        'DELETE FROM facturas_solicitud WHERE solicitud_pago_id = $1',
        [id],
      );
      await query(
        'DELETE FROM solicitud_aprobaciones WHERE solicitud_pago_id = $1',
        [id],
      );
      await query(
        'DELETE FROM solicitud_revisiones WHERE solicitud_pago_id = $1',
        [id],
      );
      await query(
        'DELETE FROM correcciones_solicitud WHERE solicitud_pago_id = $1',
        [id],
      );

      const { numero, estado } = existing.rows[0];
      await query('DELETE FROM solicitudes_pago WHERE id = $1', [id]);
      await registrarAudit(
        req.user!.id,
        'eliminar',
        'solicitud_pago',
        parseInt(id),
        { numero, estado_al_eliminar: estado },
      );

      res.json({ success: true, message: 'Solicitud eliminada' });
    },
  ),
);

export default router;
