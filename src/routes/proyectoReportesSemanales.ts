/**
 * El reporte semanal de obra.
 *
 * Lo escribe el mismo ingeniero que manda los diarios y lleva lo que el diario
 * no tiene: el resumen de la semana, cómo quedaron las metas que se planearon,
 * los problemas con su acción a tomar, el plan de la próxima semana y las
 * decisiones que hacen falta. Los números —personal, equipo, materiales, pagos
 * y la comparación con la semana anterior— salen solos de los diarios y de las
 * solicitudes pagadas (services/reporteSemanalDatos.ts).
 *
 * Igual que el diario, nace BORRADOR: sin número y con `completo = false`.
 * Hasta que /emitir lo completa no existe para nadie, y al completarse se
 * congelan sus números en `datos` y la semana queda cerrada para los diarios
 * (services/semanaCerrada.ts).
 *
 * Hay UN reporte por proyecto y semana: volver a «Nuevo reporte semanal» de una
 * semana empezada sigue el mismo borrador en vez de abrir otro.
 */

import { Router, Request, Response } from 'express';
import { query, pool } from '../database/config.js';
import { getFileSignedUrl } from '../services/storage.js';
import {
  authenticateToken,
  checkPermission,
  checkProjectAccess,
  requireAdmin,
} from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import {
  construirNumeroSemanal,
  diasDeLaSemana,
  domingoDe,
  lunesDe,
  semanaIso,
} from '../services/reporteSemana.js';
import { datosDeLaSemana, type DatosSemana } from '../services/reporteSemanalDatos.js';
import { encolarEnvio } from '../services/reporteEnvio.js';
import { archivarSemanalPdf, buildSemanalPdfInput } from '../services/reporteSemanalEnvio.js';
import { generateReporteSemanalPDF } from '../services/reporteSemanalPdf.js';
import { downloadFile } from '../services/storage.js';
import { registrarAudit } from '../services/auditLog.js';

const router = Router();

/** Tope de fotos del reporte semanal. Lo pidió Ivan: «digamos que 15». */
export const FOTOS_MAX = 15;

const ESTADOS = ['completada', 'parcial', 'no_completada'] as const;
type Estado = (typeof ESTADOS)[number];

interface SemanalRow {
  id: number;
  proyecto_id: number;
  numero: string | null;
  semana_inicio: Date;
  semana_fin: Date;
  anio_iso: number;
  semana_iso: number;
  resumen: string | null;
  lo_que_se_espera: string | null;
  datos: DatosSemana | null;
  completo: boolean;
  enviado_at: Date | null;
  creado_por: number;
}

interface MetaBody {
  id?: number;
  /** La escribió este reporte al marcar la semana; no venía de ningún plan. */
  fuera_del_plan?: boolean;
  texto?: string;
  cantidad?: number | string | null;
  unidad?: string | null;
  estado?: Estado | null;
  cantidad_hecha?: number | string | null;
  porcentaje?: number | string | null;
  motivo?: string | null;
}

interface SemanalBody {
  resumen?: string | null;
  lo_que_se_espera?: string | null;
  /** Las metas que vienen de la semana pasada, ya marcadas. */
  metas_evaluadas?: MetaBody[];
  /** Las metas nuevas del plan de la próxima semana. */
  metas_plan?: MetaBody[];
  problemas?: { fecha?: string | null; problema?: string; accion?: string | null }[];
  decisiones?: { texto?: string }[];
  /** Los ids de las fotos elegidas, en el orden en que van. */
  fotos?: number[];
}

const ymd = (f: Date | string): string => {
  if (f instanceof Date) {
    const y = f.getFullYear();
    const m = String(f.getMonth() + 1).padStart(2, '0');
    const d = String(f.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(f).slice(0, 10);
};

const numeroONull = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const textoONull = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s === '' ? null : s;
};

/** Solo quien lo escribió, o un admin, lo toca. Igual que el diario. */
function puedeTocar(req: Request, creadoPor: number): boolean {
  const u = req.user!;
  return u.id === creadoPor || u.rol === 'admin' || u.rol === 'co-admin';
}

async function leerSemanal(
  proyectoId: number,
  id: number | string,
): Promise<SemanalRow | null> {
  const r = await query<SemanalRow>(
    `SELECT * FROM proyecto_reportes_semanales
      WHERE id = $1 AND proyecto_id = $2 AND activo = true`,
    [id, proyectoId],
  );
  return r.rows[0] ?? null;
}

/**
 * Las metas de un reporte: las que le tocaba marcar y las que dejó planeadas.
 *
 * Las que marca son las del plan del reporte ANTERIOR más las que él mismo
 * agregó fuera del plan. Se ordenan verde, amarillo, rojo y las sin marcar al
 * final, que es el orden en que salen en el papel.
 */
async function leerMetas(reporteId: number) {
  const evaluadas = await query(
    `SELECT id, texto, cantidad, unidad, estado, cantidad_hecha, porcentaje, motivo,
            orden, (reporte_plan_id IS NULL) AS fuera_del_plan
       FROM proyecto_reporte_semanal_metas
      WHERE reporte_evaluacion_id = $1
      ORDER BY CASE estado
                 WHEN 'completada' THEN 1
                 WHEN 'parcial' THEN 2
                 WHEN 'no_completada' THEN 3
                 ELSE 4 END,
               orden, id`,
    [reporteId],
  );
  const plan = await query(
    `SELECT id, texto, cantidad, unidad, orden
       FROM proyecto_reporte_semanal_metas
      WHERE reporte_plan_id = $1
      ORDER BY orden, id`,
    [reporteId],
  );
  return { evaluadas: evaluadas.rows, plan: plan.rows };
}

/**
 * Las metas que le tocan a un reporte nuevo: las del plan del último semanal
 * completo de ese proyecto, sea de la semana pasada o de hace tres.
 *
 * Se les pone `reporte_evaluacion_id` para que salgan en ESTE reporte. Si el
 * proyecto no tiene ningún semanal anterior —el primero de todos—, no hay
 * metas que marcar y la sección no aparece.
 */
async function heredarMetas(proyectoId: number, reporteId: number): Promise<void> {
  await query(
    `UPDATE proyecto_reporte_semanal_metas m
        SET reporte_evaluacion_id = $2, updated_at = CURRENT_TIMESTAMP
      WHERE m.reporte_evaluacion_id IS NULL
        AND m.reporte_plan_id = (
          SELECT s.id FROM proyecto_reportes_semanales s
           WHERE s.proyecto_id = $1 AND s.activo = true AND s.completo = true
             AND s.id <> $2
           ORDER BY s.semana_inicio DESC
           LIMIT 1
        )`,
    [proyectoId, reporteId],
  );
}

/** Las fotos de los diarios de esa semana, agrupadas por día. */
async function fotosDeLaSemana(proyectoId: number, lunes: string) {
  const fotos = await query<{
    id: number; fecha: Date; leyenda: string | null; r2_key: string;
    nombre_archivo: string; numero_diario: string;
  }>(
    `SELECT f.id, r.fecha, f.leyenda, f.r2_key, f.nombre_archivo, r.numero AS numero_diario
       FROM proyecto_reporte_fotos f
       JOIN proyecto_reportes r ON r.id = f.reporte_id
      WHERE r.proyecto_id = $1 AND r.activo = true AND r.completo = true
        AND r.fecha BETWEEN $2::date AND $2::date + 6
      ORDER BY r.fecha, f.orden, f.id`,
    [proyectoId, lunes],
  );
  // Las direcciones de R2 se firman al vuelo y vencen; nunca se guardan.
  return Promise.all(
    fotos.rows.map(async (f) => ({
      id: f.id,
      fecha: ymd(f.fecha),
      leyenda: f.leyenda,
      nombre_archivo: f.nombre_archivo,
      numero_diario: f.numero_diario,
      url: await getFileSignedUrl(f.r2_key, 900),
    })),
  );
}

// GET /api/proyecto-reportes-semanales/:proyectoId
//
// La lista. Solo los completos: un borrador no existe para nadie más que para
// quien lo está escribiendo.
router.get(
  '/:proyectoId',
  authenticateToken,
  checkPermission('reportes'),
  checkProjectAccess('proyectoId'),
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const filas = await query(
      `SELECT s.id, s.numero, s.semana_inicio, s.semana_fin, s.anio_iso, s.semana_iso,
              s.enviado_at, s.creado_por, u.nombre AS creador_nombre,
              COUNT(*) FILTER (WHERE m.estado = 'completada')::int AS metas_completadas,
              COUNT(*) FILTER (WHERE m.estado = 'parcial')::int AS metas_parciales,
              COUNT(*) FILTER (WHERE m.estado = 'no_completada')::int AS metas_no_completadas,
              COUNT(m.id)::int AS metas
         FROM proyecto_reportes_semanales s
         JOIN users u ON u.id = s.creado_por
         LEFT JOIN proyecto_reporte_semanal_metas m ON m.reporte_evaluacion_id = s.id
        WHERE s.proyecto_id = $1 AND s.activo = true AND s.completo = true
        GROUP BY s.id, u.nombre
        ORDER BY s.semana_inicio DESC`,
      [req.params.proyectoId],
    );
    res.json({
      success: true,
      data: filas.rows.map((f) => ({
        ...f,
        semana_inicio: ymd(f.semana_inicio as Date),
        semana_fin: ymd(f.semana_fin as Date),
      })),
    });
  }),
);

// GET /api/proyecto-reportes-semanales/:proyectoId/semanas
//
// Las semanas que se pueden reportar: las que tienen algún reporte diario y
// todavía no tienen semanal. La primera de la lista es la que la pantalla abre
// sola, y por eso van de la más reciente a la más vieja. Si hay un borrador
// empezado, viene marcado: esa semana se sigue, no se empieza otra.
router.get(
  '/:proyectoId/semanas',
  authenticateToken,
  checkPermission('reportes'),
  checkProjectAccess('proyectoId'),
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const proyectoId = Number(req.params.proyectoId);
    const filas = await query<{
      semana_inicio: Date; diarios: number; borrador_id: number | null; completo: boolean | null;
    }>(
      `WITH semanas AS (
         SELECT date_trunc('week', r.fecha)::date AS semana_inicio,
                COUNT(*)::int AS diarios
           FROM proyecto_reportes r
          WHERE r.proyecto_id = $1 AND r.activo = true AND r.completo = true
          GROUP BY 1
       )
       SELECT sm.semana_inicio, sm.diarios, s.id AS borrador_id, s.completo
         FROM semanas sm
         LEFT JOIN proyecto_reportes_semanales s
                ON s.proyecto_id = $1 AND s.activo = true
               AND s.semana_inicio = sm.semana_inicio
        WHERE s.id IS NULL OR s.completo = false
        ORDER BY sm.semana_inicio DESC
        LIMIT 12`,
      [proyectoId],
    );

    res.json({
      success: true,
      data: filas.rows.map((f) => {
        const inicio = ymd(f.semana_inicio);
        const iso = semanaIso(inicio);
        return {
          semana_inicio: inicio,
          semana_fin: domingoDe(inicio),
          anio_iso: iso.anio,
          semana_iso: iso.semana,
          diarios: f.diarios,
          borrador_id: f.borrador_id,
        };
      }),
    });
  }),
);

// POST /api/proyecto-reportes-semanales/:proyectoId
//
// Empieza —o sigue— el reporte de una semana. `fecha` puede ser cualquier día
// de esa semana; lo que manda es su lunes.
router.post(
  '/:proyectoId',
  authenticateToken,
  checkPermission('reportes'),
  checkProjectAccess('proyectoId'),
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const proyectoId = Number(req.params.proyectoId);
    const fecha = (req.body as { fecha?: string }).fecha;
    let lunes: string;
    try {
      lunes = lunesDe(String(fecha ?? ''));
    } catch {
      res.status(400).json({ success: false, message: 'Falta la semana del reporte' });
      return;
    }

    // El numero se asigna al enviar, pero el proyecto sin codigo no podria
    // numerarlo nunca: mejor decirlo antes de que escriba el reporte entero.
    const proyecto = await query<{ sp_prefijo: string | null }>(
      'SELECT sp_prefijo FROM proyectos WHERE id = $1',
      [proyectoId],
    );
    if (!proyecto.rows[0]?.sp_prefijo) {
      res.status(400).json({
        success: false,
        message: 'El proyecto no tiene código configurado, y sin él no se puede numerar el reporte',
      });
      return;
    }

    const existente = await query<SemanalRow>(
      `SELECT * FROM proyecto_reportes_semanales
        WHERE proyecto_id = $1 AND semana_inicio = $2 AND activo = true`,
      [proyectoId, lunes],
    );
    if (existente.rows.length > 0) {
      const r = existente.rows[0];
      if (r.completo) {
        res.status(409).json({
          success: false,
          message: `La semana ${r.semana_iso} de ${r.anio_iso} ya tiene su reporte semanal (${r.numero})`,
        });
        return;
      }
      // Su borrador: se sigue el mismo, no se abre otro.
      res.json({ success: true, data: { id: r.id, seguido: true } });
      return;
    }

    const iso = semanaIso(lunes);
    const creado = await query<SemanalRow>(
      `INSERT INTO proyecto_reportes_semanales
         (proyecto_id, semana_inicio, semana_fin, anio_iso, semana_iso, creado_por)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [proyectoId, lunes, domingoDe(lunes), iso.anio, iso.semana, req.user!.id],
    );
    const reporte = creado.rows[0];

    await heredarMetas(proyectoId, reporte.id);

    await registrarAudit(req.user!.id, 'crear', 'reporte_semanal', reporte.id, {
      proyecto_id: proyectoId,
      semana: `${iso.anio}-S${iso.semana}`,
      borrador: true,
    });

    res.status(201).json({ success: true, data: { id: reporte.id, seguido: false } });
  }),
);

// GET /api/proyecto-reportes-semanales/:proyectoId/:id
//
// El reporte entero. Mientras es borrador, los números se calculan al vuelo y
// viajan también las fotos de la semana para poder elegirlas; una vez enviado,
// los números son los que se congelaron y las fotos, las que quedaron.
router.get(
  '/:proyectoId/:id',
  authenticateToken,
  checkPermission('reportes'),
  checkProjectAccess('proyectoId'),
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const proyectoId = Number(req.params.proyectoId);
    const reporte = await leerSemanal(proyectoId, req.params.id);
    if (!reporte) {
      res.status(404).json({ success: false, message: 'Reporte no encontrado' });
      return;
    }
    if (!reporte.completo && !puedeTocar(req, reporte.creado_por)) {
      res.status(403).json({ success: false, message: 'Reporte no encontrado' });
      return;
    }

    const lunes = ymd(reporte.semana_inicio);
    const [metas, problemas, decisiones, elegidas, datos] = await Promise.all([
      leerMetas(reporte.id),
      query(
        `SELECT id, fecha, problema, accion, orden
           FROM proyecto_reporte_semanal_problemas
          WHERE reporte_id = $1 ORDER BY orden, id`,
        [reporte.id],
      ),
      query(
        `SELECT id, texto, orden
           FROM proyecto_reporte_semanal_decisiones
          WHERE reporte_id = $1 ORDER BY orden, id`,
        [reporte.id],
      ),
      query<{ foto_id: number; orden: number }>(
        `SELECT foto_id, orden FROM proyecto_reporte_semanal_fotos
          WHERE reporte_id = $1 ORDER BY orden, id`,
        [reporte.id],
      ),
      reporte.completo && reporte.datos
        ? Promise.resolve(reporte.datos)
        : datosDeLaSemana(proyectoId, lunes),
    ]);

    const fotos = await fotosDeLaSemana(proyectoId, lunes);
    const elegidasIds = elegidas.rows.map((f) => f.foto_id);

    res.json({
      success: true,
      data: {
        id: reporte.id,
        numero: reporte.numero,
        semana_inicio: lunes,
        semana_fin: ymd(reporte.semana_fin),
        anio_iso: reporte.anio_iso,
        semana_iso: reporte.semana_iso,
        resumen: reporte.resumen,
        lo_que_se_espera: reporte.lo_que_se_espera,
        completo: reporte.completo,
        enviado_at: reporte.enviado_at,
        creado_por: reporte.creado_por,
        datos,
        metas: metas.evaluadas,
        metas_plan: metas.plan,
        problemas: problemas.rows.map((p) => ({
          ...p,
          fecha: p.fecha ? ymd(p.fecha as Date) : null,
        })),
        decisiones: decisiones.rows,
        // Las elegidas, en su orden, y todas las de la semana para poder
        // cambiarlas mientras sea borrador.
        fotos_elegidas: elegidasIds,
        fotos: reporte.completo
          ? fotos.filter((f) => elegidasIds.includes(f.id))
              .sort((a, b) => elegidasIds.indexOf(a.id) - elegidasIds.indexOf(b.id))
          : fotos,
        dias: diasDeLaSemana(lunes),
      },
    });
  }),
);

// PUT /api/proyecto-reportes-semanales/:proyectoId/:id
//
// Guarda lo escrito. Se construye solo con lo que venga en el cuerpo: lo que no
// llega, no se toca (regla del proyecto para todo PUT).
router.put(
  '/:proyectoId/:id',
  authenticateToken,
  checkPermission('reportes'),
  checkProjectAccess('proyectoId'),
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const proyectoId = Number(req.params.proyectoId);
    const body = req.body as SemanalBody;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const actual = await client.query<SemanalRow>(
        `SELECT * FROM proyecto_reportes_semanales
          WHERE id = $1 AND proyecto_id = $2 AND activo = true
          FOR UPDATE`,
        [req.params.id, proyectoId],
      );
      if (actual.rows.length === 0) {
        await client.query('ROLLBACK');
        res.status(404).json({ success: false, message: 'Reporte no encontrado' });
        return;
      }
      const reporte = actual.rows[0];
      if (!puedeTocar(req, reporte.creado_por)) {
        await client.query('ROLLBACK');
        res.status(403).json({
          success: false,
          message: 'Solo quien escribió el reporte puede cambiarlo',
        });
        return;
      }

      if (body.fotos !== undefined && body.fotos.length > FOTOS_MAX) {
        await client.query('ROLLBACK');
        res.status(400).json({
          success: false,
          message: `El reporte semanal lleva hasta ${FOTOS_MAX} fotos`,
        });
        return;
      }

      const campos: string[] = [];
      const valores: unknown[] = [];
      if (body.resumen !== undefined) {
        campos.push(`resumen = $${campos.length + 1}`);
        valores.push(textoONull(body.resumen));
      }
      if (body.lo_que_se_espera !== undefined) {
        campos.push(`lo_que_se_espera = $${campos.length + 1}`);
        valores.push(textoONull(body.lo_que_se_espera));
      }
      if (campos.length > 0) {
        valores.push(reporte.id);
        await client.query(
          `UPDATE proyecto_reportes_semanales
              SET ${campos.join(', ')}, updated_at = CURRENT_TIMESTAMP
            WHERE id = $${valores.length}`,
          valores,
        );
      }

      // Las metas que venían de la semana pasada: solo se marcan, no se
      // reescriben. Su texto y su cantidad son del reporte que las planeó.
      //
      // Las «fuera del plan» son otra cosa: las escribe este reporte, así que
      // se borran y se reescriben enteras, como las demás listas. Se reconocen
      // por su bandera y no por no traer id, porque al guardar por segunda vez
      // ya tienen uno.
      if (body.metas_evaluadas !== undefined) {
        await client.query(
          `DELETE FROM proyecto_reporte_semanal_metas
            WHERE reporte_evaluacion_id = $1 AND reporte_plan_id IS NULL`,
          [reporte.id],
        );
        let orden = 0;
        for (const m of body.metas_evaluadas) {
          const estado = ESTADOS.includes(m.estado as Estado) ? (m.estado as Estado) : null;
          const cantidadHecha = estado === 'parcial' ? numeroONull(m.cantidad_hecha) : null;
          const porcentaje = estado === 'parcial' ? numeroONull(m.porcentaje) : null;
          const motivo = estado === 'completada' ? null : textoONull(m.motivo);

          if (m.fuera_del_plan) {
            const texto = textoONull(m.texto);
            if (!texto) continue;
            await client.query(
              `INSERT INTO proyecto_reporte_semanal_metas
                 (reporte_evaluacion_id, texto, cantidad, unidad, estado,
                  cantidad_hecha, porcentaje, motivo, orden)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
              [
                reporte.id, texto.slice(0, 300), numeroONull(m.cantidad), textoONull(m.unidad),
                estado, cantidadHecha, porcentaje, motivo, orden,
              ],
            );
          } else {
            await client.query(
              `UPDATE proyecto_reporte_semanal_metas
                  SET estado = $1, cantidad_hecha = $2, porcentaje = $3, motivo = $4,
                      updated_at = CURRENT_TIMESTAMP
                WHERE id = $5 AND reporte_evaluacion_id = $6`,
              [estado, cantidadHecha, porcentaje, motivo, m.id, reporte.id],
            );
          }
          orden += 1;
        }
      }

      // El plan de la próxima semana y las metas fuera del plan se guardan
      // borrando y reescribiendo, como las filas del diario: la pantalla manda
      // la lista entera y el orden es el que trae.
      if (body.metas_plan !== undefined) {
        await client.query(
          'DELETE FROM proyecto_reporte_semanal_metas WHERE reporte_plan_id = $1',
          [reporte.id],
        );
        let orden = 0;
        for (const m of body.metas_plan) {
          const texto = textoONull(m.texto);
          if (!texto) continue;
          await client.query(
            `INSERT INTO proyecto_reporte_semanal_metas
               (reporte_plan_id, texto, cantidad, unidad, orden)
             VALUES ($1, $2, $3, $4, $5)`,
            [reporte.id, texto.slice(0, 300), numeroONull(m.cantidad), textoONull(m.unidad), orden],
          );
          orden += 1;
        }
      }

      if (body.problemas !== undefined) {
        await client.query(
          'DELETE FROM proyecto_reporte_semanal_problemas WHERE reporte_id = $1',
          [reporte.id],
        );
        let orden = 0;
        for (const p of body.problemas) {
          const texto = textoONull(p.problema);
          if (!texto) continue;
          await client.query(
            `INSERT INTO proyecto_reporte_semanal_problemas
               (reporte_id, fecha, problema, accion, orden)
             VALUES ($1, $2, $3, $4, $5)`,
            [reporte.id, p.fecha || null, texto, textoONull(p.accion), orden],
          );
          orden += 1;
        }
      }

      if (body.decisiones !== undefined) {
        await client.query(
          'DELETE FROM proyecto_reporte_semanal_decisiones WHERE reporte_id = $1',
          [reporte.id],
        );
        let orden = 0;
        for (const d of body.decisiones) {
          const texto = textoONull(d.texto);
          if (!texto) continue;
          await client.query(
            `INSERT INTO proyecto_reporte_semanal_decisiones (reporte_id, texto, orden)
             VALUES ($1, $2, $3)`,
            [reporte.id, texto, orden],
          );
          orden += 1;
        }
      }

      if (body.fotos !== undefined) {
        await client.query(
          'DELETE FROM proyecto_reporte_semanal_fotos WHERE reporte_id = $1',
          [reporte.id],
        );
        let orden = 0;
        for (const fotoId of body.fotos) {
          // Solo fotos de los diarios de ESA semana y de ESE proyecto: un id de
          // otra obra colaría una foto ajena en el reporte.
          await client.query(
            `INSERT INTO proyecto_reporte_semanal_fotos (reporte_id, foto_id, orden)
             SELECT $1, f.id, $2
               FROM proyecto_reporte_fotos f
               JOIN proyecto_reportes r ON r.id = f.reporte_id
              WHERE f.id = $3 AND r.proyecto_id = $4 AND r.activo = true
                AND r.fecha BETWEEN $5::date AND $5::date + 6
             ON CONFLICT DO NOTHING`,
            [reporte.id, orden, fotoId, proyectoId, ymd(reporte.semana_inicio)],
          );
          orden += 1;
        }
      }

      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    res.json({ success: true });
  }),
);

// POST /api/proyecto-reportes-semanales/:proyectoId/:id/emitir
//
// El borrador pasa a ser reporte: se le pone número, se congelan sus números y
// la semana queda cerrada para los diarios.
router.post(
  '/:proyectoId/:id/emitir',
  authenticateToken,
  checkPermission('reportes'),
  checkProjectAccess('proyectoId'),
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const proyectoId = Number(req.params.proyectoId);
    const reporte = await leerSemanal(proyectoId, req.params.id);
    if (!reporte) {
      res.status(404).json({ success: false, message: 'Reporte no encontrado' });
      return;
    }
    if (!puedeTocar(req, reporte.creado_por)) {
      res.status(403).json({
        success: false,
        message: 'Solo quien escribió el reporte puede enviarlo',
      });
      return;
    }
    if (reporte.completo) {
      res.json({ success: true, data: { numero: reporte.numero, reenviado: false } });
      return;
    }

    if (!textoONull(reporte.resumen)) {
      res.status(400).json({
        success: false,
        message: 'Falta el resumen de la semana',
      });
      return;
    }

    const proyecto = await query<{ sp_prefijo: string | null }>(
      'SELECT sp_prefijo FROM proyectos WHERE id = $1',
      [proyectoId],
    );
    let numero: string;
    try {
      numero = construirNumeroSemanal(
        proyecto.rows[0]?.sp_prefijo ?? '',
        ymd(reporte.semana_inicio),
      );
    } catch {
      res.status(400).json({
        success: false,
        message: 'El proyecto no tiene código configurado, y sin él no se puede numerar el reporte',
      });
      return;
    }

    // Los números se congelan aquí: a partir de ahora el reporte dice lo que
    // dijo al salir, aunque después se corrija un diario.
    const datos = await datosDeLaSemana(proyectoId, ymd(reporte.semana_inicio));

    const completado = await query<{ id: number }>(
      `UPDATE proyecto_reportes_semanales
          SET numero = $1, datos = $2, completo = true,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = $3 AND completo = false
        RETURNING id`,
      [numero, JSON.stringify(datos), reporte.id],
    );
    if (completado.rows.length === 0) {
      // Otra llamada lo completó mientras tanto.
      const ya = await leerSemanal(proyectoId, req.params.id);
      res.json({ success: true, data: { numero: ya?.numero ?? numero, reenviado: false } });
      return;
    }

    // El correo es asunto del sistema, no del ingeniero: se encola y el cron lo
    // manda con su PDF, reintentando si hace falta.
    await encolarEnvio(reporte.id, 'semanal');

    await registrarAudit(req.user!.id, 'crear', 'reporte_semanal', reporte.id, {
      proyecto_id: proyectoId,
      numero,
      semana: `${reporte.anio_iso}-S${reporte.semana_iso}`,
    });

    res.json({ success: true, data: { numero, reenviado: false } });
  }),
);

// GET /api/proyecto-reportes-semanales/:proyectoId/:id/pdf
//
// El PDF. Si el reporte ya salió, se devuelve la ÚLTIMA versión archivada —la
// misma que está en la bandeja de quien lo recibió—; de un borrador se arma al
// vuelo, para poder mirar cómo va quedando antes de enviarlo.
router.get(
  '/:proyectoId/:id/pdf',
  authenticateToken,
  checkPermission('reportes'),
  checkProjectAccess('proyectoId'),
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const proyectoId = Number(req.params.proyectoId);
    const reporte = await leerSemanal(proyectoId, req.params.id);
    if (!reporte) {
      res.status(404).json({ success: false, message: 'Reporte no encontrado' });
      return;
    }
    if (!reporte.completo && !puedeTocar(req, reporte.creado_por)) {
      res.status(404).json({ success: false, message: 'Reporte no encontrado' });
      return;
    }

    const archivado = await query<{ r2_key: string }>(
      `SELECT r2_key FROM proyecto_reporte_semanal_pdfs
        WHERE reporte_id = $1 ORDER BY version DESC LIMIT 1`,
      [reporte.id],
    );

    let pdf: Buffer | null = null;
    if (archivado.rows.length > 0) {
      // Si la copia archivada no se puede bajar, se rearma: vale más un PDF
      // que un error, aunque la copia de R2 sea la que hace fe.
      pdf = await downloadFile(archivado.rows[0].r2_key).catch(() => null);
    }
    if (!pdf) {
      const datos = await buildSemanalPdfInput(reporte.id);
      if (!datos) {
        res.status(404).json({ success: false, message: 'Reporte no encontrado' });
        return;
      }
      pdf = await generateReporteSemanalPDF(datos);
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${reporte.numero ?? 'reporte-semanal'}.pdf"`,
    );
    res.send(pdf);
  }),
);

// DELETE /api/proyecto-reportes-semanales/:proyectoId/:id
//
// Baja lógica, solo admin, como en el diario. Al quitarlo, su semana vuelve a
// quedar abierta para los reportes diarios.
router.delete(
  '/:proyectoId/:id',
  authenticateToken,
  requireAdmin,
  checkProjectAccess('proyectoId'),
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const reporte = await leerSemanal(Number(req.params.proyectoId), req.params.id);
    if (!reporte) {
      res.status(404).json({ success: false, message: 'Reporte no encontrado' });
      return;
    }
    await query(
      `UPDATE proyecto_reportes_semanales
          SET activo = false, envio_proximo_intento = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1`,
      [reporte.id],
    );
    await registrarAudit(req.user!.id, 'eliminar', 'reporte_semanal', reporte.id, {
      numero: reporte.numero,
    });
    res.json({
      success: true,
      message: `Reporte ${reporte.numero ?? 'sin enviar'} eliminado`,
    });
  }),
);

// DELETE /api/proyecto-reportes-semanales/:proyectoId/:id/borrador
//
// «Descartarlo»: quien lo escribió no quiere seguir con el borrador.
router.delete(
  '/:proyectoId/:id/borrador',
  authenticateToken,
  checkPermission('reportes'),
  checkProjectAccess('proyectoId'),
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const reporte = await leerSemanal(Number(req.params.proyectoId), req.params.id);
    if (!reporte || reporte.completo) {
      res.status(404).json({ success: false, message: 'Borrador no encontrado' });
      return;
    }
    if (!puedeTocar(req, reporte.creado_por)) {
      res.status(403).json({
        success: false,
        message: 'Solo quien lo escribió puede descartarlo',
      });
      return;
    }
    // Las metas heredadas vuelven a quedar sin marcar, para que las reciba el
    // reporte que se haga después.
    await query(
      `UPDATE proyecto_reporte_semanal_metas
          SET reporte_evaluacion_id = NULL, estado = NULL, cantidad_hecha = NULL,
              porcentaje = NULL, motivo = NULL
        WHERE reporte_evaluacion_id = $1 AND reporte_plan_id IS NOT NULL`,
      [reporte.id],
    );
    await query(
      `UPDATE proyecto_reportes_semanales
          SET activo = false, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND completo = false`,
      [reporte.id],
    );
    res.json({ success: true });
  }),
);

export default router;
