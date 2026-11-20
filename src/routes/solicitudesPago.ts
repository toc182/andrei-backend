import { Router, Request, Response, NextFunction } from 'express';
import { body, param, validationResult } from 'express-validator';
import multer from 'multer';
import crypto from 'crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import { query, pool } from '../database/config.js';
import {
  authenticateToken,
  checkPermission,
  requireRole,
} from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import {
  downloadFile,
  uploadFile,
  getFileSignedUrl,
} from '../services/storage.js';
import { generateSolicitudPDF } from '../services/pdfGenerator.js';
import { registrarAudit } from '../services/auditLog.js';
import { sendEmail } from '../services/emailService.js';
import {
  puedeGestionarSolicitud,
  soloSolicitudVisible,
} from '../middleware/solicitudVisible.js';
import { avisarTurnoUrgente } from '../services/whatsapp/avisoUrgente.js';
import { adjuntarCompra, enlazarCompra, leerCompra } from '../services/requisicionCompras.js';
import { fixFiles } from '../utils/fileEncoding.js';
import { borrarArchivos, retirarSolicitud } from '../services/solicitudRetiro.js';
import {
  alRechazarApertura,
  cajaDeLaApertura,
  mensajeAperturaConGastos,
} from '../services/cajaApertura.js';
import {
  aCentavos,
  deCentavos,
  dineroCentavos,
  estadoSegunPagos,
  leerMonto,
  leerSaldoBloqueando,
  type EstadoPorPagos,
  type SaldoSolicitud,
} from '../services/pagosSolicitud.js';
import {
  corregirPagos,
  leerPedidoPagos,
  type CambioPago,
} from '../services/pagosCorreccion.js';
import { PDFDocument } from 'pdf-lib';
import bcrypt from 'bcryptjs';

const router = Router();

// Helper: generate full PDF (solicitud + adjuntos merged) for a given solicitud ID.
// Con `db` —el cliente de una transacción abierta— lee DENTRO de ella: al
// registrar el último pago, la copia archivada sale con ese pago y su
// comprobante, que todavía no se han guardado.
async function generateFullPDF(solicitudId: number, db?: PoolClient): Promise<Buffer> {
  const leer = <T extends QueryResultRow>(sql: string, params: unknown[]) =>
    db ? db.query<T>(sql, params) : query<T>(sql, params);
  const solicitud = await leer<SolicitudRow>(
    `
    SELECT sp.*,
      COALESCE(p.nombre_corto, p.nombre) as proyecto_nombre,
      u1.nombre as preparado_nombre,
      u2.nombre as solicitado_nombre
    FROM solicitudes_pago sp
    LEFT JOIN proyectos p ON sp.proyecto_id = p.id
    LEFT JOIN users u1 ON sp.preparado_por = u1.id
    LEFT JOIN users u2 ON sp.solicitado_por = u2.id
    WHERE sp.id = $1 AND sp.activo = true
  `,
    [solicitudId],
  );

  if (solicitud.rows.length === 0) throw new Error('Solicitud no encontrada');

  const sol = solicitud.rows[0];

  const items = await leer<ItemRow>(
    'SELECT * FROM solicitud_pago_items WHERE solicitud_pago_id = $1 ORDER BY orden, id',
    [solicitudId],
  );

  const ajustes = await leer<AjusteRow>(
    'SELECT * FROM solicitud_pago_ajustes WHERE solicitud_pago_id = $1 ORDER BY orden, id',
    [solicitudId],
  );

  const aprobaciones = await leer<{
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

  const totalAprobadoresResult = await leer<{ count: string }>(
    'SELECT COUNT(*) as count FROM proyecto_ajustes_aprobacion WHERE proyecto_id = $1 AND activo = true',
    [sol.proyecto_id],
  );
  const totalAprobadores = parseInt(totalAprobadoresResult.rows[0].count);

  const aprobadoresProyecto = await leer<{
    user_id: number;
    nombre: string;
    orden: number;
  }>(
    'SELECT pas.user_id, u.nombre, pas.orden FROM proyecto_ajustes_aprobacion pas JOIN users u ON u.id = pas.user_id WHERE pas.proyecto_id = $1 AND pas.activo = true ORDER BY pas.orden',
    [sol.proyecto_id],
  );

  // Los pagos, uno por línea, con lo pagado y el saldo de la vista
  // solicitud_pago_saldo (pagos parciales, migración 191). Los anulados no van.
  let pdfPagos:
    | {
        lista: { fecha_pago: string; monto: string; registrado_por_nombre: string }[];
        pagado: number;
        saldo: number;
      }
    | undefined;
  if (['abonada', 'pagada', 'facturada', 'devolucion'].includes(sol.estado)) {
    const pagosResult = await leer<{
      fecha_pago: string;
      monto: string;
      registrado_por_nombre: string;
    }>(
      `
      SELECT to_char(cp.fecha_pago, 'YYYY-MM-DD') AS fecha_pago, cp.monto::text,
             u.nombre as registrado_por_nombre
      FROM comprobantes_pago cp
      LEFT JOIN users u ON cp.registrado_por = u.id
      WHERE cp.solicitud_pago_id = $1 AND cp.activo
      ORDER BY cp.fecha_pago, cp.id
    `,
      [solicitudId],
    );
    const saldoResult = await leer<{ pagado: string; saldo: string }>(
      'SELECT pagado::text, saldo::text FROM solicitud_pago_saldo WHERE solicitud_pago_id = $1',
      [solicitudId],
    );
    if (pagosResult.rows.length > 0) {
      pdfPagos = {
        lista: pagosResult.rows,
        pagado: Number(saldoResult.rows[0].pagado),
        saldo: Number(saldoResult.rows[0].saldo),
      };
    }
  }

  // La factura, si tiene: también una abonada puede tenerla.
  let pdfFactura:
    | {
        fecha_factura: string;
        numero_factura?: string;
        registrado_por_nombre: string;
      }
    | undefined;
  if (['abonada', 'facturada', 'devolucion'].includes(sol.estado)) {
    const factResult = await leer<{
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
    const reembResult = await leer<{
      fecha_reembolso: string;
      registrado_por_nombre: string;
    }>(
      `
      SELECT rp.fecha_reembolso, u.nombre as registrado_por_nombre
      FROM reembolsos_pinellas rp
      LEFT JOIN users u ON rp.registrado_por = u.id
      WHERE rp.solicitud_pago_id = $1
    `,
      [solicitudId],
    );
    if (reembResult.rows.length > 0) {
      pdfReembolso = reembResult.rows[0];
    }
  }

  // Fetch correcciones
  const correccionesResult = await leer<{
    motivo: string;
    cambios: string;
    created_at: string;
    usuario_nombre: string;
  }>(
    `SELECT c.motivo, c.cambios, c.created_at, u.nombre as usuario_nombre
     FROM correcciones_solicitud c
     JOIN users u ON c.user_id = u.id
     WHERE c.solicitud_pago_id = $1
     ORDER BY c.created_at ASC`,
    [solicitudId],
  );
  const FIELD_LABELS: Record<string, string> = {
    proveedor: 'Proveedor',
    fecha: 'Fecha',
    observaciones: 'Observaciones',
    beneficiario: 'Beneficiario',
    banco: 'Banco',
    tipo_cuenta: 'Tipo de Cuenta',
    numero_cuenta: 'Número de Cuenta',
    fecha_pago: 'Fecha de Pago',
    fecha_factura: 'Fecha de Factura',
    numero_factura: 'Número de Factura',
    tipo: 'Tipo',
    subtotal: 'Subtotal',
    monto_total: 'Monto Total',
    precio_unitario: 'Precio Unitario',
    precio_total: 'Precio Total',
    cantidad: 'Cantidad',
    unidad: 'Unidad',
    descripcion: 'Descripción',
    monto: 'Monto',
    estado: 'Estado',
    comprobante: 'Comprobante',
    factura: 'Factura',
  };

  const MONEY_FIELDS = [
    'subtotal',
    'monto_total',
    'precio_unitario',
    'precio_total',
    'monto',
  ];

  function formatVal(campo: string, val: unknown): string {
    const s = String(val ?? '');
    if (!s) return '';
    if (MONEY_FIELDS.includes(campo)) {
      const n = parseFloat(s);
      if (!isNaN(n)) return n.toFixed(2);
    }
    return s;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function flattenCambio(
    ch: any,
  ): { campo: string; anterior: string; nuevo: string }[] {
    const label = (f: string) => FIELD_LABELS[f] || f;
    // Un renglón o un pago con varios campos cambiados: «Pago del 18/nov/2026 — Monto».
    if (Array.isArray(ch.cambios)) {
      return ch.cambios.map(
        (sub: { campo: string; anterior: string; nuevo: string }) => ({
          campo: `${ch.descripcion || 'Item'} — ${label(sub.campo)}`,
          anterior: formatVal(sub.campo, sub.anterior),
          nuevo: formatVal(sub.campo, sub.nuevo),
        }),
      );
    }
    if (ch.campo === 'pago_anulado') {
      return [
        {
          campo: `Pago anulado: ${ch.descripcion || ''}`,
          anterior: '',
          nuevo: '',
        },
      ];
    }
    if (ch.campo === 'item_agregado') {
      return [
        {
          campo: `Item agregado: ${ch.descripcion || ''}`,
          anterior: '',
          nuevo: '',
        },
      ];
    }
    if (ch.campo === 'item_eliminado') {
      return [
        {
          campo: `Item eliminado: ${ch.descripcion || ''}`,
          anterior: '',
          nuevo: '',
        },
      ];
    }
    return [
      {
        // El comprobante nuevo de un pago dice de qué pago es.
        campo: ch.descripcion
          ? `${ch.descripcion} — ${label(ch.campo || '')}`
          : label(ch.campo || ''),
        anterior: formatVal(ch.campo, ch.anterior),
        nuevo: formatVal(ch.campo, ch.nuevo),
      },
    ];
  }

  const pdfCorrecciones =
    correccionesResult.rows.length > 0
      ? correccionesResult.rows.map((c, i) => {
          const cambiosObj =
            typeof c.cambios === 'string' ? JSON.parse(c.cambios) : c.cambios;
          const cambiosList = Array.isArray(cambiosObj)
            ? cambiosObj
                .flatMap(flattenCambio)
                .filter((ch: { campo: string }) => ch.campo)
            : [];
          return {
            version: i + 2,
            fecha: c.created_at,
            usuario_nombre: c.usuario_nombre,
            motivo: c.motivo,
            cambios: cambiosList,
          };
        })
      : undefined;

  // Fetch devolucion
  let pdfDevolucion:
    | {
        fecha_devolucion: string;
        motivo: string;
        registrado_por_nombre: string;
      }
    | undefined;
  if (sol.estado === 'devolucion') {
    const devResult = await leer<{
      fecha_devolucion: string;
      motivo: string;
      registrado_por_nombre: string;
    }>(
      `SELECT ds.fecha_devolucion, ds.motivo, u.nombre as registrado_por_nombre
       FROM devoluciones_solicitud ds
       LEFT JOIN users u ON ds.registrado_por = u.id
       WHERE ds.solicitud_pago_id = $1`,
      [solicitudId],
    );
    if (devResult.rows.length > 0) {
      pdfDevolucion = devResult.rows[0];
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
    pagos: pdfPagos,
    factura: pdfFactura,
    codigo_verificacion: sol.codigo_verificacion,
    total_aprobadores: totalAprobadores,
    aprobadores_proyecto: aprobadoresProyecto.rows,
    reembolso: pdfReembolso,
    correcciones: pdfCorrecciones,
    devolucion: pdfDevolucion,
  });

  // Merge adjuntos into the PDF
  const adjuntos = await leer<{
    r2_key: string;
    tipo_mime: string;
    nombre_original: string;
  }>(
    // Los comprobantes de un pago anulado no van: el papel dice solo los pagos que cuentan.
    `SELECT a.r2_key, a.tipo_mime, a.nombre_original
       FROM solicitud_pago_adjuntos a
       LEFT JOIN comprobantes_pago cp ON cp.id = a.comprobante_pago_id
      WHERE a.solicitud_pago_id = $1 AND (cp.id IS NULL OR cp.activo)
      ORDER BY CASE a.tipo_adjunto WHEN 'comprobante' THEN 1 WHEN 'factura' THEN 2 ELSE 3 END, a.created_at`,
    [solicitudId],
  );

  // Also fetch devolucion comprobante if exists
  const devolucionComp = await leer<{
    comprobante_url: string;
    comprobante_nombre: string;
  }>(
    'SELECT comprobante_url, comprobante_nombre FROM devoluciones_solicitud WHERE solicitud_pago_id = $1',
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
      const devFile = await downloadFile(
        devolucionComp.rows[0].comprobante_url,
      );
      const devMime = devolucionComp.rows[0].comprobante_url.toLowerCase();
      if (devMime.endsWith('.pdf')) {
        const devPdf = await PDFDocument.load(devFile);
        const pages = await mergedPdf.copyPages(
          devPdf,
          devPdf.getPageIndices(),
        );
        for (const page of pages) {
          mergedPdf.addPage(page);
        }
      } else if (
        devMime.endsWith('.jpg') ||
        devMime.endsWith('.jpeg') ||
        devMime.endsWith('.png')
      ) {
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

type Cambio =
  | CambioSimple
  | CambioItem
  | CambioItemAgregado
  | CambioItemEliminado;

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
const NUMERIC_FIELDS = [
  'cantidad',
  'precio_unitario',
  'precio_total',
  'monto',
  'porcentaje',
  'subtotal',
  'monto_total',
];

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
  soloSolicitudVisible,
  asyncHandler(
    async (req: Request<{ id: string }>, res: Response): Promise<void> => {
      const { id } = req.params;

      const solicitud = await query<SolicitudRow>(
        'SELECT numero FROM solicitudes_pago WHERE id = $1 AND activo = true',
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

// Una solicitud pedida por su número (/:id y todo lo que cuelga de ella) solo
// si es de un proyecto que esta persona puede ver.
router.use('/:id', soloSolicitudVisible);

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
  tipo?: 'regular' | 'reembolso' | 'apertura';
  observaciones: string | null;
  beneficiario: string | null;
  banco: string | null;
  tipo_cuenta: string | null;
  numero_cuenta: string | null;
  urgente: boolean;
  pinellas_paga: boolean;
  categoria_id: number | null;
  codigo_verificacion: string;
  mensaje: string | null;
  mensaje_autor_id: number | null;
  mensaje_updated_at: Date | null;
  created_at: Date;
  updated_at: Date;
  proyecto_nombre?: string;
  preparado_nombre?: string;
  solicitado_nombre?: string;
  requisicion_numero?: string;
  categoria_nombre?: string | null;
  mensaje_autor_nombre?: string | null;
  mensaje_leido?: boolean | null;
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
  /**
   * Solo al crear, y solo cuando Compras la crea desde una requisición: las
   * líneas, la cotización a la que le compra y lo que va adjunto. Lo revisa
   * services/requisicionCompras.ts. El enlace con la requisición no se escribe
   * de ninguna otra manera, y editar la solicitud no lo toca.
   */
  desde_requisicion?: unknown;
  observaciones?: string;
  mensaje?: string | null;
  beneficiario?: string;
  banco?: string;
  tipo_cuenta?: string;
  numero_cuenta?: string;
  urgente?: boolean;
  pinellas_paga?: boolean;
  /** Categoría de gasto (categorias_gastos.id). Optional by design — see #71. */
  categoria_id?: number | null;
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

function generateCodigoVerificacion(): string {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(8);
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += chars[bytes[i] % chars.length];
  }
  return code;
}

/**
 * Generates the next solicitud numero for a given project.
 * - Regular solicitudes are numbered ET-001, ET-002, ...
 * - Reembolso solicitudes are numbered ET-001M, ET-002M, ... in their own
 *   independent sequence per project.
 *
 * Throws PREFIJO_NO_CONFIGURADO if the project has no sp_prefijo set.
 */
export async function generateNumero(
  projectId: number,
  tipo: 'regular' | 'reembolso' | 'apertura' = 'regular',
  client?: {
    query: (
      text: string,
      params?: unknown[],
    ) => Promise<{ rows: Record<string, unknown>[] }>;
  },
): Promise<string> {
  const q = client
    ? <T>(text: string, params?: unknown[]) =>
        client.query(text, params) as Promise<{ rows: T[] }>
    : <T>(text: string, params?: unknown[]) =>
        query<T & import('pg').QueryResultRow>(text, params).then((r) => r);

  const project = await q<{ sp_prefijo: string | null }>(
    'SELECT sp_prefijo FROM proyectos WHERE id = $1',
    [projectId],
  );

  if (project.rows.length === 0) throw new Error('Proyecto no encontrado');

  const prefijo = project.rows[0].sp_prefijo;
  if (!prefijo) throw new Error('PREFIJO_NO_CONFIGURADO');

  // Reembolsos: count reembolso rows only, strip the M suffix when reading the number.
  // Apertura: count apertura rows only, strip the A suffix when reading the number.
  // Regular: count regular rows only.
  let countSql: string;
  // NOTE: next-numero must include soft-deleted rows. numero is a unique
  // sequence; reusing a soft-deleted row's numero would violate the unique
  // constraint when inserting a new solicitud.
  if (tipo === 'reembolso') {
    countSql = `SELECT COALESCE(MAX(CAST(REGEXP_REPLACE(SPLIT_PART(numero, '-', 2), '[^0-9]', '', 'g') AS INTEGER)), 0)::text as total
       FROM solicitudes_pago
       WHERE proyecto_id = $1 AND tipo = 'reembolso'`;
  } else if (tipo === 'apertura') {
    countSql = `SELECT COALESCE(MAX(CAST(REGEXP_REPLACE(SPLIT_PART(numero, '-', 2), '[^0-9]', '', 'g') AS INTEGER)), 0)::text as total
       FROM solicitudes_pago
       WHERE proyecto_id = $1 AND tipo = 'apertura'`;
  } else {
    countSql = `SELECT COALESCE(MAX(CAST(SPLIT_PART(numero, '-', 2) AS INTEGER)), 0)::text as total
       FROM solicitudes_pago
       WHERE proyecto_id = $1 AND tipo = 'regular'`;
  }

  const count = await q<{ total: string }>(countSql, [projectId]);
  const nextNum = parseInt(count.rows[0].total) + 1;
  const padded = String(nextNum).padStart(3, '0');

  if (tipo === 'reembolso') return `${prefijo}-${padded}M`;
  if (tipo === 'apertura') return `${prefijo}-${padded}A`;
  return `${prefijo}-${padded}`;
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
    JOIN proyecto_ajustes_aprobacion pas ON pas.proyecto_id = sp.proyecto_id
      AND pas.user_id = $1 AND pas.activo = true
    WHERE sp.estado = 'pendiente' AND sp.activo = true
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

    if (userRol === 'usuario' && !req.user!.permissions?.acceso_global) {
      params.push(req.user!.id);
      projectFilter = ` AND sp.proyecto_id IN (SELECT proyecto_id FROM user_project_access WHERE user_id = $${params.length})`;
    }

    const result = await query(
      `
    SELECT sp.id, sp.numero, sp.proveedor, sp.monto_total, sp.estado, sp.fecha, sp.urgente,
      COALESCE(p.nombre_corto, p.nombre) as proyecto_nombre,
      CASE WHEN rp.id IS NOT NULL THEN true ELSE false END as reembolso_registrado,
      rp.fecha_reembolso, rp.comprobante_nombre
    FROM solicitudes_pago sp
    LEFT JOIN proyectos p ON sp.proyecto_id = p.id
    LEFT JOIN reembolsos_pinellas rp ON rp.solicitud_pago_id = sp.id
    WHERE sp.pinellas_paga = true AND sp.activo = true${projectFilter}
    ORDER BY rp.id IS NOT NULL ASC, sp.created_at DESC
  `,
      params,
    );

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
       FROM proyecto_ajustes_aprobacion pas
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
    query<{ solicitud_pago_id: number }>(
      `SELECT rp.solicitud_pago_id
       FROM reembolsos_pinellas rp
       WHERE rp.solicitud_pago_id = ANY($1::int[])`,
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

  // Index approvals by solicitud_pago_id + user_id
  const aprobacionesMap = new Map<string, string>();
  for (const row of aprobacionesRes.rows) {
    aprobacionesMap.set(`${row.solicitud_pago_id}-${row.user_id}`, row.accion);
  }

  // Set of solicitud IDs that have reembolso registered
  const reembolsoIds = new Set(reembolsosRes.rows.map((r) => r.solicitud_pago_id));

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
  checkPermission('solicitudes_ver'),
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const { estado, proyecto_id } = req.query;
    const currentUserId = req.user!.id;

    let whereClause = 'WHERE sp.activo = true';
    const params: unknown[] = [currentUserId];
    let paramCount = 1;

    // Filter by project access for non-admin users without acceso_global
    const userRol = req.user!.rol;
    if (userRol === 'usuario' && !req.user!.permissions?.acceso_global) {
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
        SELECT 1 FROM proyecto_ajustes_aprobacion pas
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
      u3.nombre as mensaje_autor_nombre,
      cg.nombre as categoria_nombre,
      CASE
        WHEN sp.mensaje IS NULL THEN NULL
        WHEN lec.leido_at IS NOT NULL AND lec.leido_at >= sp.mensaje_updated_at THEN true
        ELSE false
      END as mensaje_leido,
      CASE WHEN sp.estado = 'pendiente' AND EXISTS (
        SELECT 1 FROM proyecto_ajustes_aprobacion pas
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
    LEFT JOIN users u3 ON sp.mensaje_autor_id = u3.id
    LEFT JOIN categorias_gastos cg ON sp.categoria_id = cg.id
    LEFT JOIN solicitud_mensaje_lecturas lec
      ON lec.solicitud_pago_id = sp.id AND lec.user_id = $1
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
  checkPermission('solicitudes_ver'),
  asyncHandler(
    async (
      req: Request<{ projectId: string }>,
      res: Response,
    ): Promise<void> => {
      const { projectId } = req.params;
      const { estado } = req.query;
      const currentUserId = req.user!.id;

      let whereClause = 'WHERE sp.proyecto_id = $1 AND sp.activo = true';
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
        SELECT 1 FROM proyecto_ajustes_aprobacion pas
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
      u3.nombre as mensaje_autor_nombre,
      cg.nombre as categoria_nombre,
      r.numero as requisicion_numero,
      CASE
        WHEN sp.mensaje IS NULL THEN NULL
        WHEN lec.leido_at IS NOT NULL AND lec.leido_at >= sp.mensaje_updated_at THEN true
        ELSE false
      END as mensaje_leido,
      CASE WHEN sp.estado = 'pendiente' AND EXISTS (
        SELECT 1 FROM proyecto_ajustes_aprobacion pas
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
    LEFT JOIN users u3 ON sp.mensaje_autor_id = u3.id
    LEFT JOIN categorias_gastos cg ON sp.categoria_id = cg.id
    LEFT JOIN solicitud_mensaje_lecturas lec
      ON lec.solicitud_pago_id = sp.id AND lec.user_id = $2
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
      u3.nombre as mensaje_autor_nombre,
      cg.nombre as categoria_nombre,
      r.numero as requisicion_numero,
      (SELECT COUNT(*) FROM correcciones_solicitud WHERE solicitud_pago_id = sp.id) as correcciones_count,
      saldo.pagado, saldo.saldo
    FROM solicitudes_pago sp
    JOIN solicitud_pago_saldo saldo ON saldo.solicitud_pago_id = sp.id
    LEFT JOIN proyectos p ON sp.proyecto_id = p.id
    LEFT JOIN users u1 ON sp.preparado_por = u1.id
    LEFT JOIN users u2 ON sp.solicitado_por = u2.id
    LEFT JOIN users u3 ON sp.mensaje_autor_id = u3.id
    LEFT JOIN categorias_gastos cg ON sp.categoria_id = cg.id
    LEFT JOIN requisiciones r ON sp.requisicion_id = r.id
    WHERE sp.id = $1 AND sp.activo = true
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
    FROM proyecto_ajustes_aprobacion pas
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
        solicitud.rows[0].estado === 'facturada' ||
        solicitud.rows[0].estado === 'transferida'
      ) {
        const compResult = await query<{
          fecha_pago: string;
          registrado_por_nombre: string;
        }>(
          `
      SELECT cp.fecha_pago, u.nombre as registrado_por_nombre
      FROM comprobantes_pago cp
      LEFT JOIN users u ON cp.registrado_por = u.id
      WHERE cp.solicitud_pago_id = $1 AND cp.activo
      ORDER BY cp.fecha_pago DESC, cp.id DESC
    `,
          [id],
        );

        if (compResult.rows.length > 0) {
          const compAdjuntos = await query(
            `
        SELECT a.*, u.nombre as subido_por_nombre
        FROM solicitud_pago_adjuntos a
        LEFT JOIN users u ON a.subido_por = u.id
        JOIN comprobantes_pago cp ON cp.id = a.comprobante_pago_id AND cp.activo
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

      // Los pagos, uno por uno, con sus comprobantes. Van también los
      // anulados (activo = false, con quién, cuándo y por qué): quedan en el
      // historial de la solicitud.
      const pagosResult = await query<{
        id: number;
        fecha_pago: string;
        monto: string;
        activo: boolean;
        registrado_por_nombre: string | null;
        anulado_por_nombre: string | null;
        anulado_at: string | null;
        motivo_anulacion: string | null;
      }>(
        `
      SELECT cp.id, to_char(cp.fecha_pago, 'YYYY-MM-DD') AS fecha_pago, cp.monto::text, cp.activo,
             u.nombre AS registrado_por_nombre, ua.nombre AS anulado_por_nombre,
             cp.anulado_at, cp.motivo_anulacion
        FROM comprobantes_pago cp
        LEFT JOIN users u ON u.id = cp.registrado_por
        LEFT JOIN users ua ON ua.id = cp.anulado_por
       WHERE cp.solicitud_pago_id = $1
       ORDER BY cp.fecha_pago, cp.id
    `,
        [id],
      );
      const pagosAdjuntos = await query<{ comprobante_pago_id: number }>(
        `
      SELECT a.*, u.nombre as subido_por_nombre
        FROM solicitud_pago_adjuntos a
        LEFT JOIN users u ON a.subido_por = u.id
       WHERE a.solicitud_pago_id = $1 AND a.tipo_adjunto = 'comprobante'
       ORDER BY a.created_at, a.id
    `,
        [id],
      );
      const pagos = pagosResult.rows.map((p) => ({
        ...p,
        adjuntos: pagosAdjuntos.rows.filter((a) => a.comprobante_pago_id === p.id),
      }));

      // Factura: una facturada, una abonada con la factura ya subida, o una que
      // volvió a «Por pagar» porque se anularon sus pagos y conserva la factura.
      let factura = null;
      if (
        solicitud.rows[0].estado === 'facturada' ||
        solicitud.rows[0].estado === 'abonada' ||
        solicitud.rows[0].estado === 'aprobada'
      ) {
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
      WHERE rp.solicitud_pago_id = $1
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
      WHERE ds.solicitud_pago_id = $1
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
      const isCoAdmin = req.user?.rol === 'co-admin';
      const testProjectId = process.env.TEST_PROJECT_ID
        ? parseInt(process.env.TEST_PROJECT_ID)
        : null;
      const isEstadoProtegido =
        sol.estado === 'abonada' ||
        sol.estado === 'pagada' ||
        sol.estado === 'facturada' ||
        sol.estado === 'devolucion';
      const isEstadoEditable =
        sol.estado === 'pendiente' || sol.estado === 'aprobada';
      let puede_eliminar = false;
      if (sol.tipo === 'apertura') {
        // La apertura o un aumento de caja menuda nunca se elimina sola (ver DELETE /:id)
        puede_eliminar = false;
      } else if (isAdmin) {
        // Admin can delete anything except protected states outside test project
        puede_eliminar =
          !isEstadoProtegido || sol.proyecto_id === testProjectId;
      } else if (isCoAdmin) {
        // Co-admin: pendiente or aprobada, no ownership check
        puede_eliminar = isEstadoEditable;
      } else {
        // Non-admin: pendiente or aprobada (stages 1/2/3), own solicitud or solicitudes_editar_todas
        puede_eliminar =
          isEstadoEditable &&
          (sol.preparado_por === req.user?.id ||
            !!req.user?.permissions?.solicitudes_editar_todas);
      }

      // Si quien la abre ya la marco como revisada. La lista lo trae por fila;
      // una solicitud abierta desde un enlace (el WhatsApp de las urgentes) no
      // pasa por la lista y lo necesita de aqui.
      const revisada = await query(
        'SELECT 1 FROM solicitud_revisiones WHERE solicitud_pago_id = $1 AND user_id = $2',
        [id, req.user?.id],
      );

      // La apertura de una caja: la pantalla avisa antes de rechazarla (no se
      // puede si la caja tiene gastos; si no, la caja queda cancelada).
      const cajaApertura =
        sol.tipo === 'apertura' ? await cajaDeLaApertura(pool, Number(id)) : null;

      res.json({
        success: true,
        solicitud: { ...solicitud.rows[0], caja_apertura: cajaApertura },
        items: items.rows,
        ajustes: ajustes.rows,
        adjuntos: adjuntos.rows,
        aprobaciones: aprobaciones.rows,
        aprobadores_proyecto: aprobadoresProyecto.rows,
        comprobante,
        pagos,
        factura,
        reembolso,
        devolucion,
        puede_eliminar,
        revisada: revisada.rows.length > 0,
      });
    },
  ),
);

// --- POST / — Crear solicitud ---
router.post(
  '/',
  [
    body('proyecto_id').isInt().withMessage('Proyecto requerido'),
    body('solicitado_por').isInt().withMessage('Solicitante requerido'),
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
        observaciones,
        mensaje,
        beneficiario,
        banco,
        tipo_cuenta,
        numero_cuenta,
        urgente,
        pinellas_paga,
        categoria_id,
        items,
        ajustes = [],
      } = req.body;

      // Verificar que el proyecto tiene aprobadores configurados
      const approvers = await query(
        'SELECT id FROM proyecto_ajustes_aprobacion WHERE proyecto_id = $1 AND activo = true',
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

      // La que Compras crea desde una requisición: lo que escogió se revisa
      // antes de crear nada.
      const compra = await leerCompra(req, req.body.desde_requisicion, proyecto_id);
      if (compra && 'error' in compra) {
        res.status(compra.status).json({ success: false, message: compra.error, error: compra.error });
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
          numero = await generateNumero(proyecto_id, 'regular', client);
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
      pinellas_paga, codigo_verificacion, categoria_id
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pendiente', $12, $13, $14, $15, $16, $17, $18, $19, $20)
    RETURNING *
  `,
          [
            proyecto_id,
            numero,
            fecha || new Date().toISOString().split('T')[0],
            proveedor,
            req.user!.id,
            solicitado_por || null,
            compra ? compra.requisicion.id : null,
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
            categoria_id || null,
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

        // Mensaje opcional al crear: el autor queda como leído automáticamente
        const newMensaje =
          (typeof mensaje === 'string' ? mensaje.trim() : '') || null;
        if (newMensaje) {
          await client.query(
            `UPDATE solicitudes_pago
             SET mensaje = $1, mensaje_autor_id = $2, mensaje_updated_at = NOW()
             WHERE id = $3`,
            [newMensaje, req.user!.id, solicitudId],
          );
          await client.query(
            `INSERT INTO solicitud_mensaje_lecturas (solicitud_pago_id, user_id, leido_at)
             VALUES ($1, $2, NOW())
             ON CONFLICT (solicitud_pago_id, user_id) DO UPDATE SET leido_at = NOW()`,
            [solicitudId, req.user!.id],
          );
        }

        if (compra) {
          await enlazarCompra(client, compra, { tipo: 'solicitud', id: solicitudId, numero, proveedor }, req.user!.id);
        }

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      // Lo que va adjunto desde la requisición, ya con la solicitud creada: si
      // un archivo falla, ella queda y se dice cuál no se adjuntó.
      const sinAdjuntar = compra
        ? await adjuntarCompra(
          compra,
          { tipo: 'solicitud', id: result.rows[0].id, numero: result.rows[0].numero, proveedor },
          req.user!.id,
        )
        : [];

      res.status(201).json({
        success: true,
        message: 'Solicitud de pago creada',
        solicitud: result.rows[0],
        adjuntos_fallidos: sinAdjuntar,
      });

      // Y por WhatsApp, a quien le toca firmar (services/whatsapp/avisoUrgente.ts).
      if (urgente) void avisarTurnoUrgente(result.rows[0].id);

      // Notificar al primer aprobador si es urgente (fire and forget)
      if (urgente) {
        (async () => {
          try {
            const aprobadorResult = await query<{
              nombre: string;
              email: string;
            }>(
              `SELECT u.nombre, u.email FROM proyecto_ajustes_aprobacion pas
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
        'SELECT id, estado, preparado_por FROM solicitudes_pago WHERE id = $1 AND activo = true',
        [id],
      );
      if (existing.rows.length === 0) {
        res
          .status(404)
          .json({ success: false, message: 'Solicitud no encontrada' });
        return;
      }
      if (!['pendiente', 'aprobada'].includes(existing.rows[0].estado)) {
        res.status(400).json({
          success: false,
          message:
            'Solo se pueden editar solicitudes en estado pendiente o aprobada',
        });
        return;
      }

      // Edita quien la maneja: admin/co-admin, quien la preparo o quien tiene
      // «Editar todas las solicitudes».
      if (!puedeGestionarSolicitud(req.user!, existing.rows[0])) {
        res.status(403).json({
          success: false,
          message: 'Solo puedes editar tus propias solicitudes',
        });
        return;
      }

      // Verificar estado de aprobaciones — editar reinicia la cadena tanto si
      // hay aprobaciones parciales como si está totalmente aprobada
      const aprobacionesResult = await query<{ count: string }>(
        'SELECT COUNT(*) as count FROM solicitud_aprobaciones WHERE solicitud_pago_id = $1 AND accion = $2',
        [id, 'aprobado'],
      );
      const aprobacionesCount = parseInt(aprobacionesResult.rows[0].count);

      const tieneAprobaciones = aprobacionesCount > 0;

      const {
        fecha,
        proveedor,
        solicitado_por,
        observaciones,
        beneficiario,
        banco,
        tipo_cuenta,
        numero_cuenta,
        urgente,
        pinellas_paga,
        categoria_id,
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
      fecha = $1, proveedor = $2, solicitado_por = $3,
      subtotal = $4, descuentos = $5, impuestos = $6, monto_total = $7,
      observaciones = $8, beneficiario = $9, banco = $10, tipo_cuenta = $11,
      numero_cuenta = $12, urgente = $13, pinellas_paga = $14,
      categoria_id = $15, updated_at = CURRENT_TIMESTAMP
    WHERE id = $16 AND activo = true RETURNING *
  `,
        [
          fecha || new Date().toISOString().split('T')[0],
          proveedor,
          solicitado_por || null,
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
          categoria_id || null,
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

      // Si tenía aprobaciones (parciales o totales), anularlas y resetear estado
      if (tieneAprobaciones) {
        await query(
          'DELETE FROM solicitud_aprobaciones WHERE solicitud_pago_id = $1',
          [id],
        );
        await query(
          'DELETE FROM solicitud_revisiones WHERE solicitud_pago_id = $1',
          [id],
        );
        await query(
          'UPDATE solicitudes_pago SET estado = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND activo = true',
          ['pendiente', id],
        );
      }

      res.json({
        success: true,
        message: 'Solicitud actualizada',
        solicitud: result.rows[0],
        aprobaciones_anuladas: tieneAprobaciones,
      });
    },
  ),
);

// --- PUT /:id/mensaje — Editar o limpiar el mensaje corto de la solicitud ---
// Cualquier usuario autenticado puede escribir/borrar. Último que escribe gana.
// El editor queda automáticamente como "leído" para que no vea el dot en su
// propio mensaje.
router.put(
  '/:id/mensaje',
  [
    param('id').isInt(),
    body('mensaje')
      .optional({ nullable: true })
      .isString()
      .withMessage('mensaje debe ser texto')
      .isLength({ max: 1000 })
      .withMessage('Mensaje muy largo (máx. 1000 caracteres)'),
  ],
  asyncHandler(
    async (
      req: Request<{ id: string }, object, { mensaje?: string | null }>,
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
      const userId = req.user!.id;
      const { mensaje } = req.body;

      const existing = await query<{ mensaje: string | null; activo: boolean }>(
        'SELECT mensaje, activo FROM solicitudes_pago WHERE id = $1',
        [id],
      );
      if (existing.rows.length === 0 || !existing.rows[0].activo) {
        res
          .status(404)
          .json({ success: false, message: 'Solicitud no encontrada' });
        return;
      }

      const previo = existing.rows[0].mensaje;
      const newMensaje =
        (typeof mensaje === 'string' ? mensaje.trim() : '') || null;

      if (newMensaje === null) {
        await query(
          `UPDATE solicitudes_pago
           SET mensaje = NULL, mensaje_autor_id = NULL, mensaje_updated_at = NULL
           WHERE id = $1`,
          [id],
        );
      } else {
        await query(
          `UPDATE solicitudes_pago
           SET mensaje = $1, mensaje_autor_id = $2, mensaje_updated_at = NOW()
           WHERE id = $3 AND activo = true`,
          [newMensaje, userId, id],
        );
        await query(
          `INSERT INTO solicitud_mensaje_lecturas (solicitud_pago_id, user_id, leido_at)
           VALUES ($1, $2, NOW())
           ON CONFLICT (solicitud_pago_id, user_id) DO UPDATE SET leido_at = NOW()`,
          [id, userId],
        );
      }

      await registrarAudit(
        userId,
        'editar_mensaje',
        'solicitud_pago',
        parseInt(id),
        {
          length_previo: previo ? previo.length : 0,
          length_nuevo: newMensaje ? newMensaje.length : 0,
        },
      );

      const updated = await query<{
        mensaje: string | null;
        mensaje_autor_id: number | null;
        mensaje_updated_at: Date | null;
      }>(
        'SELECT mensaje, mensaje_autor_id, mensaje_updated_at FROM solicitudes_pago WHERE id = $1',
        [id],
      );
      const row = updated.rows[0];

      res.json({
        success: true,
        mensaje: row.mensaje
          ? {
              mensaje: row.mensaje,
              mensaje_autor_id: row.mensaje_autor_id,
              mensaje_autor_nombre: req.user!.nombre,
              mensaje_updated_at: row.mensaje_updated_at,
            }
          : null,
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
        'SELECT id, estado, pinellas_paga, preparado_por FROM solicitudes_pago WHERE id = $1 AND activo = true',
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
      const isAdminOrCoAdmin = userRol === 'admin' || userRol === 'co-admin';
      const isCreator = sol.preparado_por === userId;

      if (!isAdminOrCoAdmin && !isCreator) {
        res.status(403).json({
          success: false,
          message: 'No tienes permiso para cambiar este campo',
        });
        return;
      }

      // Block toggle ON once money went out without the mark (abonada too:
      // part of it was already paid by someone else)
      if (
        pinellas_paga === true &&
        !sol.pinellas_paga &&
        (sol.estado === 'abonada' || sol.estado === 'pagada' || sol.estado === 'facturada')
      ) {
        res.status(400).json({
          success: false,
          message:
            'No se puede marcar como "Pinellas paga" una solicitud que ya tiene pagos sin esta marca',
        });
        return;
      }

      await query(
        'UPDATE solicitudes_pago SET pinellas_paga = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND activo = true',
        [pinellas_paga, id],
      );

      res.json({ success: true, message: 'Campo pinellas_paga actualizado' });
    },
  ),
);

// --- PATCH /:id/categoria — Set the categoría de gasto (issue #71) ---
//
// Deliberately NOT part of the normal edit endpoint. Editing a solicitud that
// already carries approvals wipes the approval chain, and pagada/facturada
// solicitudes cannot be edited at all except through the corrección flow,
// which demands a written motivo. Neither is acceptable for classifying
// expenses after the fact, which is the whole point of the field.
//
// The categoría is not part of what is being paid — it is a label for cost
// reporting — so it can move in any estado without disturbing approvals, the
// estado, or the amounts. The change is still written to audit_log.
router.patch(
  '/:id/categoria',
  [
    param('id').isInt(),
    body('categoria_id')
      .optional({ nullable: true })
      .isInt()
      .withMessage('categoria_id debe ser un número o null'),
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
      const categoriaId: number | null = req.body.categoria_id ?? null;

      const existing = await query<
        SolicitudRow & { categoria_id: number | null }
      >(
        'SELECT id, estado, preparado_por, categoria_id FROM solicitudes_pago WHERE id = $1 AND activo = true',
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
      const isAdminOrCoAdmin =
        req.user!.rol === 'admin' || req.user!.rol === 'co-admin';

      // Same rule as editing a solicitud: admin/co-admin, whoever prepared it,
      // or a usuario granted solicitudes_editar_todas.
      if (
        !isAdminOrCoAdmin &&
        sol.preparado_por !== userId &&
        !req.user?.permissions?.solicitudes_editar_todas
      ) {
        res.status(403).json({
          success: false,
          message: 'No tienes permiso para cambiar la categoría',
        });
        return;
      }

      let categoriaNombre: string | null = null;
      if (categoriaId !== null) {
        const categoria = await query<{ id: number; nombre: string }>(
          'SELECT id, nombre FROM categorias_gastos WHERE id = $1 AND activo = true',
          [categoriaId],
        );
        if (categoria.rows.length === 0) {
          res.status(400).json({
            success: false,
            message: 'Categoría no encontrada o inactiva',
          });
          return;
        }
        categoriaNombre = categoria.rows[0].nombre;
      }

      if (sol.categoria_id === categoriaId) {
        res.json({ success: true, message: 'Categoría sin cambios' });
        return;
      }

      await query(
        'UPDATE solicitudes_pago SET categoria_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND activo = true',
        [categoriaId, id],
      );

      await registrarAudit(
        userId,
        'cambiar_categoria',
        'solicitud_pago',
        parseInt(id),
        {
          categoria_id_previa: sol.categoria_id,
          categoria_id_nueva: categoriaId,
          categoria_nueva: categoriaNombre,
          estado: sol.estado,
        },
      );

      res.json({
        success: true,
        message: 'Categoría actualizada',
        categoria_id: categoriaId,
        categoria_nombre: categoriaNombre,
      });
    },
  ),
);

// --- PATCH /:id/estado — Reenviar una solicitud rechazada ---
// Es lo unico que hace: «Reenviar para aprobacion». Antes aceptaba tambien
// 'pagada' y 'rechazada', y cualquiera con sesion podia marcar una aprobada como
// pagada sin comprobante, o rechazar una sin ser su aprobador, sin dejar rastro.
// Pagar va por /registrar-pago (comprobante y «Registrar pagos y facturas») y
// rechazar por /rechazar (el turno del aprobador), como ya hacia la pantalla.
// Reenvia quien puede editarla.
router.patch(
  '/:id/estado',
  [
    param('id').isInt(),
    body('estado')
      .equals('pendiente')
      .withMessage('Aquí solo se reenvía una solicitud rechazada'),
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

      const existing = await query<{ estado: string; tipo: string; preparado_por: number }>(
        'SELECT estado, tipo, preparado_por FROM solicitudes_pago WHERE id = $1 AND activo = true',
        [id],
      );
      if (existing.rows.length === 0) {
        res
          .status(404)
          .json({ success: false, message: 'Solicitud no encontrada' });
        return;
      }
      const actual = existing.rows[0];

      if (!puedeGestionarSolicitud(req.user!, actual)) {
        res.status(403).json({
          success: false,
          message: 'Solo quien preparó la solicitud, o quien edita todas, puede reenviarla',
        });
        return;
      }

      if (actual.estado !== 'rechazada') {
        res.status(400).json({
          success: false,
          message: 'Solo se puede reenviar una solicitud rechazada',
        });
        return;
      }

      // Las de apertura/aumento de caja menuda no se reenvian: su rechazo es
      // definitivo y revierte el monto de la caja.
      if (actual.tipo === 'apertura') {
        res.status(400).json({
          success: false,
          message:
            'Las solicitudes de apertura o aumento de caja menuda no pueden reenviarse. Cree una nueva solicitud de aumento desde la caja.',
        });
        return;
      }

      // Las firmas viejas se borran y la solicitud vuelve a empezar, junto con
      // su rastro. El UPDATE vuelve a mirar el estado: con dos clics seguidos,
      // el segundo no pasa.
      const client = await pool.connect();
      let reenviada: SolicitudRow | undefined;
      try {
        await client.query('BEGIN');
        await client.query(
          'DELETE FROM solicitud_aprobaciones WHERE solicitud_pago_id = $1',
          [id],
        );
        const result = await client.query<SolicitudRow>(
          `UPDATE solicitudes_pago SET estado = 'pendiente', updated_at = CURRENT_TIMESTAMP
            WHERE id = $1 AND activo = true AND estado = 'rechazada'
        RETURNING *`,
          [id],
        );
        reenviada = result.rows[0];
        if (!reenviada) {
          await client.query('ROLLBACK');
        } else {
          await registrarAudit(
            req.user!.id,
            'reenviar',
            'solicitud_pago',
            Number(id),
            { numero: reenviada.numero },
            client,
          );
          await client.query('COMMIT');
        }
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      if (!reenviada) {
        res.status(409).json({
          success: false,
          message: 'La solicitud cambió mientras tanto. Vuelve a abrirla.',
        });
        return;
      }

      res.json({
        success: true,
        message: 'Estado cambiado a pendiente',
        solicitud: reenviada,
      });

      // Reenviada despues de un rechazo: vuelve a empezar la cadena, y si es
      // urgente se le avisa por WhatsApp al primero.
      void avisarTurnoUrgente(Number(id));
    },
  ),
);

// --- Multer config for comprobante upload ---
const filtroComprobante: multer.Options['fileFilter'] = (_req, file, cb) => {
  const allowed = ['application/pdf', 'image/jpeg', 'image/png'];
  if (allowed.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Tipo de archivo no permitido. Solo PDF, JPG y PNG.'));
  }
};

const comprobanteUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: filtroComprobante,
});

function sanitizeFilename(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_');
}

// --- POST /:id/corregir — Modo corrección admin ---
// Un admin corrige una solicitud abonada, pagada o facturada con un motivo que
// queda en el historial: sus datos, renglones y ajustes, la factura y los pagos
// uno por uno (services/pagosCorreccion.ts). Todo va en una transacción con la
// fila bloqueada: un pago que se registra mientras tanto espera, y la ventana
// que se abrió antes de ese pago recibe 409 en vez de corregir sobre algo viejo.
const correccionUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 25 },
  fileFilter: filtroComprobante,
});

router.post(
  '/:id/corregir',
  [param('id').isInt()],
  requireRole(['admin']),
  (req: Request, res: Response, next: NextFunction) => {
    // Cada pago trae sus archivos en su propio campo (archivos_pago_<id>), por
    // eso .any(); leerPedidoPagos() rechaza cualquier campo que no conozca.
    correccionUpload.any()(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          res.status(400).json({
            success: false,
            message: 'El archivo excede el limite de 10MB',
          });
          return;
        }
        if (err.code === 'LIMIT_FILE_COUNT') {
          res.status(400).json({
            success: false,
            message: 'Una corrección lleva hasta 25 archivos',
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
      fixFiles(req);
      next();
    });
  },
  asyncHandler(
    async (req: Request<{ id: string }>, res: Response): Promise<void> => {
      const id = Number(req.params.id);
      const userId = req.user!.id;
      const { motivo, updated_at, items, ajustes, pagos, ...solicitudFields } =
        req.body;
      const files = (req.files as Express.Multer.File[] | undefined) ?? [];

      // Validate motivo
      if (!motivo || !motivo.trim()) {
        res.status(400).json({
          success: false,
          message: 'El motivo de la corrección es obligatorio',
        });
        return;
      }
      const motivoLimpio: string = motivo.trim();

      // La ventana de antes de los pagos parciales corregía «el» pago con
      // fecha_pago y archivos_comprobante. Ahora cada pago va por su cuenta;
      // una ventana vieja, abierta en otro navegador, recibe un aviso en vez de
      // cambiar un pago cualquiera.
      if (
        solicitudFields.fecha_pago !== undefined ||
        files.some((f) => f.fieldname === 'archivos_comprobante')
      ) {
        res.status(400).json({
          success: false,
          message:
            'La forma de corregir los pagos cambió. Recargue la página e intente de nuevo.',
        });
        return;
      }
      const pedidoPagos = leerPedidoPagos(pagos, files);
      if ('error' in pedidoPagos) {
        res.status(400).json({ success: false, message: pedidoPagos.error });
        return;
      }
      const facturaFiles = files.filter(
        (f) => f.fieldname === 'archivos_factura',
      );

      // Parse items and ajustes from body (sent as JSON strings in multipart)
      const parsedItems =
        typeof items === 'string' ? JSON.parse(items) : items || [];
      const parsedAjustes =
        typeof ajustes === 'string' ? JSON.parse(ajustes) : ajustes || [];

      if (!Array.isArray(parsedItems) || parsedItems.length === 0) {
        res
          .status(400)
          .json({ success: false, message: 'Debe incluir al menos un item' });
        return;
      }

      // Calculate new totals from items
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const itemsCalculados = parsedItems.map((item: any) => {
        const cantidad = parseFloat(String(item.cantidad)) || 1;
        const precioUnitario = parseFloat(String(item.precio_unitario)) || 0;
        return {
          ...item,
          cantidad,
          precio_unitario: precioUnitario,
          precio_total: cantidad * precioUnitario,
        };
      });

      const newSubtotal = itemsCalculados.reduce(
        (sum: number, item: { precio_total: number }) =>
          sum + item.precio_total,
        0,
      );

      const ajustesCalculados = parsedAjustes.map(
        (a: {
          tipo?: string;
          monto?: number;
          porcentaje?: number;
          [key: string]: unknown;
        }) => ({
          ...a,
          monto: parseFloat(String(a.monto)) || 0,
          porcentaje: a.porcentaje ? parseFloat(String(a.porcentaje)) : null,
        }),
      );

      const newImpuestos = ajustesCalculados
        .filter(
          (a: { tipo: string }) =>
            a.tipo === 'impuesto' || a.tipo === 'aumento',
        )
        .reduce((sum: number, a: { monto: number }) => sum + a.monto, 0);

      const newDescuentos = ajustesCalculados
        .filter(
          (a: { tipo: string }) =>
            a.tipo === 'descuento' || a.tipo === 'disminucion',
        )
        .reduce((sum: number, a: { monto: number }) => sum + a.monto, 0);

      // El total se guarda redondeado a centavos aquí mismo, y no por la base:
      // los pagos se cuadran contra él centavo por centavo.
      const totalNuevoCentavos = aCentavos(
        newSubtotal + newImpuestos - newDescuentos,
      );

      const solicitudDiffFields = [
        'proveedor',
        'fecha',
        'observaciones',
        'beneficiario',
        'banco',
        'tipo_cuenta',
        'numero_cuenta',
      ];

      // --- Execute transaction ---
      let clavesViejas: string[] = [];
      let resultado: {
        numero: string;
        nombreCorto: string;
        estado: EstadoPorPagos;
        pagadoCentavos: number;
        saldoCentavos: number;
      } | null = null;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const fallar = async (codigo: number, message: string) => {
          await client.query('ROLLBACK');
          res.status(codigo).json({ success: false, message });
        };

        const sol = await leerSaldoBloqueando(client, id);
        if (!sol) {
          await fallar(404, 'Solicitud no encontrada');
          return;
        }
        if (!['abonada', 'pagada', 'facturada'].includes(sol.estado)) {
          await fallar(
            400,
            'Solo se pueden corregir solicitudes abonadas, pagadas o facturadas',
          );
          return;
        }
        const current = (
          await client.query<SolicitudRow>(
            'SELECT * FROM solicitudes_pago WHERE id = $1',
            [id],
          )
        ).rows[0];

        // Optimistic lock check
        if (
          updated_at &&
          new Date(current.updated_at).getTime() !==
            new Date(updated_at).getTime()
        ) {
          await fallar(
            409,
            'La solicitud fue modificada por otro usuario. Recargue e intente de nuevo.',
          );
          return;
        }

        // Build diff for solicitud fields
        const cambios: (Cambio | CambioPago)[] = buildSolicitudDiff(
          current as unknown as Record<string, unknown>,
          solicitudFields,
          solicitudDiffFields.filter((f) => solicitudFields[f] !== undefined),
        );

        // Diff factura fields
        const currentFactura = await client.query<{
          fecha_factura: string;
          numero_factura: string;
          tipo: string;
        }>(
          "SELECT fecha_factura, numero_factura, COALESCE(tipo, 'factura') as tipo FROM facturas_solicitud WHERE solicitud_pago_id = $1",
          [id],
        );
        if (currentFactura.rows.length > 0) {
          const factFields = ['fecha_factura', 'numero_factura', 'tipo'];
          for (const f of factFields) {
            if (solicitudFields[f] !== undefined) {
              let oldVal: string;
              let newVal: string;
              if (DATE_FIELDS.includes(f)) {
                oldVal = normalizeDate(
                  currentFactura.rows[0][
                    f as keyof (typeof currentFactura.rows)[0]
                  ],
                );
                newVal = normalizeDate(solicitudFields[f]);
              } else {
                oldVal = String(
                  currentFactura.rows[0][
                    f as keyof (typeof currentFactura.rows)[0]
                  ] ?? '',
                );
                newVal = String(solicitudFields[f] ?? '');
              }
              if (oldVal !== newVal) {
                cambios.push({ campo: f, anterior: oldVal, nuevo: newVal });
              }
            }
          }
        }

        // Diff items
        const currentItems = await client.query<ItemRow>(
          'SELECT * FROM solicitud_pago_items WHERE solicitud_pago_id = $1 ORDER BY orden, id',
          [id],
        );

        const currentItemsMap = new Map(
          currentItems.rows.map((item) => [item.id, item]),
        );
        const submittedItemIds = new Set(
          parsedItems
            .filter((i: { id?: number }) => i.id)
            .map((i: { id: number }) => i.id),
        );

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
            const itemCambios: {
              campo: string;
              anterior: string;
              nuevo: string;
            }[] = [];
            const itemFields = [
              'descripcion',
              'cantidad',
              'unidad',
              'precio_unitario',
            ];
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

        if (facturaFiles.length > 0) {
          cambios.push({
            campo: 'factura',
            anterior: '(archivos anteriores)',
            nuevo: facturaFiles.map((f) => f.originalname).join(', '),
          });
        }

        // Check if totals changed and add to diff (round to 2 decimals to avoid float noise)
        const oldSubtotal =
          Math.round(parseFloat(String(current.subtotal)) * 100) / 100;
        const roundedNewSubtotal = Math.round(newSubtotal * 100) / 100;
        if (oldSubtotal !== roundedNewSubtotal) {
          cambios.push({
            campo: 'subtotal',
            anterior: String(oldSubtotal),
            nuevo: String(roundedNewSubtotal),
          });
        }
        if (sol.totalCentavos !== totalNuevoCentavos) {
          cambios.push({
            campo: 'monto_total',
            anterior: String(sol.totalCentavos / 100),
            nuevo: String(totalNuevoCentavos / 100),
          });
        }

        // Los pagos: corregidos, anulados o con comprobante nuevo, y el estado
        // que le toca a la solicitud con el total nuevo.
        const pagosCorregidos = await corregirPagos(client, {
          solicitudId: id,
          userId,
          motivo: motivoLimpio,
          sol,
          totalNuevoCentavos,
          pedido: pedidoPagos,
          subirArchivo: async (pagoId, file) => {
            const r2Key = `solicitudes-pago/${id}/comprobantes/${crypto.randomUUID()}_${sanitizeFilename(file.originalname)}`;
            await uploadFile(r2Key, file.buffer, file.mimetype);
            await client.query(
              `INSERT INTO solicitud_pago_adjuntos
                 (solicitud_pago_id, nombre_original, r2_key, tipo_mime, tamano, subido_por, tipo_adjunto, comprobante_pago_id)
               VALUES ($1, $2, $3, $4, $5, $6, 'comprobante', $7)`,
              [id, file.originalname, r2Key, file.mimetype, file.size, userId, pagoId],
            );
          },
        });
        if ('error' in pagosCorregidos) {
          await fallar(400, pagosCorregidos.error);
          return;
        }
        cambios.push(...pagosCorregidos.cambios);

        // Reject if nothing changed
        if (cambios.length === 0) {
          await fallar(400, 'No se detectaron cambios');
          return;
        }

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

        // Always update totals, estado and updated_at
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
        updateValues.push(deCentavos(totalNuevoCentavos));
        paramIndex++;
        updateFields.push(`estado = $${paramIndex}`);
        updateValues.push(pagosCorregidos.estado);
        paramIndex++;
        updateFields.push(`updated_at = CURRENT_TIMESTAMP`);

        updateValues.push(id);
        await client.query(
          `UPDATE solicitudes_pago SET ${updateFields.join(', ')} WHERE id = $${paramIndex} AND activo = true`,
          updateValues,
        );

        // Replace items
        await client.query(
          'DELETE FROM solicitud_pago_items WHERE solicitud_pago_id = $1',
          [id],
        );
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
        await client.query(
          'DELETE FROM solicitud_pago_ajustes WHERE solicitud_pago_id = $1',
          [id],
        );
        for (let i = 0; i < ajustesCalculados.length; i++) {
          const ajuste = ajustesCalculados[i];
          await client.query(
            `INSERT INTO solicitud_pago_ajustes (solicitud_pago_id, tipo, descripcion, porcentaje, monto, orden)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              id,
              ajuste.tipo,
              ajuste.descripcion,
              ajuste.porcentaje,
              ajuste.monto,
              i,
            ],
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

        // Upload replacement factura files
        clavesViejas = [...pagosCorregidos.clavesViejas];
        if (facturaFiles.length > 0) {
          const facturasViejas = await client.query<{ r2_key: string }>(
            `DELETE FROM solicitud_pago_adjuntos WHERE solicitud_pago_id = $1 AND tipo_adjunto = 'factura' RETURNING r2_key`,
            [id],
          );
          clavesViejas.push(...facturasViejas.rows.map((f) => f.r2_key));
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
        await client.query(
          `INSERT INTO correcciones_solicitud (solicitud_pago_id, user_id, motivo, cambios, version_pdf)
           VALUES ($1, $2, $3, $4, NULL)`,
          [id, userId, motivoLimpio, JSON.stringify(cambios)],
        );

        await registrarAudit(
          userId,
          'correccion',
          'solicitud_pago',
          id,
          {
            numero: sol.numero,
            motivo: motivoLimpio,
            cambios_count: cambios.length,
            estado_antes: sol.estado,
            estado: pagosCorregidos.estado,
          },
          client,
        );

        await client.query('COMMIT');
        resultado = {
          numero: sol.numero,
          nombreCorto: sol.nombreCorto,
          estado: pagosCorregidos.estado,
          pagadoCentavos: pagosCorregidos.pagadoCentavos,
          saldoCentavos: pagosCorregidos.saldoCentavos,
        };
      } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error en corrección de solicitud:', err);
        throw err;
      } finally {
        client.release();
      }

      if (!resultado) return;
      await borrarArchivos(clavesViejas);

      // La copia archivada del PDF: si ya existía, la corrección deja una
      // versión nueva al lado (-v2, -v3...); si la corrección acaba de saldar
      // la solicitud, se archiva la primera, como al registrar el último pago.
      try {
        const baseKey = `${resultado.nombreCorto}/solicitudes/${resultado.numero}.pdf`;
        let hayBase = true;
        try {
          await downloadFile(baseKey);
        } catch {
          hayBase = false;
        }
        if (hayBase) {
          const countResult = await query<{ count: string }>(
            'SELECT COUNT(*) as count FROM correcciones_solicitud WHERE solicitud_pago_id = $1',
            [id],
          );
          const version = parseInt(countResult.rows[0].count) + 1;
          const pdfBuffer = await generateFullPDF(id);
          const versionKey = `${resultado.nombreCorto}/solicitudes/${resultado.numero}-v${version}.pdf`;
          await uploadFile(versionKey, pdfBuffer, 'application/pdf');
          await query(
            `UPDATE correcciones_solicitud SET version_pdf = $1
             WHERE id = (
               SELECT id FROM correcciones_solicitud
               WHERE solicitud_pago_id = $2 AND version_pdf IS NULL
               ORDER BY created_at DESC LIMIT 1
             )`,
            [versionKey, id],
          );
        } else if (
          resultado.estado === 'pagada' ||
          resultado.estado === 'facturada'
        ) {
          const pdfBuffer = await generateFullPDF(id);
          await uploadFile(baseKey, pdfBuffer, 'application/pdf');
        }
      } catch (pdfErr) {
        console.error('Error generating versioned PDF:', pdfErr);
        // Don't fail the whole correction — data is already saved
      }

      res.json({
        success: true,
        message: 'Corrección guardada exitosamente',
        estado: resultado.estado,
        pagado: deCentavos(resultado.pagadoCentavos),
        saldo: deCentavos(resultado.saldoCentavos),
      });
    },
  ),
);

// --- POST /:id/registrar-pago — Registrar un pago, total o parcial, con su comprobante ---
// Una solicitud regular se puede pagar en partes (migración 191): `monto` es lo
// que se paga ahora y, sin `monto`, se paga el saldo. Mientras queda saldo la
// solicitud está «abonada»; cuando el saldo llega a cero pasa a «pagada», o a
// «facturada» si la factura ya se había registrado. Las de caja menuda
// (reembolso, apertura) se pagan de una vez, como siempre.
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
      fixFiles(req);
      next();
    });
  },
  asyncHandler(
    async (req: Request<{ id: string }>, res: Response): Promise<void> => {
      const id = Number(req.params.id);
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

      // Sin monto se paga el saldo; con monto, tiene que ser un monto de verdad.
      const montoEnviado = req.body.monto !== undefined && req.body.monto !== '';
      const montoEscrito = montoEnviado ? leerMonto(req.body.monto) : null;
      if (montoEnviado && montoEscrito === null) {
        res.status(400).json({
          success: false,
          message: 'El monto del pago no es válido',
        });
        return;
      }

      // Todo en una transacción: si algo falla (R2, el PDF), no queda nada a
      // medias. Los archivos ya subidos a R2 no se deshacen, pero sueltos no
      // estorban.
      const archivosInfo: string[] = [];
      let resultado: {
        numero: string;
        tipo: SaldoSolicitud['tipo'];
        estado: EstadoPorPagos;
        montoCentavos: number;
        saldoAntes: number;
        saldoDespues: number;
        totalCentavos: number;
      } | null = null;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const sol = await leerSaldoBloqueando(client, id);
        if (!sol) {
          await client.query('ROLLBACK');
          res
            .status(404)
            .json({ success: false, message: 'Solicitud no encontrada' });
          return;
        }

        const regular = sol.tipo === 'regular';
        if (!(sol.estado === 'aprobada' || (regular && sol.estado === 'abonada'))) {
          await client.query('ROLLBACK');
          res.status(400).json({
            success: false,
            message: regular
              ? 'Solo se registra el pago de una solicitud por pagar o abonada'
              : 'Solo se puede registrar pago de solicitudes aprobadas',
          });
          return;
        }
        if (sol.saldoCentavos <= 0) {
          await client.query('ROLLBACK');
          res.status(400).json({
            success: false,
            message: 'Esta solicitud no tiene saldo por pagar',
          });
          return;
        }

        const montoCentavos = montoEscrito ?? sol.saldoCentavos;
        if (!regular && montoCentavos !== sol.saldoCentavos) {
          await client.query('ROLLBACK');
          res.status(400).json({
            success: false,
            message: 'Las solicitudes de caja menuda se pagan completas',
          });
          return;
        }
        if (montoCentavos > sol.saldoCentavos) {
          await client.query('ROLLBACK');
          res.status(400).json({
            success: false,
            message: `El monto es mayor que el saldo (${dineroCentavos(sol.saldoCentavos)})`,
          });
          return;
        }

        const pago = await client.query<{ id: number }>(
          `INSERT INTO comprobantes_pago (solicitud_pago_id, fecha_pago, registrado_por, monto)
           VALUES ($1, $2, $3, $4)
           RETURNING id`,
          [id, fecha_pago, userId, deCentavos(montoCentavos)],
        );
        const pagoId = pago.rows[0].id;

        for (const file of files) {
          const uuid = crypto.randomUUID();
          const safeName = sanitizeFilename(file.originalname);
          const r2Key = `solicitudes-pago/${id}/comprobantes/${uuid}_${safeName}`;

          await uploadFile(r2Key, file.buffer, file.mimetype);

          await client.query(
            `INSERT INTO solicitud_pago_adjuntos
               (solicitud_pago_id, nombre_original, r2_key, tipo_mime, tamano, subido_por, tipo_adjunto, comprobante_pago_id)
             VALUES ($1, $2, $3, $4, $5, $6, 'comprobante', $7)`,
            [id, file.originalname, r2Key, file.mimetype, file.size, userId, pagoId],
          );

          archivosInfo.push(file.originalname);
        }

        const saldoDespues = sol.saldoCentavos - montoCentavos;
        const estado = estadoSegunPagos({
          tipo: sol.tipo,
          pagos: sol.pagos + 1,
          saldoCentavos: saldoDespues,
          conFactura: sol.conFactura,
        });
        await client.query(
          'UPDATE solicitudes_pago SET estado = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND activo = true',
          [estado, id],
        );

        // La copia del PDF se archiva cuando la solicitud queda pagada
        // completa, como siempre; una abonada todavía no ha terminado. Si
        // falla, el catch deshace la transacción entera.
        if (saldoDespues === 0) {
          const pdfBuffer = await generateFullPDF(id, client);
          const archiveKey = `${sol.nombreCorto}/solicitudes/${sol.numero}.pdf`;
          await uploadFile(archiveKey, pdfBuffer, 'application/pdf');
        }

        await client.query('COMMIT');
        resultado = {
          numero: sol.numero,
          tipo: sol.tipo,
          estado,
          montoCentavos,
          saldoAntes: sol.saldoCentavos,
          saldoDespues,
          totalCentavos: sol.totalCentavos,
        };
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`Error registrando el pago (solicitud ${id}):`, err);
        res.status(500).json({
          success: false,
          message: 'No se pudo registrar el pago. No se guardó ningún cambio. Intente nuevamente.',
        });
        return;
      } finally {
        client.release();
      }

      if (!resultado) return;
      const { tipo } = resultado;
      const parcial = resultado.saldoDespues > 0;
      await registrarAudit(
        userId,
        tipo === 'reembolso' ? 'registrar_reembolso'
          : tipo === 'apertura' ? 'registrar_transferencia'
          : parcial ? 'registrar_pago_parcial'
          : 'registrar_pago',
        'solicitud_pago',
        id,
        {
          numero: resultado.numero,
          fecha_pago,
          monto: deCentavos(resultado.montoCentavos),
          total: deCentavos(resultado.totalCentavos),
          saldo_antes: deCentavos(resultado.saldoAntes),
          saldo_despues: deCentavos(resultado.saldoDespues),
          estado: resultado.estado,
          archivos: archivosInfo,
        },
      );

      res.json({
        success: true,
        message: tipo === 'reembolso' ? 'Reembolso registrado exitosamente'
          : tipo === 'apertura' ? 'Transferencia registrada exitosamente'
          : parcial ? 'Pago parcial registrado exitosamente'
          : 'Pago registrado exitosamente',
        estado: resultado.estado,
        tipo,
        pagado: deCentavos(resultado.totalCentavos - resultado.saldoDespues),
        saldo: deCentavos(resultado.saldoDespues),
      });
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
      fixFiles(req);
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

      // All DB writes run inside one transaction so a failure at any step
      // rolls back cleanly and leaves no debris. The factura insert is
      // idempotent: a previous failed attempt that left a row gets
      // overwritten instead of colliding with the UNIQUE (solicitud_pago_id)
      // constraint, which would otherwise block every retry with a
      // duplicate-key 500. R2 objects can't roll back, but orphaned files
      // are harmless.
      //
      // La factura también se sube a una solicitud abonada (pagos parciales,
      // Ivan 2026-11-18): la etiqueta sigue al dinero y se queda «Abonada»; el
      // pago que la salde la pasa directo a Facturada. La fila queda bloqueada
      // igual que al registrar un pago, así que la factura y el último pago no
      // se cruzan: el segundo en llegar ya ve lo que hizo el primero.
      const archivosInfo: string[] = [];
      let numero = '';
      let estado: EstadoPorPagos = 'facturada';
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const sol = await leerSaldoBloqueando(client, Number(id));
        if (!sol) {
          await client.query('ROLLBACK');
          res
            .status(404)
            .json({ success: false, message: 'Solicitud no encontrada' });
          return;
        }
        if (sol.estado === 'abonada' && sol.conFactura) {
          await client.query('ROLLBACK');
          res.status(400).json({
            success: false,
            message: 'Esta solicitud ya tiene su factura o recibo registrado',
          });
          return;
        }
        if (sol.estado !== 'pagada' && sol.estado !== 'abonada') {
          await client.query('ROLLBACK');
          res.status(400).json({
            success: false,
            message: 'Solo se puede registrar factura de solicitudes abonadas o pagadas',
          });
          return;
        }
        numero = sol.numero;
        estado = estadoSegunPagos({
          tipo: sol.tipo,
          pagos: sol.pagos,
          saldoCentavos: sol.saldoCentavos,
          conFactura: true,
        });

        await client.query(
          `INSERT INTO facturas_solicitud (solicitud_pago_id, fecha_factura, numero_factura, registrado_por, tipo)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (solicitud_pago_id)
           DO UPDATE SET fecha_factura = EXCLUDED.fecha_factura,
                         numero_factura = EXCLUDED.numero_factura,
                         registrado_por = EXCLUDED.registrado_por,
                         tipo = EXCLUDED.tipo`,
          [id, fecha_factura, numero_factura || null, userId, tipoDoc],
        );

        for (const file of files) {
          const uuid = crypto.randomUUID();
          const safeName = sanitizeFilename(file.originalname);
          const r2Key = `solicitudes-pago/${id}/facturas/${uuid}_${safeName}`;

          await uploadFile(r2Key, file.buffer, file.mimetype);

          await client.query(
            `INSERT INTO solicitud_pago_adjuntos (solicitud_pago_id, nombre_original, r2_key, tipo_mime, tamano, subido_por, tipo_adjunto)
             VALUES ($1, $2, $3, $4, $5, $6, 'factura')`,
            [id, file.originalname, r2Key, file.mimetype, file.size, userId],
          );

          archivosInfo.push(file.originalname);
        }

        await client.query(
          'UPDATE solicitudes_pago SET estado = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND activo = true',
          [estado, id],
        );

        // Archive an immutable copy of the factura file to the project
        // folder. This is best-effort: a failure here only logs and does
        // NOT roll back the registration (same as before).
        try {
          const firstFile = files[0];
          const archiveKey = `${sol.nombreCorto}/solicitudes/${numero}-factura.pdf`;
          await uploadFile(archiveKey, firstFile.buffer, firstFile.mimetype);
        } catch (archiveErr) {
          console.error('Error archiving factura file:', archiveErr);
        }

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`Error registrando ${tipoDoc} (solicitud ${id}):`, err);
        res.status(500).json({
          success: false,
          message: 'No se pudo registrar la factura. No se guardó ningún cambio. Intente nuevamente.',
        });
        return;
      } finally {
        client.release();
      }

      await registrarAudit(
        userId,
        'registrar_factura',
        'solicitud_pago',
        parseInt(id),
        {
          numero,
          tipo: tipoDoc,
          fecha_factura,
          numero_factura: numero_factura || null,
          estado,
          archivos: archivosInfo,
        },
      );

      res.json({ success: true, message: 'Factura registrada exitosamente', estado });
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
      // 403 y no 401: la pantalla toma cualquier 401 como sesión vencida y
      // sacaba a la persona del sistema por equivocarse de contraseña.
      res
        .status(403)
        .json({ success: false, message: 'Contraseña incorrecta' });
      return;
    }

    const resultados: { id: number; aprobada: boolean; error?: string }[] = [];
    /** Las urgentes aprobadas que todavia tienen a alguien detras en la cadena. */
    const siguenUrgentes: number[] = [];

    for (const solicitudId of ids) {
      try {
        const solicitud = await query<SolicitudRow>(
          'SELECT * FROM solicitudes_pago WHERE id = $1 AND activo = true',
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
          'SELECT user_id, orden FROM proyecto_ajustes_aprobacion WHERE proyecto_id = $1 AND activo = true ORDER BY orden',
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
            'UPDATE solicitudes_pago SET estado = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND activo = true',
            ['aprobada', solicitudId],
          );
        }

        // Limpiar revisión
        await query(
          'DELETE FROM solicitud_revisiones WHERE solicitud_pago_id = $1 AND user_id = $2',
          [solicitudId, userId],
        );

        resultados.push({ id: solicitudId, aprobada: true });
        if (
          solicitud.rows[0].urgente &&
          aprobacionesHechas + 1 < aprobadores.rows.length
        ) {
          siguenUrgentes.push(solicitudId);
        }
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

    // Las urgentes que siguen en la cadena: WhatsApp a quien firma ahora.
    for (const solicitudId of siguenUrgentes) void avisarTurnoUrgente(solicitudId);
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
        // 403 y no 401: la pantalla toma cualquier 401 como sesión vencida y
        // sacaba a la persona del sistema por equivocarse de contraseña.
        res
          .status(403)
          .json({ success: false, message: 'Contraseña incorrecta' });
        return;
      }

      // Obtener la solicitud
      const solicitud = await query<SolicitudRow>(
        'SELECT * FROM solicitudes_pago WHERE id = $1 AND activo = true',
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
        'SELECT user_id, orden FROM proyecto_ajustes_aprobacion WHERE proyecto_id = $1 AND activo = true ORDER BY orden',
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
          'UPDATE solicitudes_pago SET estado = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND activo = true',
          ['aprobada', id],
        );
      }

      res.json({ success: true, message: 'Solicitud aprobada' });

      // Y por WhatsApp (services/whatsapp/avisoUrgente.ts).
      if (solicitud.rows[0].urgente && !esUltimoAprobador) {
        void avisarTurnoUrgente(Number(id));
      }

      // Notificar al siguiente aprobador si es urgente y quedan aprobadores (fire and forget)
      if (solicitud.rows[0].urgente && !esUltimoAprobador) {
        (async () => {
          try {
            // Buscar el siguiente aprobador (el que sigue después del actual)
            const nextAprobador = await query<{
              nombre: string;
              email: string;
            }>(
              `SELECT u.nombre, u.email FROM proyecto_ajustes_aprobacion pas
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
        'SELECT * FROM solicitudes_pago WHERE id = $1 AND activo = true',
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
        'SELECT user_id, orden FROM proyecto_ajustes_aprobacion WHERE proyecto_id = $1 AND activo = true ORDER BY orden',
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

      const esApertura = solicitud.rows[0].tipo === 'apertura';
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // La apertura de una caja que ya tiene gastos no se rechaza (Ivan,
        // 2026-11-19): la caja queda trabada mientras se cuenta, para que
        // ningún gasto entre entre el conteo y el rechazo.
        if (esApertura) {
          const caja = await cajaDeLaApertura(client, Number(id), true);
          if (caja && caja.gastos > 0) {
            await client.query('ROLLBACK');
            res.status(409).json({
              success: false,
              message: mensajeAperturaConGastos(caja),
              caja_apertura: caja,
            });
            return;
          }
        }

        await client.query(
          `INSERT INTO solicitud_aprobaciones (solicitud_pago_id, user_id, orden, accion, comentario)
           VALUES ($1, $2, $3, 'rechazado', $4)`,
          [id, userId, siguienteAprobador.orden, comentario],
        );
        await client.query(
          'UPDATE solicitudes_pago SET estado = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND activo = true',
          ['rechazada', id],
        );

        // Una apertura rechazada cancela su caja; un aumento rechazado la
        // devuelve al monto anterior. Ninguna de las dos se reenvía.
        if (esApertura) {
          await alRechazarApertura(client, Number(id), userId, comentario);
        }

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

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
        'SELECT * FROM solicitudes_pago WHERE id = $1 AND activo = true',
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
        'SELECT user_id, orden FROM proyecto_ajustes_aprobacion WHERE proyecto_id = $1 AND activo = true ORDER BY orden',
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

// --- POST /:id/mensaje/leer — Marca el mensaje como leído para el usuario actual ---
router.post(
  '/:id/mensaje/leer',
  [param('id').isInt()],
  asyncHandler(
    async (req: Request<{ id: string }>, res: Response): Promise<void> => {
      const { id } = req.params;
      const userId = req.user!.id;

      const existing = await query<{ mensaje: string | null; activo: boolean }>(
        'SELECT mensaje, activo FROM solicitudes_pago WHERE id = $1',
        [id],
      );
      if (existing.rows.length === 0 || !existing.rows[0].activo) {
        res
          .status(404)
          .json({ success: false, message: 'Solicitud no encontrada' });
        return;
      }
      if (!existing.rows[0].mensaje) {
        // No hay mensaje que marcar como leído; no-op silencioso.
        res.json({ success: true });
        return;
      }

      await query(
        `INSERT INTO solicitud_mensaje_lecturas (solicitud_pago_id, user_id, leido_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (solicitud_pago_id, user_id) DO UPDATE SET leido_at = NOW()`,
        [id, userId],
      );

      res.json({ success: true });
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
      fixFiles(req);
      next();
    });
  },
  asyncHandler(
    async (req: Request<{ id: string }>, res: Response): Promise<void> => {
      const { id } = req.params;
      const userId = req.user!.id;
      const { fecha_reembolso } = req.body;
      const file = req.file;

      // El reembolso a Pinellas es por el total: se registra cuando la
      // solicitud ya está pagada completa, nunca mientras está abonada (Ivan,
      // 2026-11-18). La fila queda bloqueada hasta el final: una corrección
      // que anule un pago al mismo tiempo espera, y no deja un reembolso
      // registrado sobre una solicitud con saldo.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const fallar = async (codigo: number, message: string) => {
          await client.query('ROLLBACK');
          res.status(codigo).json({ success: false, message });
        };

        const solicitud = await client.query<{
          pinellas_paga: boolean;
          numero: string;
          estado: string;
        }>(
          'SELECT pinellas_paga, numero, estado FROM solicitudes_pago WHERE id = $1 AND activo = true FOR UPDATE',
          [id],
        );
        if (solicitud.rows.length === 0) {
          await fallar(404, 'Solicitud no encontrada');
          return;
        }
        const sol = solicitud.rows[0];
        if (!sol.pinellas_paga) {
          await fallar(400, 'Esta solicitud no está marcada como "Pinellas paga"');
          return;
        }
        if (sol.estado !== 'pagada' && sol.estado !== 'facturada') {
          await fallar(
            400,
            'El reembolso a Pinellas se registra cuando la solicitud está pagada completa',
          );
          return;
        }

        const existing = await client.query(
          'SELECT id FROM reembolsos_pinellas WHERE solicitud_pago_id = $1',
          [id],
        );
        if (existing.rows.length > 0) {
          await fallar(400, 'Esta solicitud ya tiene un reembolso registrado');
          return;
        }

        if (!file) {
          await fallar(400, 'El comprobante de reembolso es requerido');
          return;
        }

        const r2Key = `reembolsos/${id}/${crypto.randomUUID()}_${sanitizeFilename(file.originalname)}`;
        await uploadFile(r2Key, file.buffer, file.mimetype);

        await client.query(
          `INSERT INTO reembolsos_pinellas (solicitud_pago_id, comprobante_url, comprobante_nombre, fecha_reembolso, registrado_por)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            id,
            r2Key,
            file.originalname,
            fecha_reembolso || new Date().toISOString().split('T')[0],
            userId,
          ],
        );

        await registrarAudit(
          userId,
          'registrar_reembolso',
          'solicitud_pago',
          parseInt(id),
          { numero: sol.numero },
          client,
        );

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

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
      fixFiles(req);
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

      // La devolución es de una solicitud pagada completa, como siempre; una
      // abonada no (Ivan, 2026-11-18). La fila queda bloqueada hasta el final:
      // un pago o una corrección al mismo tiempo esperan, y el estado que se
      // revisa es el que se cambia.
      let sol: { numero: string; nombre_corto: string } | null = null;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const fallar = async (codigo: number, message: string) => {
          await client.query('ROLLBACK');
          res.status(codigo).json({ success: false, message });
        };

        const solicitud = await client.query<{
          numero: string;
          estado: string;
          nombre_corto: string;
        }>(
          `SELECT sp.numero, sp.estado, COALESCE(p.nombre_corto, p.nombre) as nombre_corto
           FROM solicitudes_pago sp
           LEFT JOIN proyectos p ON sp.proyecto_id = p.id
           WHERE sp.id = $1 AND sp.activo = true
           FOR UPDATE OF sp`,
          [id],
        );
        if (solicitud.rows.length === 0) {
          await fallar(404, 'Solicitud no encontrada');
          return;
        }
        const fila = solicitud.rows[0];
        if (fila.estado !== 'pagada' && fila.estado !== 'facturada') {
          await fallar(
            400,
            'Solo se puede registrar devolución en solicitudes pagadas o facturadas',
          );
          return;
        }

        const existing = await client.query(
          'SELECT id FROM devoluciones_solicitud WHERE solicitud_pago_id = $1',
          [id],
        );
        if (existing.rows.length > 0) {
          await fallar(400, 'Esta solicitud ya tiene una devolución registrada');
          return;
        }

        const r2Key = `devoluciones/${id}/${crypto.randomUUID()}_${sanitizeFilename(file.originalname)}`;
        await uploadFile(r2Key, file.buffer, file.mimetype);

        await client.query(
          `INSERT INTO devoluciones_solicitud (solicitud_pago_id, fecha_devolucion, motivo, comprobante_url, comprobante_nombre, registrado_por)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [id, fecha_devolucion, motivo.trim(), r2Key, file.originalname, userId],
        );

        await client.query(
          'UPDATE solicitudes_pago SET estado = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND activo = true',
          ['devolucion', id],
        );

        await registrarAudit(
          userId,
          'registrar_devolucion',
          'solicitud_pago',
          parseInt(id),
          {
            numero: fila.numero,
            motivo: motivo.trim(),
            fecha_devolucion,
          },
          client,
        );

        await client.query('COMMIT');
        sol = fila;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
      if (!sol) return;

      // Archive immutable copy of devolucion comprobante to project folder
      try {
        const archiveKey = `${sol.nombre_corto}/solicitudes/${sol.numero}-devolucion.pdf`;
        await uploadFile(archiveKey, file.buffer, file.mimetype);
      } catch (archiveErr) {
        console.error('Error archiving devolucion file:', archiveErr);
      }

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
        'SELECT comprobante_url FROM devoluciones_solicitud WHERE solicitud_pago_id = $1',
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

// --- GET /:id/reembolso/comprobante — Download reembolso comprobante ---
router.get(
  '/:id/reembolso/comprobante',
  [param('id').isInt()],
  asyncHandler(
    async (req: Request<{ id: string }>, res: Response): Promise<void> => {
      const { id } = req.params;
      const result = await query<{ comprobante_url: string }>(
        'SELECT comprobante_url FROM reembolsos_pinellas WHERE solicitud_pago_id = $1',
        [id],
      );
      if (result.rows.length === 0) {
        res
          .status(404)
          .json({ success: false, message: 'Reembolso no encontrado' });
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

      const existing = await query<
        SolicitudRow & { preparado_por: number; proyecto_id: number }
      >(
        'SELECT id, numero, estado, preparado_por, proyecto_id, tipo FROM solicitudes_pago WHERE id = $1 AND activo = true',
        [id],
      );
      if (existing.rows.length === 0) {
        res
          .status(404)
          .json({ success: false, message: 'Solicitud no encontrada' });
        return;
      }

      // La apertura (o un aumento) de una caja menuda no se quita sola: la caja
      // quedaría con un monto que nadie le va a transferir (Ivan, 2026-11-18).
      // Una caja abierta por error se elimina entera desde Cajas Menudas, y
      // eso se lleva su apertura; un aumento equivocado se rechaza.
      if (existing.rows[0].tipo === 'apertura') {
        res.status(400).json({
          success: false,
          message:
            'Esta solicitud es de una caja menuda y no se elimina sola. Si la caja se abrió por error, elimínela desde Cajas Menudas.',
        });
        return;
      }

      // Block deletion of anything with money paid (abonada, pagada, facturada,
      // devolucion) unless it's the test project
      const testProjectId = process.env.TEST_PROJECT_ID
        ? parseInt(process.env.TEST_PROJECT_ID)
        : null;
      const sol = existing.rows[0];
      if (
        isAdmin &&
        (sol.estado === 'abonada' ||
          sol.estado === 'pagada' ||
          sol.estado === 'facturada' ||
          sol.estado === 'devolucion') &&
        sol.proyecto_id !== testProjectId
      ) {
        res.status(400).json({
          success: false,
          message:
            'No se pueden eliminar solicitudes abonadas, pagadas, facturadas o en devolución',
        });
        return;
      }

      if (!isAdmin) {
        // Co-admin y usuarios normales: pendiente o aprobada (stages 1/2/3)
        if (!['pendiente', 'aprobada'].includes(existing.rows[0].estado)) {
          res.status(400).json({
            success: false,
            message:
              'Solo se pueden eliminar solicitudes en estado pendiente o aprobada',
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

      const { numero, estado } = existing.rows[0];
      let archivos: string[] = [];
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        archivos = await retirarSolicitud(client, Number(id));
        await registrarAudit(
          req.user!.id,
          'eliminar',
          'solicitud_pago',
          Number(id),
          { numero, estado_al_eliminar: estado },
          client,
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
      await borrarArchivos(archivos);

      res.json({ success: true, message: 'Solicitud eliminada' });
    },
  ),
);

export default router;
