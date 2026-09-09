/**
 * Reportes diarios de obra
 *
 * El registro diario de cada proyecto: que clima hubo, cuanta gente y equipo
 * habia, que se hizo, que atraso y las fotos del dia. Sustituyen a la
 * bitacora, que nadie usaba.
 *
 * Gobernados por el permiso `reportes` y ademas por checkProjectAccess,
 * porque viven dentro de un proyecto.
 */

import { Router, Request, Response } from 'express';
import multer from 'multer';
import crypto from 'crypto';
import path from 'path';
import { query } from '../database/config.js';
import { uploadFile, deleteFile, getFileSignedUrl } from '../services/storage.js';
import {
  authenticateToken,
  checkPermission,
  checkProjectAccess,
} from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { construirNumeroReporte } from '../services/reporteNumero.js';
import {
  diffCampos,
  describirCambios,
  parseHoras,
  type Cambio,
} from '../services/reporteCambios.js';
import {
  generateReportePDF,
  type ReportePdfInput,
} from '../services/reportePdf.js';
import { sendEmail } from '../services/emailService.js';
import { registrarAudit } from '../services/auditLog.js';

const router = Router();

const CLIMAS = ['Soleado', 'Nublado', 'Lluvia parcial', 'Lluvia todo el día'];

interface ReporteBody {
  fecha?: string;
  clima?: string;
  horas_perdidas?: number | string | null;
  motivo?: string | null;
  personal_calificado?: number | string;
  ayudantes?: number | string;
  equipo?: string[];
  areas?: number[];
  que_se_hizo?: string;
  atrasos?: string | null;
  novedades?: string | null;
}

interface ReporteRow {
  id: number;
  proyecto_id: number;
  numero: string;
  fecha: string;
  clima: string;
  horas_perdidas: string | null;
  motivo: string | null;
  personal_calificado: number;
  ayudantes: number;
  equipo: string[];
  que_se_hizo: string;
  atrasos: string | null;
  novedades: string | null;
  creado_por: number;
  created_at: Date;
  updated_at: Date;
}

// Se aceptan solo los formatos que Chrome sabe dibujar, porque el PDF se
// arma con Puppeteer: un HEIC de iPhone se subiria sin queja y despues
// desapareceria del PDF sin que nadie se entere. Mejor rechazarlo aqui, donde
// el ingeniero todavia esta mirando la pantalla. En la practica Safari
// convierte a JPEG al subir desde el celular, asi que casi nunca llega.
const FORMATOS = /^(jpe?g|png|webp|gif)$/;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase().replace('.', '');
    const mime = file.mimetype.replace('image/', '').toLowerCase();
    if (FORMATOS.test(ext) && FORMATOS.test(mime)) {
      cb(null, true);
    } else {
      cb(
        new Error(
          'Solo se permiten imágenes JPG, PNG, WEBP o GIF. Si la foto viene de un iPhone en formato HEIC, vuelve a guardarla como JPG.',
        ),
      );
    }
  },
});

/**
 * Multer avisa de sus rechazos lanzando, y el manejador general los convierte
 * en "Error interno del servidor", que al ingeniero no le dice nada. Aqui se
 * traducen a un 400 con el motivo real. El limite de tamano importa mas que
 * el de formato: una foto de celular pasada de 10 MB va a ser comun.
 */
function subirFotos(req: Request, res: Response, next: (err?: unknown) => void): void {
  upload.array('fotos', 20)(req, res, (err: unknown) => {
    if (!err) {
      next();
      return;
    }
    const esMulter = err instanceof multer.MulterError;
    let mensaje = (err as Error).message;
    if (esMulter && (err as multer.MulterError).code === 'LIMIT_FILE_SIZE') {
      mensaje = 'Cada foto debe pesar menos de 10 MB';
    } else if (esMulter && (err as multer.MulterError).code === 'LIMIT_FILE_COUNT') {
      mensaje = 'Máximo 20 fotos por reporte';
    }
    res.status(400).json({ success: false, message: mensaje });
  });
}

function limpiarNombre(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_');
}

/**
 * La direccion del archivo en R2, con la misma forma que usan las solicitudes
 * de pago: primero el proyecto, para que el bucket se pueda recorrer por obra.
 */
function claveFoto(
  proyectoCorto: string,
  numero: string,
  nombreOriginal: string,
): string {
  return `${limpiarNombre(proyectoCorto)}/reportes/${numero}/${crypto.randomUUID()}_${limpiarNombre(nombreOriginal)}`;
}

/**
 * Solo quien escribio el reporte lo corrige. Admin y co-admin tambien, para
 * que un dato malo siga siendo arreglable cuando el ingeniero se fue de la
 * empresa o esta de vacaciones. Nadie mas, por amplios que sean sus permisos.
 */
function puedeCorregir(req: Request, autorId: number): boolean {
  return (
    autorId === req.user!.id ||
    req.user!.rol === 'admin' ||
    req.user!.rol === 'co-admin'
  );
}

/**
 * El siguiente numero para un proyecto y una fecha. Lee el prefijo del
 * proyecto y cuenta cuantos reportes hay ya en esa fecha; armar el texto es
 * cosa de construirNumeroReporte, que se verifica aparte.
 *
 * La cuenta incluye los dados de baja a proposito: numero es unico, y volver
 * a entregar el de una fila borrada reventaria al insertar.
 */
export async function generateReporteNumero(
  proyectoId: number,
  fecha: string,
): Promise<string> {
  const proyecto = await query<{ sp_prefijo: string | null }>(
    'SELECT sp_prefijo FROM proyectos WHERE id = $1',
    [proyectoId],
  );
  if (proyecto.rows.length === 0) throw new Error('Proyecto no encontrado');

  const existentes = await query<{ total: string }>(
    `SELECT COUNT(*)::text AS total
       FROM proyecto_reportes
      WHERE proyecto_id = $1 AND fecha = $2`,
    [proyectoId, fecha],
  );

  return construirNumeroReporte(
    proyecto.rows[0].sp_prefijo ?? '',
    fecha,
    parseInt(existentes.rows[0].total, 10),
  );
}

/** Valida el cuerpo de un alta. Devuelve el mensaje del primer problema. */
function validarAlta(body: ReporteBody): string | null {
  if (!body.fecha) return 'La fecha es obligatoria';
  if (!body.clima || !CLIMAS.includes(body.clima)) return 'Clima inválido';
  if (!body.que_se_hizo?.trim()) return 'Debes describir qué se hizo hoy';
  return null;
}

// ---------------------------------------------------------------------------
// Lectura
// ---------------------------------------------------------------------------

// GET /api/proyecto-reportes/:proyectoId
router.get(
  '/:proyectoId',
  authenticateToken,
  checkPermission('reportes'),
  checkProjectAccess('proyectoId'),
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const { mes, creado_por: creadoPor, q } = req.query as Record<string, string>;
    const limit = Math.min(parseInt(String(req.query.limit ?? '25'), 10) || 25, 200);
    const offset = parseInt(String(req.query.offset ?? '0'), 10) || 0;

    const params: unknown[] = [req.params.proyectoId];
    const where: string[] = ['r.proyecto_id = $1', 'r.activo = true'];

    if (mes) {
      params.push(`${mes}-01`);
      where.push(
        `date_trunc('month', r.fecha) = date_trunc('month', $${params.length}::date)`,
      );
    }
    if (creadoPor) {
      params.push(creadoPor);
      where.push(`r.creado_por = $${params.length}`);
    }
    if (q) {
      params.push(`%${q}%`);
      const i = params.length;
      where.push(
        `(r.que_se_hizo ILIKE $${i} OR r.atrasos ILIKE $${i}
          OR r.novedades ILIKE $${i} OR r.numero ILIKE $${i})`,
      );
    }

    const total = await query<{ total: string }>(
      `SELECT COUNT(*)::text AS total FROM proyecto_reportes r WHERE ${where.join(' AND ')}`,
      params,
    );

    params.push(limit, offset);
    const rows = await query(
      `SELECT r.id, r.numero, r.fecha, r.clima, r.horas_perdidas, r.motivo,
              r.personal_calificado, r.ayudantes, r.equipo, r.creado_por,
              r.created_at, r.updated_at, r.enviado_at,
              u.nombre AS creador_nombre,
              (SELECT COUNT(*)::int FROM proyecto_reporte_fotos f
                WHERE f.reporte_id = r.id) AS fotos,
              COALESCE(
                (SELECT json_agg(a.nombre ORDER BY a.orden)
                   FROM proyecto_reporte_areas ra
                   JOIN proyecto_areas a ON a.id = ra.area_id
                  WHERE ra.reporte_id = r.id),
                '[]'::json
              ) AS areas
         FROM proyecto_reportes r
         JOIN users u ON u.id = r.creado_por
        WHERE ${where.join(' AND ')}
        ORDER BY r.fecha DESC, r.id DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    res.json({
      success: true,
      data: rows.rows,
      total: parseInt(total.rows[0].total, 10),
    });
  }),
);

// GET /api/proyecto-reportes/:proyectoId/meses
//
// Los meses que este proyecto de verdad tiene, para que el filtro no ofrezca
// meses vacios. IMPORTA EL ORDEN: va antes de '/:proyectoId/:id', o Express
// toma el literal "meses" como si fuera un id.
router.get(
  '/:proyectoId/meses',
  authenticateToken,
  checkPermission('reportes'),
  checkProjectAccess('proyectoId'),
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const result = await query<{ mes: string }>(
      `SELECT DISTINCT to_char(fecha, 'YYYY-MM') AS mes
         FROM proyecto_reportes
        WHERE proyecto_id = $1 AND activo = true
        ORDER BY mes DESC`,
      [req.params.proyectoId],
    );
    res.json({ success: true, data: result.rows.map((r) => r.mes) });
  }),
);

// GET /api/proyecto-reportes/:proyectoId/existe?fecha=YYYY-MM-DD
//
// Dos cosas que el formulario necesita antes de guardar:
//
// - `ya_reportado`: si este mismo usuario ya reporto esa fecha. Es un aviso
//   suave, nunca un bloqueo — a proposito no hay limite de uno por dia,
//   porque alguien tiene que poder cubrir a quien esta de vacaciones.
// - `numero_siguiente`: el codigo que le tocaria al reporte. Se calcula aqui
//   y no en la pantalla porque depende de cuantos hay ya en esa fecha, que
//   solo sabe el servidor. Es una vista previa: si entre que se muestra y se
//   guarda alguien mas registra un reporte del mismo dia, el definitivo sera
//   el siguiente.
//
// Mismo asunto de orden que /meses: va antes de '/:proyectoId/:id'.
router.get(
  '/:proyectoId/existe',
  authenticateToken,
  checkPermission('reportes'),
  checkProjectAccess('proyectoId'),
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const fecha = String(req.query.fecha ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
      res.status(400).json({ success: false, message: 'Fecha inválida' });
      return;
    }

    const mio = await query<{ id: number; numero: string }>(
      `SELECT id, numero FROM proyecto_reportes
        WHERE proyecto_id = $1 AND fecha = $2 AND creado_por = $3 AND activo = true
        LIMIT 1`,
      [req.params.proyectoId, fecha, req.user!.id],
    );

    let numeroSiguiente: string | null = null;
    try {
      numeroSiguiente = await generateReporteNumero(
        Number(req.params.proyectoId),
        fecha,
      );
    } catch {
      // Un proyecto sin codigo configurado no puede numerar. La pantalla
      // simplemente no muestra la vista previa; el error de verdad aparece
      // al intentar guardar, con su mensaje.
    }

    res.json({
      success: true,
      data: {
        ya_reportado: mio.rows[0] ?? null,
        numero_siguiente: numeroSiguiente,
      },
    });
  }),
);

// GET /api/proyecto-reportes/:proyectoId/:id
router.get(
  '/:proyectoId/:id',
  authenticateToken,
  checkPermission('reportes'),
  checkProjectAccess('proyectoId'),
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const reporte = await query(
      `SELECT r.*, u.nombre AS creador_nombre, p.nombre AS proyecto_nombre
         FROM proyecto_reportes r
         JOIN users u ON u.id = r.creado_por
         JOIN proyectos p ON p.id = r.proyecto_id
        WHERE r.id = $1 AND r.proyecto_id = $2 AND r.activo = true`,
      [req.params.id, req.params.proyectoId],
    );
    if (reporte.rows.length === 0) {
      res.status(404).json({ success: false, message: 'Reporte no encontrado' });
      return;
    }

    const areas = await query(
      `SELECT a.id, a.nombre
         FROM proyecto_reporte_areas ra
         JOIN proyecto_areas a ON a.id = ra.area_id
        WHERE ra.reporte_id = $1
        ORDER BY a.orden, a.id`,
      [req.params.id],
    );

    const fotos = await query<{
      id: number;
      nombre_archivo: string;
      r2_key: string;
      tipo_mime: string | null;
      tamano: number | null;
      orden: number;
    }>(
      `SELECT id, nombre_archivo, r2_key, tipo_mime, tamano, orden
         FROM proyecto_reporte_fotos
        WHERE reporte_id = $1
        ORDER BY orden, id`,
      [req.params.id],
    );

    // Las direcciones de R2 se firman al vuelo y vencen; nunca se guardan.
    const fotosConUrl = await Promise.all(
      fotos.rows.map(async (f) => ({
        ...f,
        url: await getFileSignedUrl(f.r2_key, 900),
      })),
    );

    // El rastro de correcciones. entidad/entidad_id es el par polimorfico
    // documentado en CLAUDE.md: se filtra por entidad primero.
    const correcciones = await query(
      `SELECT al.id, al.created_at, al.detalles, u.nombre AS usuario_nombre
         FROM audit_log al
         JOIN users u ON u.id = al.user_id
        WHERE al.entidad = 'reporte_diario'
          AND al.entidad_id = $1
          AND al.accion = 'editar'
        ORDER BY al.created_at`,
      [req.params.id],
    );

    const autorId = (reporte.rows[0] as { creado_por: number }).creado_por;

    res.json({
      success: true,
      data: {
        ...reporte.rows[0],
        areas: areas.rows,
        fotos: fotosConUrl,
        correcciones: correcciones.rows,
        // Para que la pantalla no ofrezca "Editar" donde la API va a negarlo.
        puede_editar: puedeCorregir(req, autorId),
      },
    });
  }),
);

// ---------------------------------------------------------------------------
// Escritura
// ---------------------------------------------------------------------------

// POST /api/proyecto-reportes/:proyectoId
router.post(
  '/:proyectoId',
  authenticateToken,
  checkPermission('reportes'),
  checkProjectAccess('proyectoId'),
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const body = req.body as ReporteBody;
    const proyectoId = Number(req.params.proyectoId);

    const problema = validarAlta(body);
    if (problema) {
      res.status(400).json({ success: false, message: problema });
      return;
    }

    let numero: string;
    try {
      numero = await generateReporteNumero(proyectoId, body.fecha!);
    } catch (err) {
      const msg = (err as Error).message;
      if (msg === 'PREFIJO_NO_CONFIGURADO') {
        res.status(400).json({
          success: false,
          message: 'El proyecto no tiene código configurado, y sin él no se puede numerar el reporte',
        });
        return;
      }
      if (msg.startsWith('Fecha')) {
        res.status(400).json({ success: false, message: msg });
        return;
      }
      throw err;
    }

    const inserted = await query<ReporteRow>(
      `INSERT INTO proyecto_reportes
         (proyecto_id, numero, fecha, clima, horas_perdidas, motivo,
          personal_calificado, ayudantes, equipo, que_se_hizo, atrasos, novedades,
          creado_por)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [
        proyectoId,
        numero,
        body.fecha,
        body.clima,
        parseHoras(body.horas_perdidas),
        body.motivo?.trim() || null,
        Number(body.personal_calificado ?? 0),
        Number(body.ayudantes ?? 0),
        body.equipo ?? [],
        body.que_se_hizo!.trim(),
        body.atrasos?.trim() || null,
        body.novedades?.trim() || null,
        req.user!.id,
      ],
    );

    const reporte = inserted.rows[0];

    if (body.areas?.length) {
      // Solo areas activas de ESTE proyecto: sin el filtro, un id de otra obra
      // colaria una area ajena en el reporte.
      await query(
        `INSERT INTO proyecto_reporte_areas (reporte_id, area_id)
         SELECT $1, a.id
           FROM proyecto_areas a
          WHERE a.id = ANY($2::int[]) AND a.proyecto_id = $3 AND a.activo = true`,
        [reporte.id, body.areas, proyectoId],
      );
    }

    await registrarAudit(req.user!.id, 'crear', 'reporte_diario', reporte.id, {
      proyecto_id: proyectoId,
      numero,
      fecha: body.fecha,
    });

    res.status(201).json({ success: true, data: reporte });
  }),
);

// PUT /api/proyecto-reportes/:proyectoId/:id
router.put(
  '/:proyectoId/:id',
  authenticateToken,
  checkPermission('reportes'),
  checkProjectAccess('proyectoId'),
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const body = req.body as ReporteBody;
    const proyectoId = Number(req.params.proyectoId);

    const actual = await query<ReporteRow>(
      `SELECT * FROM proyecto_reportes
        WHERE id = $1 AND proyecto_id = $2 AND activo = true`,
      [req.params.id, proyectoId],
    );
    if (actual.rows.length === 0) {
      res.status(404).json({ success: false, message: 'Reporte no encontrado' });
      return;
    }

    if (!puedeCorregir(req, actual.rows[0].creado_por)) {
      res.status(403).json({
        success: false,
        message: 'Solo quien escribió el reporte puede corregirlo',
      });
      return;
    }

    if (body.clima !== undefined && !CLIMAS.includes(body.clima)) {
      res.status(400).json({ success: false, message: 'Clima inválido' });
      return;
    }
    if (body.que_se_hizo !== undefined && !body.que_se_hizo.trim()) {
      res
        .status(400)
        .json({ success: false, message: 'Debes describir qué se hizo hoy' });
      return;
    }

    const areasAntes = await query<{ id: number }>(
      'SELECT area_id AS id FROM proyecto_reporte_areas WHERE reporte_id = $1',
      [req.params.id],
    );

    // El SET se arma solo con los campos que vienen en la peticion.
    //
    // Con una lista fija de columnas no habia forma de distinguir "no estoy
    // tocando este campo" de "quiero dejarlo vacio": una correccion que solo
    // mandaba las horas borraba en silencio los atrasos y las novedades que
    // el ingeniero habia escrito. Ausente significa no tocar; presente y
    // vacio significa borrar.
    const sets: string[] = [];
    const valores: unknown[] = [];
    const set = (columna: string, valor: unknown) => {
      valores.push(valor);
      sets.push(`${columna} = $${valores.length}`);
    };

    if (body.fecha !== undefined) set('fecha', body.fecha);
    if (body.clima !== undefined) set('clima', body.clima);
    if (body.horas_perdidas !== undefined)
      set('horas_perdidas', parseHoras(body.horas_perdidas));
    if (body.motivo !== undefined) set('motivo', body.motivo?.trim() || null);
    if (body.personal_calificado !== undefined)
      set('personal_calificado', Number(body.personal_calificado));
    if (body.ayudantes !== undefined) set('ayudantes', Number(body.ayudantes));
    if (body.equipo !== undefined) set('equipo', body.equipo);
    if (body.que_se_hizo !== undefined)
      set('que_se_hizo', body.que_se_hizo.trim());
    if (body.atrasos !== undefined) set('atrasos', body.atrasos?.trim() || null);
    if (body.novedades !== undefined)
      set('novedades', body.novedades?.trim() || null);

    sets.push('updated_at = CURRENT_TIMESTAMP');
    valores.push(req.params.id, proyectoId);

    const updated = await query<ReporteRow>(
      `UPDATE proyecto_reportes SET ${sets.join(', ')}
        WHERE id = $${valores.length - 1} AND proyecto_id = $${valores.length}
        RETURNING *`,
      valores,
    );

    if (body.areas) {
      await query('DELETE FROM proyecto_reporte_areas WHERE reporte_id = $1', [
        req.params.id,
      ]);
      if (body.areas.length) {
        await query(
          `INSERT INTO proyecto_reporte_areas (reporte_id, area_id)
           SELECT $1, a.id
             FROM proyecto_areas a
            WHERE a.id = ANY($2::int[]) AND a.proyecto_id = $3 AND a.activo = true`,
          [req.params.id, body.areas, proyectoId],
        );
      }
    }

    const areasAhora = await query<{ id: number }>(
      'SELECT area_id AS id FROM proyecto_reporte_areas WHERE reporte_id = $1',
      [req.params.id],
    );

    const cambios: Record<string, Cambio> = diffCampos(
      {
        ...actual.rows[0],
        horas_perdidas:
          actual.rows[0].horas_perdidas === null
            ? null
            : Number(actual.rows[0].horas_perdidas),
        areas: areasAntes.rows.map((a) => a.id),
      },
      {
        ...body,
        // Las areas se comparan contra lo que de verdad quedo guardado, no
        // contra lo que se pidio: un id de otra obra no entra, y decir que
        // entro seria mentira.
        areas: body.areas ? areasAhora.rows.map((a) => a.id) : undefined,
      },
    );

    // Un guardado que no movio nada no deja linea: si cada guardado dejara
    // rastro, el rastro se llenaria de ruido y dejaria de leerse.
    if (Object.keys(cambios).length > 0) {
      await registrarAudit(
        req.user!.id,
        'editar',
        'reporte_diario',
        Number(req.params.id),
        { cambios },
      );

      // Cada correccion congela su propia version en R2, para que quede
      // constancia de que decia el documento antes y despues. Va aparte de la
      // respuesta: armar un PDF tarda, y una falla al archivar no debe
      // tumbar una correccion que ya quedo guardada.
      void archivarReportePdf(Number(req.params.id)).catch((err: unknown) => {
        console.error('Error archivando el PDF de la corrección:', err);
      });
    }

    res.json({ success: true, data: updated.rows[0] });
  }),
);

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

/**
 * Junta todo lo que el PDF necesita. Lo usan tanto la descarga como el
 * archivado, para que los dos documentos digan siempre lo mismo.
 */
export async function buildReportePdfInput(
  reporteId: number,
): Promise<(ReportePdfInput & { proyectoCorto: string; autorEmail: string | null }) | null> {
  const r = await query<{
    numero: string;
    fecha: Date;
    clima: string;
    horas_perdidas: string | null;
    motivo: string | null;
    personal_calificado: number;
    ayudantes: number;
    equipo: string[];
    que_se_hizo: string;
    atrasos: string | null;
    novedades: string | null;
    autor: string;
    autor_email: string | null;
    proyecto_nombre: string;
    proyecto_corto: string;
  }>(
    `SELECT r.numero, r.fecha, r.clima, r.horas_perdidas, r.motivo,
            r.personal_calificado, r.ayudantes, r.equipo, r.que_se_hizo,
            r.atrasos, r.novedades,
            u.nombre AS autor, u.email AS autor_email,
            p.nombre AS proyecto_nombre,
            COALESCE(p.nombre_corto, p.nombre) AS proyecto_corto
       FROM proyecto_reportes r
       JOIN users u ON u.id = r.creado_por
       JOIN proyectos p ON p.id = r.proyecto_id
      WHERE r.id = $1 AND r.activo = true`,
    [reporteId],
  );
  if (r.rows.length === 0) return null;
  const row = r.rows[0];

  const areas = await query<{ nombre: string }>(
    `SELECT a.nombre FROM proyecto_reporte_areas ra
       JOIN proyecto_areas a ON a.id = ra.area_id
      WHERE ra.reporte_id = $1 ORDER BY a.orden, a.id`,
    [reporteId],
  );

  const fotos = await query<{
    r2_key: string;
    nombre_archivo: string;
    tipo_mime: string | null;
  }>(
    `SELECT r2_key, nombre_archivo, tipo_mime FROM proyecto_reporte_fotos
      WHERE reporte_id = $1 ORDER BY orden, id`,
    [reporteId],
  );

  const corr = await query<{
    created_at: Date;
    usuario_nombre: string;
    detalles: { cambios?: Record<string, Cambio> } | null;
  }>(
    `SELECT al.created_at, u.nombre AS usuario_nombre, al.detalles
       FROM audit_log al JOIN users u ON u.id = al.user_id
      WHERE al.entidad = 'reporte_diario' AND al.entidad_id = $1
        AND al.accion = 'editar'
      ORDER BY al.created_at`,
    [reporteId],
  );

  // pg devuelve una columna DATE como objeto Date, no como texto: cortarlo
  // con slice daba "Tue Sep 08" y de ahi "Invalid Date". Se toman los
  // componentes y se rearma a mediodia, para que ningun cambio de huso corra
  // la fecha un dia.
  const cruda = row.fecha as unknown;
  const fecha =
    cruda instanceof Date
      ? new Date(cruda.getFullYear(), cruda.getMonth(), cruda.getDate(), 12)
      : new Date(`${String(cruda).slice(0, 10)}T12:00:00`);
  const capitalizar = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

  return {
    numero: row.numero,
    fechaLarga: capitalizar(
      fecha.toLocaleDateString('es-PA', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      }),
    ),
    fechaCorta: fecha.toLocaleDateString('es-PA', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    }),
    // El nombre corto, no el largo: el largo de una licitacion ocupa cinco
    // lineas en la tirilla del PDF y no le dice nada a nadie.
    proyectoNombre: row.proyecto_corto,
    proyectoCorto: row.proyecto_corto,
    autorNombre: row.autor,
    autorEmail: row.autor_email,
    clima: row.clima,
    horasPerdidas: row.horas_perdidas === null ? null : Number(row.horas_perdidas),
    motivo: row.motivo,
    personalCalificado: Number(row.personal_calificado),
    ayudantes: Number(row.ayudantes),
    equipo: row.equipo ?? [],
    areas: areas.rows.map((a) => a.nombre),
    queSeHizo: row.que_se_hizo,
    atrasos: row.atrasos,
    novedades: row.novedades,
    fotos: fotos.rows,
    correcciones: corr.rows.map((c) => ({
      cuando: new Date(c.created_at).toLocaleString('es-PA', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      }),
      quien: c.usuario_nombre,
      que: c.detalles?.cambios
        ? describirCambios(c.detalles.cambios)
        : 'Cambio registrado',
    })),
  };
}

/**
 * Congela en R2 el PDF tal como esta ahora y devuelve el mismo buffer, para
 * que quien lo mande por correo no tenga que generarlo dos veces.
 *
 * La version 1 se archiva al crear el reporte, que es cuando sale por correo;
 * cada correccion posterior archiva la siguiente. Ver el reporte en pantalla
 * no archiva nada: eso se genera al vuelo.
 */
export async function archivarReportePdf(
  reporteId: number,
): Promise<{ buffer: Buffer; version: number; key: string } | null> {
  const datos = await buildReportePdfInput(reporteId);
  if (!datos) return null;

  const previas = await query<{ total: string }>(
    'SELECT COUNT(*)::text AS total FROM proyecto_reporte_pdfs WHERE reporte_id = $1',
    [reporteId],
  );
  const version = parseInt(previas.rows[0].total, 10) + 1;

  const sufijo = version === 1 ? '' : `-v${version}`;
  const key = `${limpiarNombre(datos.proyectoCorto)}/reportes/${datos.numero}${sufijo}.pdf`;

  const buffer = await generateReportePDF(datos);
  await uploadFile(key, buffer, 'application/pdf');

  await query(
    `INSERT INTO proyecto_reporte_pdfs (reporte_id, version, r2_key)
     VALUES ($1, $2, $3)
     ON CONFLICT (reporte_id, version) DO NOTHING`,
    [reporteId, version, key],
  );

  return { buffer, version, key };
}

// GET /api/proyecto-reportes/:proyectoId/:id/pdf
//
// Se genera al vuelo, como hace la pantalla de las solicitudes. Lo archivado
// es para poder demostrar que decia lo que salio por correo, no para mostrar.
router.get(
  '/:proyectoId/:id/pdf',
  authenticateToken,
  checkPermission('reportes'),
  checkProjectAccess('proyectoId'),
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const existe = await query(
      `SELECT 1 FROM proyecto_reportes
        WHERE id = $1 AND proyecto_id = $2 AND activo = true`,
      [req.params.id, req.params.proyectoId],
    );
    if (existe.rows.length === 0) {
      res.status(404).json({ success: false, message: 'Reporte no encontrado' });
      return;
    }

    const datos = await buildReportePdfInput(Number(req.params.id));
    if (!datos) {
      res.status(404).json({ success: false, message: 'Reporte no encontrado' });
      return;
    }

    const pdf = await generateReportePDF(datos);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${datos.numero}.pdf"`,
    });
    res.send(pdf);
  }),
);

// ---------------------------------------------------------------------------
// Envío por correo
// ---------------------------------------------------------------------------

/** A dónde va el reporte. Configurable sin tocar código ni desplegar. */
const CORREO_ADMINISTRACION =
  process.env.REPORTES_EMAIL_TO || 'info@pinellaspanama.com';

// POST /api/proyecto-reportes/:proyectoId/:id/emitir
//
// El correo NO sale al guardar: el reporte se guarda primero y las fotos
// suben despues, asi que mandarlo de una lo enviaria sin fotos, que es
// justamente lo que no podia hacer el Google Form. La pantalla llama aqui
// cuando termino de subir la ultima foto.
//
// Si el ingeniero cierra el navegador a media subida, el reporte queda
// guardado con enviado_at en null y la pantalla le ofrece mandarlo.
router.post(
  '/:proyectoId/:id/emitir',
  authenticateToken,
  checkPermission('reportes'),
  checkProjectAccess('proyectoId'),
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const reporte = await query<{ creado_por: number; enviado_at: Date | null }>(
      `SELECT creado_por, enviado_at FROM proyecto_reportes
        WHERE id = $1 AND proyecto_id = $2 AND activo = true`,
      [req.params.id, req.params.proyectoId],
    );
    if (reporte.rows.length === 0) {
      res.status(404).json({ success: false, message: 'Reporte no encontrado' });
      return;
    }
    if (!puedeCorregir(req, reporte.rows[0].creado_por)) {
      res.status(403).json({
        success: false,
        message: 'Solo quien escribió el reporte puede enviarlo',
      });
      return;
    }

    // Sin reenviar=true no se manda dos veces: la pantalla llama a este
    // endpoint al terminar de subir fotos, y un reintento del navegador no
    // debe llenar de copias la bandeja de nadie.
    const yaEnviado = reporte.rows[0].enviado_at !== null;
    if (yaEnviado && req.query.reenviar !== 'true') {
      res.json({
        success: true,
        data: { enviado_at: reporte.rows[0].enviado_at, reenviado: false },
      });
      return;
    }

    const archivado = await archivarReportePdf(Number(req.params.id));
    if (!archivado) {
      res.status(404).json({ success: false, message: 'Reporte no encontrado' });
      return;
    }

    const datos = await buildReportePdfInput(Number(req.params.id));
    const destinatarios = [CORREO_ADMINISTRACION];
    if (datos?.autorEmail && !destinatarios.includes(datos.autorEmail)) {
      destinatarios.push(datos.autorEmail);
    }

    await sendEmail(
      destinatarios,
      `Reporte diario ${datos!.numero} — ${datos!.proyectoNombre}`,
      `<p>Se registró el reporte diario del <b>${datos!.fechaCorta}</b> en
         <b>${datos!.proyectoNombre}</b>, elaborado por ${datos!.autorNombre}.</p>
       <p>El PDF va adjunto.</p>`,
      [{ filename: `${datos!.numero}.pdf`, content: archivado.buffer }],
    );

    const marcado = await query<{ enviado_at: Date }>(
      `UPDATE proyecto_reportes SET enviado_at = CURRENT_TIMESTAMP
        WHERE id = $1 RETURNING enviado_at`,
      [req.params.id],
    );

    await registrarAudit(
      req.user!.id,
      'enviar',
      'reporte_diario',
      Number(req.params.id),
      { destinatarios, version: archivado.version, reenvio: yaEnviado },
    );

    res.json({
      success: true,
      data: {
        enviado_at: marcado.rows[0].enviado_at,
        reenviado: yaEnviado,
        destinatarios,
        version: archivado.version,
      },
    });
  }),
);

// ---------------------------------------------------------------------------
// Fotos
// ---------------------------------------------------------------------------

/** El reporte con lo necesario para armar la clave de R2, o null. */
async function reporteParaFotos(
  reporteId: string,
  proyectoId: string,
): Promise<{ creado_por: number; numero: string; proyecto_corto: string } | null> {
  const r = await query<{
    creado_por: number;
    numero: string;
    proyecto_corto: string;
  }>(
    `SELECT r.creado_por, r.numero,
            COALESCE(p.nombre_corto, p.nombre) AS proyecto_corto
       FROM proyecto_reportes r
       JOIN proyectos p ON p.id = r.proyecto_id
      WHERE r.id = $1 AND r.proyecto_id = $2 AND r.activo = true`,
    [reporteId, proyectoId],
  );
  return r.rows[0] ?? null;
}

// POST /api/proyecto-reportes/:proyectoId/:id/fotos
router.post(
  '/:proyectoId/:id/fotos',
  authenticateToken,
  checkPermission('reportes'),
  checkProjectAccess('proyectoId'),
  subirFotos,
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (files.length === 0) {
      res.status(400).json({ success: false, message: 'No se recibió ninguna foto' });
      return;
    }

    const reporte = await reporteParaFotos(req.params.id, req.params.proyectoId);
    if (!reporte) {
      res.status(404).json({ success: false, message: 'Reporte no encontrado' });
      return;
    }
    if (!puedeCorregir(req, reporte.creado_por)) {
      res.status(403).json({
        success: false,
        message: 'Solo quien escribió el reporte puede agregarle fotos',
      });
      return;
    }

    const desde = await query<{ next: number }>(
      `SELECT COALESCE(MAX(orden), 0) + 1 AS next
         FROM proyecto_reporte_fotos WHERE reporte_id = $1`,
      [req.params.id],
    );

    const guardadas = [];
    let orden = desde.rows[0].next;
    for (const file of files) {
      const key = claveFoto(reporte.proyecto_corto, reporte.numero, file.originalname);
      // Primero R2 y despues la base: si la subida falla, no queda una fila
      // apuntando a un archivo que no existe.
      await uploadFile(key, file.buffer, file.mimetype);
      const row = await query<{
        id: number;
        nombre_archivo: string;
        r2_key: string;
        tipo_mime: string | null;
        tamano: number | null;
        orden: number;
      }>(
        `INSERT INTO proyecto_reporte_fotos
           (reporte_id, nombre_archivo, r2_key, tipo_mime, tamano, orden, creado_por)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING id, nombre_archivo, r2_key, tipo_mime, tamano, orden`,
        [
          req.params.id,
          file.originalname,
          key,
          file.mimetype,
          file.size,
          orden++,
          req.user!.id,
        ],
      );
      guardadas.push({
        ...row.rows[0],
        url: await getFileSignedUrl(key, 900),
      });
    }

    await registrarAudit(
      req.user!.id,
      'editar',
      'reporte_diario',
      Number(req.params.id),
      { fotos_agregadas: guardadas.map((f) => f.nombre_archivo) },
    );

    res.status(201).json({ success: true, data: guardadas });
  }),
);

// DELETE /api/proyecto-reportes/:proyectoId/:id/fotos/:fotoId
router.delete(
  '/:proyectoId/:id/fotos/:fotoId',
  authenticateToken,
  checkPermission('reportes'),
  checkProjectAccess('proyectoId'),
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const foto = await query<{
      r2_key: string;
      nombre_archivo: string;
      creado_por: number;
    }>(
      `SELECT f.r2_key, f.nombre_archivo, r.creado_por
         FROM proyecto_reporte_fotos f
         JOIN proyecto_reportes r ON r.id = f.reporte_id
        WHERE f.id = $1 AND f.reporte_id = $2 AND r.proyecto_id = $3
          AND r.activo = true`,
      [req.params.fotoId, req.params.id, req.params.proyectoId],
    );
    if (foto.rows.length === 0) {
      res.status(404).json({ success: false, message: 'Foto no encontrada' });
      return;
    }
    if (!puedeCorregir(req, foto.rows[0].creado_por)) {
      res.status(403).json({
        success: false,
        message: 'Solo quien escribió el reporte puede quitarle fotos',
      });
      return;
    }

    // Primero la fila y despues R2: si el borrado en R2 falla, queda un
    // archivo huerfano, que es mucho menos grave que una foto que la pantalla
    // lista pero no puede mostrar.
    await query('DELETE FROM proyecto_reporte_fotos WHERE id = $1', [
      req.params.fotoId,
    ]);
    await deleteFile(foto.rows[0].r2_key);

    await registrarAudit(
      req.user!.id,
      'editar',
      'reporte_diario',
      Number(req.params.id),
      { foto_eliminada: foto.rows[0].nombre_archivo },
    );

    res.json({ success: true });
  }),
);

export default router;
