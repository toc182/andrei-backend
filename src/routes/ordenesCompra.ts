/**
 * Ordenes de compra: la compra a credito, que entra al sistema el dia que se le
 * manda la orden al proveedor y no el dia que se paga.
 *
 * Lo que manda en este archivo:
 *
 *   * SE PAGA LO QUE SE VA RECIBIENDO. El monto de la orden es lo acordado con
 *     el proveedor; la deuda es la suma de las ENTREGAS registradas. Lo que
 *     falta por retirar no se debe y no cuenta como costo.
 *   * Cada entrega lleva su propio vencimiento (su fecha + el termino de ese
 *     momento) y su propio ITBMS. Un pago se amarra a entregas concretas.
 *   * 'entrega_parcial' y 'recibida' NO se guardan: se calculan de las
 *     entregas al leer (ESTADO_CALCULADO). Asi no hay dos verdades que se
 *     puedan separar.
 *   * El sistema no le escribe al proveedor. Martina baja el PDF, lo manda y
 *     marca la orden como enviada.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { body, param, validationResult } from 'express-validator';
import multer from 'multer';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { query, pool } from '../database/config.js';
import {
  authenticateToken,
  checkPermission,
  requireRole,
} from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { deleteFile, uploadFile } from '../services/storage.js';
import { registrarAudit } from '../services/auditLog.js';
import { fixFiles } from '../utils/fileEncoding.js';

const router = Router();

/** Los estados que alguien decide. Los otros dos se calculan. */
type EstadoGuardado =
  | 'pendiente'
  | 'rechazada'
  | 'por_enviar'
  | 'enviada'
  | 'cerrada'
  | 'dada_de_baja';

interface OrdenRow {
  id: number;
  proyecto_id: number;
  numero: string;
  fecha: string;
  proveedor: string;
  proveedor_ruc: string | null;
  /** Una línea que diga de qué es la compra. Es lo que se lee en la lista. */
  descripcion: string | null;
  categoria_id: number | null;
  termino_dias: number;
  entrega: string;
  condiciones: string | null;
  subtotal: string;
  descuento: string;
  itbms_tasa: string;
  itbms: string;
  monto_total: string;
  estado: EstadoGuardado;
  codigo_verificacion: string;
  observaciones: string | null;
  creado_por: number;
  enviada_por: number | null;
  enviada_at: string | null;
  baja_motivo: string | null;
  activo: boolean;
}

interface ItemEntrada {
  cantidad?: number | string;
  unidad?: string;
  codigo?: string | null;
  descripcion: string;
  precio_unitario: number | string;
}

/**
 * El estado que ve la pantalla. Mientras la orden esta 'enviada', lo que manda
 * es lo que llego: nada -> enviada, todo -> recibida, algo -> entrega_parcial.
 * En cualquier otro estado, el guardado es el que vale.
 */
const ESTADO_CALCULADO = `
  CASE
    WHEN o.estado <> 'enviada' THEN o.estado
    WHEN COALESCE(m.recibido, 0) = 0 THEN 'enviada'
    WHEN NOT EXISTS (
      SELECT 1 FROM orden_compra_items i
      WHERE i.orden_compra_id = o.id
        AND i.cantidad > COALESCE((
          SELECT SUM(ei.cantidad)
          FROM orden_compra_entrega_items ei
          JOIN orden_compra_entregas e2 ON e2.id = ei.entrega_id AND e2.activo = true
          WHERE ei.item_id = i.id
        ), 0)
    ) THEN 'recibida'
    ELSE 'entrega_parcial'
  END`;

/**
 * Los tres numeros de dinero de una orden, todos sumados y ninguno guardado:
 *
 *   recibido  — lo que llego (con su ITBMS). Es el costo y es la deuda.
 *   pagado    — lo que ya salio del banco. Misma regla que control de costos:
 *               cuentan 'pagada' y 'facturada'; una devolucion no.
 *   reclamado — lo que ya tiene una solicitud encima, aunque todavia no se haya
 *               pagado. Es el tope para activar otra: sin esto se podria pedir
 *               dos veces la misma plata.
 */
const MONTOS = `
  LEFT JOIN LATERAL (
    SELECT
      (SELECT COALESCE(SUM(e.monto_total), 0)
         FROM orden_compra_entregas e
        WHERE e.orden_compra_id = o.id AND e.activo = true) AS recibido,
      (SELECT COALESCE(SUM(spe.monto), 0)
         FROM solicitud_pago_entregas spe
         JOIN orden_compra_entregas e ON e.id = spe.entrega_id AND e.activo = true
         JOIN solicitudes_pago sp ON sp.id = spe.solicitud_pago_id
        WHERE e.orden_compra_id = o.id AND sp.activo = true
          AND sp.estado IN ('pagada', 'facturada')) AS pagado,
      (SELECT COALESCE(SUM(spe.monto), 0)
         FROM solicitud_pago_entregas spe
         JOIN orden_compra_entregas e ON e.id = spe.entrega_id AND e.activo = true
         JOIN solicitudes_pago sp ON sp.id = spe.solicitud_pago_id
        WHERE e.orden_compra_id = o.id AND sp.activo = true
          AND sp.estado NOT IN ('rechazada', 'devolucion')) AS reclamado
  ) m ON true`;

/**
 * La cadena de firmas de la orden, para la barra de iniciales de la lista.
 *
 * Es la cadena DEL PROYECTO con lo que cada quien hizo en ESTA orden: quien no
 * ha firmado sale 'pendiente'. Igual que en las solicitudes, mientras la orden
 * espera aprobacion esto reemplaza a la pastilla de estado — decir «Pendiente»
 * no dice de quien se esta esperando.
 */
const APROBADORES = `
  LEFT JOIN LATERAL (
    SELECT COALESCE(json_agg(
             json_build_object(
               'nombre', f.nombre,
               'estado', COALESCE(f.accion, 'pendiente')
             ) ORDER BY f.orden
           ), '[]'::json) AS aprobadores_estado
    FROM (
      SELECT u.nombre, pas.orden, ap.accion
        FROM proyecto_ajustes_aprobacion pas
        JOIN users u ON u.id = pas.user_id
        LEFT JOIN orden_compra_aprobaciones ap
          ON ap.orden_compra_id = o.id AND ap.user_id = pas.user_id
       WHERE pas.proyecto_id = o.proyecto_id AND pas.activo = true
    ) f
  ) ap ON true`;

/** El vencimiento mas viejo que sigue sin pagarse, para la columna «Vence». */
const VENCE = `
  LEFT JOIN LATERAL (
    SELECT MIN(e.vence) AS vence
    FROM orden_compra_entregas e
    WHERE e.orden_compra_id = o.id AND e.activo = true
      AND e.monto_total > COALESCE((
        SELECT SUM(spe.monto)
          FROM solicitud_pago_entregas spe
          JOIN solicitudes_pago sp ON sp.id = spe.solicitud_pago_id
         WHERE spe.entrega_id = e.id AND sp.activo = true
           AND sp.estado IN ('pagada', 'facturada')
      ), 0)
  ) v ON true`;

function generateCodigoVerificacion(): string {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(8);
  let code = '';
  for (let i = 0; i < 8; i++) code += chars[bytes[i] % chars.length];
  return code;
}

/**
 * El numero de la orden: OC-<prefijo del proyecto>-NNN.
 *
 * Reusa el mismo prefijo que el proyecto ya tiene para sus solicitudes de pago,
 * porque Ivan lo pidio asi: un proyecto tiene UN codigo, no dos. Un proyecto sin
 * prefijo no puede emitir ordenes, igual que hoy no puede emitir solicitudes.
 */
async function generarNumero(
  proyectoId: number,
  client: { query: (t: string, p?: unknown[]) => Promise<{ rows: unknown[] }> },
): Promise<string> {
  const proyecto = (await client.query(
    'SELECT sp_prefijo FROM proyectos WHERE id = $1',
    [proyectoId],
  )) as { rows: { sp_prefijo: string | null }[] };
  if (proyecto.rows.length === 0) throw new Error('PROYECTO_NO_ENCONTRADO');
  const prefijo = proyecto.rows[0].sp_prefijo;
  if (!prefijo) throw new Error('PREFIJO_NO_CONFIGURADO');

  // Se cuentan tambien las dadas de baja y las inactivas: el numero es una
  // secuencia unica y reusar el de una orden retirada rompe el UNIQUE.
  const ultimo = (await client.query(
    `SELECT COALESCE(MAX(CAST(SPLIT_PART(numero, '-', 3) AS INTEGER)), 0)::text AS total
       FROM ordenes_compra WHERE proyecto_id = $1`,
    [proyectoId],
  )) as { rows: { total: string }[] };

  const siguiente = parseInt(ultimo.rows[0].total, 10) + 1;
  return `OC-${prefijo}-${String(siguiente).padStart(3, '0')}`;
}

/** Los totales de la orden, a partir de sus renglones. */
function calcularTotales(
  items: ItemEntrada[],
  descuento: number,
  itbmsTasa: number,
): {
  renglones: {
    cantidad: number;
    unidad: string;
    codigo: string | null;
    descripcion: string;
    precio_unitario: number;
    precio_total: number;
    orden: number;
  }[];
  subtotal: number;
  itbms: number;
  monto_total: number;
} {
  const renglones = items.map((it, i) => {
    const cantidad = Number(it.cantidad ?? 1);
    const precio = Number(it.precio_unitario);
    return {
      cantidad,
      unidad: it.unidad || 'unidad',
      codigo: it.codigo || null,
      descripcion: it.descripcion,
      precio_unitario: precio,
      precio_total: redondear(cantidad * precio),
      orden: i,
    };
  });
  const subtotal = redondear(renglones.reduce((s, r) => s + r.precio_total, 0));
  const base = redondear(subtotal - descuento);
  const itbms = redondear(base * itbmsTasa);
  return { renglones, subtotal, itbms, monto_total: redondear(base + itbms) };
}

const redondear = (n: number): number => Math.round(n * 100) / 100;

/** El filtro de proyectos que el usuario puede ver, igual que en solicitudes. */
function filtroProyectos(req: Request, params: unknown[]): string {
  if (req.user!.rol !== 'usuario' || req.user!.permissions?.acceso_global) {
    return '';
  }
  params.push(req.user!.id);
  return ` AND o.proyecto_id IN (SELECT proyecto_id FROM user_project_access WHERE user_id = $${params.length})`;
}

/** Que el usuario pueda tocar ESE proyecto. admin y co-admin pasan siempre. */
async function puedeElProyecto(req: Request, proyectoId: number): Promise<boolean> {
  if (req.user!.rol !== 'usuario' || req.user!.permissions?.acceso_global) {
    return true;
  }
  const r = await query(
    'SELECT 1 FROM user_project_access WHERE user_id = $1 AND proyecto_id = $2',
    [req.user!.id, proyectoId],
  );
  return r.rows.length > 0;
}

async function traerOrden(id: string | number): Promise<OrdenRow | null> {
  const r = await query<OrdenRow>(
    'SELECT * FROM ordenes_compra WHERE id = $1 AND activo = true',
    [id],
  );
  return r.rows[0] ?? null;
}

const erroresDeValidacion = (req: Request, res: Response): boolean => {
  const errores = validationResult(req);
  if (errores.isEmpty()) return false;
  res
    .status(400)
    .json({ success: false, error: errores.array()[0].msg as string });
  return true;
};

// ---------------------------------------------------------------------------
// GET /next-numero/:proyectoId — el numero que le tocaria a la proxima orden
// ---------------------------------------------------------------------------
router.get(
  '/next-numero/:proyectoId',
  authenticateToken,
  checkPermission('ordenes_ver'),
  [param('proyectoId').isInt()],
  asyncHandler(async (req: Request<{ proyectoId: string }>, res: Response) => {
    if (erroresDeValidacion(req, res)) return;
    const proyectoId = parseInt(req.params.proyectoId, 10);
    if (!(await puedeElProyecto(req, proyectoId))) {
      res.status(403).json({ success: false, error: 'Sin acceso a ese proyecto' });
      return;
    }
    try {
      const numero = await generarNumero(proyectoId, { query });
      res.json({ success: true, data: { numero } });
    } catch (err) {
      const msg = (err as Error).message;
      if (msg === 'PREFIJO_NO_CONFIGURADO') {
        res.status(400).json({
          success: false,
          error: 'Configure el prefijo del proyecto antes de crear órdenes',
        });
        return;
      }
      throw err;
    }
  }),
);

// ---------------------------------------------------------------------------
// GET / — la lista, todos los proyectos que el usuario alcanza
// ---------------------------------------------------------------------------
router.get(
  '/',
  authenticateToken,
  checkPermission('ordenes_ver'),
  asyncHandler(async (req: Request, res: Response) => {
    const params: unknown[] = [];
    let filtro = filtroProyectos(req, params);

    // La misma lista sirve para la vista consolidada y para la pestaña de UN
    // proyecto. El filtro de acceso de arriba sigue mandando: pedir un proyecto
    // que no es tuyo no te lo ensena.
    const soloProyecto = req.query.proyecto_id;
    if (soloProyecto !== undefined) {
      const n = Number(soloProyecto);
      if (!Number.isInteger(n)) {
        res.status(400).json({ success: false, error: 'Proyecto no válido' });
        return;
      }
      params.push(n);
      filtro += ` AND o.proyecto_id = $${params.length}`;
    }

    // El orden lo decidió Ivan el 01/10, igual que en las solicitudes: arriba
    // las que esperan TU firma, después las demás pendientes, luego por estado
    // en el orden de la lista de ocho, y al fondo las rechazadas y las dadas de
    // baja. Dentro de cada grupo, la más reciente primero.
    //
    // «Tu turno» se cuenta igual que en turnoDe(): el aprobador que ocupa el
    // lugar siguiente a las firmas que ya hay. Va en su propia lista de
    // parámetros porque `params` lo comparte el resumen de abajo.
    const paramsLista = [...params, req.user!.id];
    const result = await query(
      `SELECT * FROM (
         SELECT o.id, o.numero, o.fecha, o.proveedor, o.descripcion, o.monto_total, o.estado,
                o.proyecto_id, COALESCE(p.nombre_corto, p.nombre) AS proyecto_nombre,
                cg.nombre AS categoria_nombre,
                ${ESTADO_CALCULADO} AS estado_calculado,
                COALESCE(m.recibido, 0) AS recibido,
                COALESCE(m.pagado, 0) AS pagado,
                (COALESCE(m.recibido, 0) - COALESCE(m.pagado, 0)) AS por_pagar,
                v.vence, ap.aprobadores_estado,
                COALESCE(o.estado = 'pendiente' AND (
                  SELECT c.user_id
                    FROM (SELECT pas.user_id, ROW_NUMBER() OVER (ORDER BY pas.orden) AS lugar
                            FROM proyecto_ajustes_aprobacion pas
                           WHERE pas.proyecto_id = o.proyecto_id AND pas.activo = true) c
                   WHERE c.lugar = (SELECT COUNT(*) + 1 FROM orden_compra_aprobaciones oca
                                     WHERE oca.orden_compra_id = o.id)
                ) = $${paramsLista.length}, false) AS es_mi_turno
           FROM ordenes_compra o
           LEFT JOIN proyectos p ON p.id = o.proyecto_id
           LEFT JOIN categorias_gastos cg ON cg.id = o.categoria_id
           ${MONTOS}
           ${VENCE}
           ${APROBADORES}
          WHERE o.activo = true${filtro}
       ) x
       ORDER BY x.es_mi_turno DESC,
                CASE x.estado_calculado
                  WHEN 'pendiente'       THEN 1
                  WHEN 'por_enviar'      THEN 2
                  WHEN 'enviada'         THEN 3
                  WHEN 'entrega_parcial' THEN 4
                  WHEN 'recibida'        THEN 5
                  WHEN 'cerrada'         THEN 6
                  WHEN 'rechazada'       THEN 7
                  WHEN 'dada_de_baja'    THEN 8
                END,
                x.fecha DESC, x.id DESC`,
      paramsLista,
    );

    // Los tres numeros de arriba, del mismo conjunto que la lista.
    const resumen = await query(
      `SELECT
         COUNT(*) FILTER (WHERE o.estado IN ('por_enviar', 'enviada'))::int AS abiertas,
         COALESCE(SUM(COALESCE(m.recibido, 0) - COALESCE(m.pagado, 0)), 0) AS por_pagar,
         COUNT(*) FILTER (
           WHERE v.vence IS NOT NULL AND v.vence < CURRENT_DATE
         )::int AS vencidas
         FROM ordenes_compra o
         ${MONTOS}
         ${VENCE}
        WHERE o.activo = true AND o.estado <> 'rechazada'${filtro}`,
      params,
    );

    res.json({
      success: true,
      data: result.rows,
      resumen: resumen.rows[0],
    });
  }),
);

// ---------------------------------------------------------------------------
// GET /:id — la orden entera
// ---------------------------------------------------------------------------
router.get(
  '/:id',
  authenticateToken,
  checkPermission('ordenes_ver'),
  [param('id').isInt()],
  asyncHandler(async (req: Request<{ id: string }>, res: Response) => {
    if (erroresDeValidacion(req, res)) return;
    const { id } = req.params;

    const cab = await query(
      `SELECT o.*, COALESCE(p.nombre_corto, p.nombre) AS proyecto_nombre,
              cg.nombre AS categoria_nombre,
              uc.nombre AS creado_por_nombre,
              ue.nombre AS enviada_por_nombre,
              ${ESTADO_CALCULADO} AS estado_calculado,
              COALESCE(m.recibido, 0) AS recibido,
              COALESCE(m.pagado, 0) AS pagado,
              (COALESCE(m.recibido, 0) - COALESCE(m.pagado, 0)) AS por_pagar,
              (COALESCE(m.recibido, 0) - COALESCE(m.reclamado, 0)) AS disponible_para_activar,
              (o.monto_total - COALESCE(m.recibido, 0)) AS falta_por_retirar,
              v.vence
         FROM ordenes_compra o
         LEFT JOIN proyectos p ON p.id = o.proyecto_id
         LEFT JOIN categorias_gastos cg ON cg.id = o.categoria_id
         LEFT JOIN users uc ON uc.id = o.creado_por
         LEFT JOIN users ue ON ue.id = o.enviada_por
         ${MONTOS}
         ${VENCE}
        WHERE o.id = $1 AND o.activo = true`,
      [id],
    );
    if (cab.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Orden no encontrada' });
      return;
    }
    const orden = cab.rows[0] as OrdenRow & { proyecto_id: number };
    if (!(await puedeElProyecto(req, orden.proyecto_id))) {
      res.status(403).json({ success: false, error: 'Sin acceso a esa orden' });
      return;
    }

    const [items, entregas, adjuntos, aprobadores, aprobaciones, cambios, pagos] =
      await Promise.all([
        query(
          `SELECT i.*,
                  COALESCE((
                    SELECT SUM(ei.cantidad)
                      FROM orden_compra_entrega_items ei
                      JOIN orden_compra_entregas e ON e.id = ei.entrega_id AND e.activo = true
                     WHERE ei.item_id = i.id
                  ), 0) AS recibido_cantidad
             FROM orden_compra_items i
            WHERE i.orden_compra_id = $1
            ORDER BY i.orden, i.id`,
          [id],
        ),
        query(
          `SELECT e.*, u.nombre AS registrada_por_nombre,
                  COALESCE((
                    SELECT SUM(spe.monto)
                      FROM solicitud_pago_entregas spe
                      JOIN solicitudes_pago sp ON sp.id = spe.solicitud_pago_id
                     WHERE spe.entrega_id = e.id AND sp.activo = true
                       AND sp.estado IN ('pagada', 'facturada')
                  ), 0) AS pagado,
                  COALESCE((
                    SELECT SUM(spe.monto)
                      FROM solicitud_pago_entregas spe
                      JOIN solicitudes_pago sp ON sp.id = spe.solicitud_pago_id
                     WHERE spe.entrega_id = e.id AND sp.activo = true
                       AND sp.estado NOT IN ('rechazada', 'devolucion')
                  ), 0) AS reclamado
             FROM orden_compra_entregas e
             LEFT JOIN users u ON u.id = e.registrada_por
            WHERE e.orden_compra_id = $1 AND e.activo = true
            ORDER BY e.fecha, e.id`,
          [id],
        ),
        query(
          `SELECT a.*, u.nombre AS subido_por_nombre
             FROM orden_compra_adjuntos a
             LEFT JOIN users u ON u.id = a.subido_por
            WHERE a.orden_compra_id = $1
            ORDER BY a.id`,
          [id],
        ),
        query(
          `SELECT pas.user_id, pas.orden, u.nombre
             FROM proyecto_ajustes_aprobacion pas
             JOIN users u ON u.id = pas.user_id
            WHERE pas.proyecto_id = $1 AND pas.activo = true
            ORDER BY pas.orden`,
          [orden.proyecto_id],
        ),
        query(
          `SELECT ap.*, u.nombre AS usuario_nombre
             FROM orden_compra_aprobaciones ap
             LEFT JOIN users u ON u.id = ap.user_id
            WHERE ap.orden_compra_id = $1
            ORDER BY ap.orden`,
          [id],
        ),
        query(
          `SELECT c.*, u.nombre AS usuario_nombre
             FROM orden_compra_cambios c
             LEFT JOIN users u ON u.id = c.user_id
            WHERE c.orden_compra_id = $1
            ORDER BY c.created_at DESC`,
          [id],
        ),
        query(
          `SELECT sp.id, sp.numero, sp.estado, sp.fecha, SUM(spe.monto) AS monto
             FROM solicitud_pago_entregas spe
             JOIN solicitudes_pago sp ON sp.id = spe.solicitud_pago_id
             JOIN orden_compra_entregas e ON e.id = spe.entrega_id
            WHERE e.orden_compra_id = $1 AND sp.activo = true
            GROUP BY sp.id, sp.numero, sp.estado, sp.fecha
            ORDER BY sp.id`,
          [id],
        ),
      ]);

    // Que renglones llego en cada entrega.
    const entregaItems = await query(
      `SELECT ei.*, i.descripcion, i.unidad
         FROM orden_compra_entrega_items ei
         JOIN orden_compra_items i ON i.id = ei.item_id
         JOIN orden_compra_entregas e ON e.id = ei.entrega_id
        WHERE e.orden_compra_id = $1 AND e.activo = true
        ORDER BY ei.entrega_id, i.orden`,
      [id],
    );

    res.json({
      success: true,
      data: {
        ...orden,
        items: items.rows,
        entregas: entregas.rows.map((e) => ({
          ...(e as Record<string, unknown>),
          items: entregaItems.rows.filter(
            (ei) => (ei as { entrega_id: number }).entrega_id === (e as { id: number }).id,
          ),
          adjuntos: adjuntos.rows.filter(
            (a) => (a as { entrega_id: number | null }).entrega_id === (e as { id: number }).id,
          ),
        })),
        adjuntos: adjuntos.rows.filter(
          (a) => (a as { entrega_id: number | null }).entrega_id === null,
        ),
        aprobadores: aprobadores.rows,
        aprobaciones: aprobaciones.rows,
        cambios: cambios.rows,
        pagos: pagos.rows,
      },
    });
  }),
);

// ---------------------------------------------------------------------------
// POST / — crear la orden. Nace 'pendiente' y va a las aprobaciones.
// ---------------------------------------------------------------------------
router.post(
  '/',
  authenticateToken,
  checkPermission('ordenes_ver'),
  [
    body('proyecto_id').isInt().withMessage('El proyecto es obligatorio'),
    body('proveedor').trim().notEmpty().withMessage('El proveedor es obligatorio'),
    body('items').isArray({ min: 1 }).withMessage('La orden necesita al menos un renglón'),
    body('termino_dias').optional().isInt({ min: 0 }),
  ],
  asyncHandler(async (req: Request, res: Response) => {
    if (erroresDeValidacion(req, res)) return;

    const {
      proyecto_id,
      fecha,
      proveedor,
      proveedor_ruc,
      descripcion,
      categoria_id,
      termino_dias,
      entrega,
      condiciones,
      observaciones,
      descuento,
      items,
    } = req.body as {
      proyecto_id: number;
      fecha?: string;
      proveedor: string;
      proveedor_ruc?: string;
      descripcion?: string;
      categoria_id?: number;
      termino_dias?: number;
      entrega?: string;
      condiciones?: string;
      observaciones?: string;
      descuento?: number;
      items: ItemEntrada[];
    };

    if (!(await puedeElProyecto(req, proyecto_id))) {
      res.status(403).json({ success: false, error: 'Sin acceso a ese proyecto' });
      return;
    }
    if (entrega && !['sitio', 'local'].includes(entrega)) {
      res.status(400).json({ success: false, error: 'La entrega es en sitio o retiro en el local' });
      return;
    }
    for (const it of items) {
      if (!it.descripcion || Number(it.cantidad ?? 1) <= 0 || Number(it.precio_unitario) < 0) {
        res.status(400).json({
          success: false,
          error: 'Cada renglón necesita descripción, cantidad y precio',
        });
        return;
      }
    }

    // Sin aprobadores la orden se quedaria en 'pendiente' para siempre, sin
    // nadie que pueda moverla. Mejor decirlo aqui que dejar un registro muerto.
    const aprobadores = await query(
      'SELECT 1 FROM proyecto_ajustes_aprobacion WHERE proyecto_id = $1 AND activo = true',
      [proyecto_id],
    );
    if (aprobadores.rows.length === 0) {
      res.status(400).json({
        success: false,
        error: 'Configure los aprobadores del proyecto antes de crear órdenes',
      });
      return;
    }

    const tasaRes = await query<{ itbms_tasa: string }>(
      "SELECT '0.07'::numeric AS itbms_tasa",
    );
    const itbmsTasa = Number(tasaRes.rows[0].itbms_tasa);
    const desc = redondear(Number(descuento ?? 0));
    const { renglones, subtotal, itbms, monto_total } = calcularTotales(
      items,
      desc,
      itbmsTasa,
    );
    if (desc > subtotal) {
      res.status(400).json({
        success: false,
        error: 'El descuento no puede ser mayor que el subtotal',
      });
      return;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Serializa la numeracion por proyecto, igual que las solicitudes.
      await client.query('SELECT pg_advisory_xact_lock($1)', [proyecto_id]);

      let numero: string;
      try {
        numero = await generarNumero(proyecto_id, client);
      } catch (err) {
        await client.query('ROLLBACK');
        const msg = (err as Error).message;
        if (msg === 'PREFIJO_NO_CONFIGURADO') {
          res.status(400).json({
            success: false,
            error: 'Configure el prefijo del proyecto antes de crear órdenes',
          });
          return;
        }
        if (msg === 'PROYECTO_NO_ENCONTRADO') {
          res.status(404).json({ success: false, error: 'Proyecto no encontrado' });
          return;
        }
        throw err;
      }

      const orden = await client.query<OrdenRow>(
        `INSERT INTO ordenes_compra (
           proyecto_id, numero, fecha, proveedor, proveedor_ruc, descripcion, categoria_id,
           termino_dias, entrega, condiciones, observaciones,
           subtotal, descuento, itbms_tasa, itbms, monto_total,
           estado, codigo_verificacion, creado_por
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
                   'pendiente', $17, $18)
         RETURNING *`,
        [
          proyecto_id,
          numero,
          fecha || new Date().toISOString().split('T')[0],
          proveedor,
          proveedor_ruc || null,
          descripcion?.trim() || null,
          categoria_id || null,
          termino_dias ?? 30,
          entrega || 'sitio',
          condiciones || null,
          observaciones || null,
          subtotal,
          desc,
          itbmsTasa,
          itbms,
          monto_total,
          generateCodigoVerificacion(),
          req.user!.id,
        ],
      );
      const ordenId = orden.rows[0].id;

      for (const r of renglones) {
        await client.query(
          `INSERT INTO orden_compra_items
             (orden_compra_id, cantidad, unidad, codigo, descripcion, precio_unitario, precio_total, orden)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [ordenId, r.cantidad, r.unidad, r.codigo, r.descripcion, r.precio_unitario, r.precio_total, r.orden],
        );
      }

      await registrarAudit(
        req.user!.id,
        'crear',
        'orden_compra',
        ordenId,
        { numero, proveedor, monto_total },
        client,
      );
      await client.query('COMMIT');
      res.status(201).json({ success: true, data: orden.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }),
);

// ---------------------------------------------------------------------------
// PUT /:id — editar
// ---------------------------------------------------------------------------
// Antes de mandarla al proveedor la edita quien la creo (y cualquier admin).
// Despues, SOLO un admin, con motivo obligatorio, y cada campo que cambia queda
// en orden_compra_cambios. Y nunca se puede bajar un renglon por debajo de lo
// que ya llego: eso volveria negativo lo recibido.
const CAMPOS_EDITABLES = [
  'fecha',
  'proveedor',
  'proveedor_ruc',
  'descripcion',
  'categoria_id',
  'termino_dias',
  'entrega',
  'condiciones',
  'observaciones',
] as const;

const ETIQUETAS: Record<string, string> = {
  fecha: 'Fecha de la orden',
  proveedor: 'Proveedor',
  proveedor_ruc: 'RUC del proveedor',
  descripcion: 'Descripción',
  categoria_id: 'Categoría',
  termino_dias: 'Término de pago',
  entrega: 'Entrega',
  condiciones: 'Condiciones de compra',
  observaciones: 'Observaciones',
  descuento: 'Descuento',
  items: 'Detalle de compra',
};

router.put(
  '/:id',
  authenticateToken,
  checkPermission('ordenes_ver'),
  [param('id').isInt()],
  asyncHandler(async (req: Request<{ id: string }>, res: Response) => {
    if (erroresDeValidacion(req, res)) return;
    const { id } = req.params;
    const orden = await traerOrden(id);
    if (!orden) {
      res.status(404).json({ success: false, error: 'Orden no encontrada' });
      return;
    }
    if (!(await puedeElProyecto(req, orden.proyecto_id))) {
      res.status(403).json({ success: false, error: 'Sin acceso a esa orden' });
      return;
    }
    if (orden.estado === 'dada_de_baja' || orden.estado === 'rechazada') {
      res.status(400).json({
        success: false,
        error: 'Una orden dada de baja o rechazada no se edita',
      });
      return;
    }

    const yaSalio = orden.estado === 'enviada' || orden.estado === 'cerrada';
    const esAdmin = req.user!.rol === 'admin' || req.user!.rol === 'co-admin';
    const motivo = (req.body.motivo as string | undefined)?.trim();

    if (yaSalio) {
      if (req.user!.rol !== 'admin') {
        res.status(403).json({
          success: false,
          error: 'Solo un administrador puede editar una orden ya enviada',
        });
        return;
      }
      if (!motivo) {
        res.status(400).json({
          success: false,
          error: 'El motivo del cambio es obligatorio en una orden ya enviada',
        });
        return;
      }
    } else if (orden.creado_por !== req.user!.id && !esAdmin) {
      res.status(403).json({
        success: false,
        error: 'Solo quien la creó puede editarla',
      });
      return;
    }

    // El SET se arma SOLO con lo que viene. Una lista fija de columnas no sabe
    // distinguir «no toco esto» de «déjalo en blanco».
    const sets: string[] = [];
    const valores: unknown[] = [];
    const lineas: { campo: string; antes: unknown; despues: unknown }[] = [];

    for (const campo of CAMPOS_EDITABLES) {
      if (!(campo in req.body)) continue;
      const nuevo = req.body[campo];
      const viejo = (orden as unknown as Record<string, unknown>)[campo];
      if (String(viejo ?? '') === String(nuevo ?? '')) continue;
      valores.push(nuevo === '' ? null : nuevo);
      sets.push(`${campo} = $${valores.length}`);
      lineas.push({ campo: ETIQUETAS[campo] ?? campo, antes: viejo, despues: nuevo });
    }

    const traeItems = Array.isArray(req.body.items);
    const traeDescuento = 'descuento' in req.body;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      if (traeItems) {
        const items = req.body.items as ItemEntrada[];
        if (items.length === 0) {
          await client.query('ROLLBACK');
          res.status(400).json({ success: false, error: 'La orden necesita al menos un renglón' });
          return;
        }
        // Lo que ya llego de cada renglon, para no dejar la orden en negativo.
        const recibido = await client.query<{ item_id: number; cantidad: string }>(
          `SELECT ei.item_id, SUM(ei.cantidad) AS cantidad
             FROM orden_compra_entrega_items ei
             JOIN orden_compra_entregas e ON e.id = ei.entrega_id AND e.activo = true
            WHERE e.orden_compra_id = $1
            GROUP BY ei.item_id`,
          [id],
        );
        const yaLlego = new Map(
          recibido.rows.map((r) => [r.item_id, Number(r.cantidad)]),
        );
        if (yaLlego.size > 0) {
          const conIds = items.filter(
            (it) => typeof (it as { id?: number }).id === 'number',
          ) as (ItemEntrada & { id: number })[];
          const quedan = new Set(conIds.map((it) => it.id));
          for (const [itemId, cantidad] of yaLlego) {
            if (!quedan.has(itemId)) {
              await client.query('ROLLBACK');
              res.status(400).json({
                success: false,
                error: 'No se puede quitar un renglón del que ya se recibió material',
              });
              return;
            }
            const nuevo = conIds.find((it) => it.id === itemId)!;
            if (Number(nuevo.cantidad ?? 0) < cantidad) {
              await client.query('ROLLBACK');
              res.status(400).json({
                success: false,
                error: `No se puede bajar un renglón por debajo de lo ya recibido (${cantidad})`,
              });
              return;
            }
          }
        }

        const desc = redondear(
          Number(traeDescuento ? req.body.descuento : orden.descuento),
        );
        const { renglones, subtotal, itbms, monto_total } = calcularTotales(
          items,
          desc,
          Number(orden.itbms_tasa),
        );
        if (desc > subtotal) {
          await client.query('ROLLBACK');
          res.status(400).json({
            success: false,
            error: 'El descuento no puede ser mayor que el subtotal',
          });
          return;
        }

        // Los renglones se reescriben, pero los que ya tienen entregas guardan
        // su id: orden_compra_entrega_items apunta a ellos.
        await client.query(
          `DELETE FROM orden_compra_items
            WHERE orden_compra_id = $1
              AND id NOT IN (SELECT DISTINCT ei.item_id
                               FROM orden_compra_entrega_items ei
                               JOIN orden_compra_entregas e ON e.id = ei.entrega_id
                              WHERE e.orden_compra_id = $1)`,
          [id],
        );
        for (const [i, r] of renglones.entries()) {
          const conId = items[i] as { id?: number };
          if (typeof conId.id === 'number' && yaLlego.has(conId.id)) {
            await client.query(
              `UPDATE orden_compra_items
                  SET cantidad = $1, unidad = $2, codigo = $3, descripcion = $4,
                      precio_unitario = $5, precio_total = $6, orden = $7
                WHERE id = $8 AND orden_compra_id = $9`,
              [r.cantidad, r.unidad, r.codigo, r.descripcion, r.precio_unitario, r.precio_total, r.orden, conId.id, id],
            );
          } else {
            await client.query(
              `INSERT INTO orden_compra_items
                 (orden_compra_id, cantidad, unidad, codigo, descripcion, precio_unitario, precio_total, orden)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
              [id, r.cantidad, r.unidad, r.codigo, r.descripcion, r.precio_unitario, r.precio_total, r.orden],
            );
          }
        }

        if (Number(orden.subtotal) !== subtotal) {
          lineas.push({ campo: ETIQUETAS.items, antes: orden.subtotal, despues: subtotal });
        }
        if (Number(orden.descuento) !== desc) {
          lineas.push({ campo: ETIQUETAS.descuento, antes: orden.descuento, despues: desc });
        }
        valores.push(subtotal, desc, itbms, monto_total);
        sets.push(
          `subtotal = $${valores.length - 3}`,
          `descuento = $${valores.length - 2}`,
          `itbms = $${valores.length - 1}`,
          `monto_total = $${valores.length}`,
        );
      }

      if (sets.length === 0) {
        await client.query('ROLLBACK');
        res.json({ success: true, data: orden, message: 'Nada que cambiar' });
        return;
      }

      valores.push(id);
      const actualizada = await client.query<OrdenRow>(
        `UPDATE ordenes_compra SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP
          WHERE id = $${valores.length} AND activo = true RETURNING *`,
        valores,
      );

      if (yaSalio && lineas.length > 0) {
        await client.query(
          `INSERT INTO orden_compra_cambios (orden_compra_id, user_id, motivo, cambios)
           VALUES ($1, $2, $3, $4::jsonb)`,
          [id, req.user!.id, motivo, JSON.stringify(lineas)],
        );
      }

      await registrarAudit(
        req.user!.id,
        'editar',
        'orden_compra',
        Number(id),
        { numero: orden.numero, cambios: lineas, motivo: motivo ?? null },
        client,
      );
      await client.query('COMMIT');
      res.json({ success: true, data: actualizada.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }),
);

// ---------------------------------------------------------------------------
// POST /:id/aprobar y /:id/rechazar — la misma cadena del proyecto
// ---------------------------------------------------------------------------
/** El turno actual en la cadena del proyecto, o null si no le toca a nadie. */
async function turnoDe(
  ordenId: string,
  proyectoId: number,
): Promise<{ user_id: number; orden: number; esUltimo: boolean } | null> {
  const [aprobadores, hechas] = await Promise.all([
    query<{ user_id: number; orden: number }>(
      `SELECT user_id, orden FROM proyecto_ajustes_aprobacion
        WHERE proyecto_id = $1 AND activo = true ORDER BY orden`,
      [proyectoId],
    ),
    query(
      'SELECT 1 FROM orden_compra_aprobaciones WHERE orden_compra_id = $1',
      [ordenId],
    ),
  ]);
  const siguiente = aprobadores.rows[hechas.rows.length];
  if (!siguiente) return null;
  return {
    ...siguiente,
    esUltimo: hechas.rows.length + 1 >= aprobadores.rows.length,
  };
}

router.post(
  '/:id/aprobar',
  authenticateToken,
  [param('id').isInt()],
  asyncHandler(async (req: Request<{ id: string }>, res: Response) => {
    if (erroresDeValidacion(req, res)) return;
    const { id } = req.params;

    // Aprobar compromete plata con un proveedor: pide la contraseña, igual que
    // aprobar una solicitud de pago (Ivan, 01/10). Rechazar no la pide, tampoco
    // en las solicitudes.
    const { password } = req.body as { password?: string };
    if (!password) {
      res.status(400).json({ success: false, error: 'Se requiere contraseña para aprobar' });
      return;
    }
    const usuario = await query<{ password: string | null }>(
      'SELECT password FROM users WHERE id = $1',
      [req.user!.id],
    );
    const hash = usuario.rows[0]?.password;
    if (!hash || !(await bcrypt.compare(password, hash))) {
      // 403 y no 401: la pantalla toma cualquier 401 como sesión vencida y saca
      // a la persona del sistema, cuando lo único que pasó es que se equivocó
      // de contraseña.
      res.status(403).json({ success: false, error: 'Contraseña incorrecta' });
      return;
    }

    const orden = await traerOrden(id);
    if (!orden) {
      res.status(404).json({ success: false, error: 'Orden no encontrada' });
      return;
    }
    if (orden.estado !== 'pendiente') {
      res.status(400).json({
        success: false,
        error: 'Solo se aprueban las órdenes que están esperando aprobación',
      });
      return;
    }
    const turno = await turnoDe(id, orden.proyecto_id);
    if (!turno || turno.user_id !== req.user!.id) {
      res.status(403).json({ success: false, error: 'No es tu turno de aprobar esta orden' });
      return;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO orden_compra_aprobaciones (orden_compra_id, user_id, orden, accion)
         VALUES ($1, $2, $3, 'aprobado')`,
        [id, req.user!.id, turno.orden],
      );
      if (turno.esUltimo) {
        await client.query(
          `UPDATE ordenes_compra SET estado = 'por_enviar', updated_at = CURRENT_TIMESTAMP
            WHERE id = $1 AND activo = true`,
          [id],
        );
      }
      await registrarAudit(
        req.user!.id,
        'aprobar',
        'orden_compra',
        Number(id),
        { numero: orden.numero, ultimo: turno.esUltimo },
        client,
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    res.json({
      success: true,
      message: turno.esUltimo ? 'Orden aprobada, lista para enviar' : 'Orden aprobada',
    });
  }),
);

router.post(
  '/:id/rechazar',
  authenticateToken,
  [
    param('id').isInt(),
    body('comentario').trim().notEmpty().withMessage('El comentario es obligatorio al rechazar'),
  ],
  asyncHandler(async (req: Request<{ id: string }>, res: Response) => {
    if (erroresDeValidacion(req, res)) return;
    const { id } = req.params;
    const { comentario } = req.body as { comentario: string };
    const orden = await traerOrden(id);
    if (!orden) {
      res.status(404).json({ success: false, error: 'Orden no encontrada' });
      return;
    }
    if (orden.estado !== 'pendiente') {
      res.status(400).json({
        success: false,
        error: 'Solo se rechazan las órdenes que están esperando aprobación',
      });
      return;
    }
    const turno = await turnoDe(id, orden.proyecto_id);
    if (!turno || turno.user_id !== req.user!.id) {
      res.status(403).json({ success: false, error: 'No es tu turno de revisar esta orden' });
      return;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO orden_compra_aprobaciones (orden_compra_id, user_id, orden, accion, comentario)
         VALUES ($1, $2, $3, 'rechazado', $4)`,
        [id, req.user!.id, turno.orden, comentario],
      );
      await client.query(
        `UPDATE ordenes_compra SET estado = 'rechazada', updated_at = CURRENT_TIMESTAMP
          WHERE id = $1 AND activo = true`,
        [id],
      );
      await registrarAudit(
        req.user!.id,
        'rechazar',
        'orden_compra',
        Number(id),
        { numero: orden.numero, comentario },
        client,
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    res.json({ success: true, message: 'Orden rechazada' });
  }),
);

// ---------------------------------------------------------------------------
// POST /:id/marcar-enviada — Martina ya la mando por correo
// ---------------------------------------------------------------------------
router.post(
  '/:id/marcar-enviada',
  authenticateToken,
  checkPermission('ordenes_ver'),
  [param('id').isInt()],
  asyncHandler(async (req: Request<{ id: string }>, res: Response) => {
    if (erroresDeValidacion(req, res)) return;
    const { id } = req.params;
    const orden = await traerOrden(id);
    if (!orden) {
      res.status(404).json({ success: false, error: 'Orden no encontrada' });
      return;
    }
    if (!(await puedeElProyecto(req, orden.proyecto_id))) {
      res.status(403).json({ success: false, error: 'Sin acceso a esa orden' });
      return;
    }
    if (orden.estado !== 'por_enviar') {
      res.status(400).json({
        success: false,
        error: 'Solo se marca como enviada una orden aprobada y todavía por enviar',
      });
      return;
    }

    const r = await query<OrdenRow>(
      `UPDATE ordenes_compra
          SET estado = 'enviada', enviada_por = $1, enviada_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = $2 AND activo = true RETURNING *`,
      [req.user!.id, id],
    );
    await registrarAudit(req.user!.id, 'enviar', 'orden_compra', Number(id), {
      numero: orden.numero,
    });
    res.json({ success: true, data: r.rows[0] });
  }),
);

// ---------------------------------------------------------------------------
// POST /:id/entregas — lo que llego a la obra
// ---------------------------------------------------------------------------
// El documento de entrega se adjunta aparte (POST /:id/adjuntos con entrega_id),
// porque en obra la foto del vale llega del telefono y a veces despues del
// registro. La entrega congela su vencimiento y el precio de cada renglon.
router.post(
  '/:id/entregas',
  authenticateToken,
  checkPermission('ordenes_entregas'),
  [
    param('id').isInt(),
    body('fecha').notEmpty().withMessage('La fecha de la entrega es obligatoria'),
    body('items').isArray({ min: 1 }).withMessage('Diga qué llegó'),
  ],
  asyncHandler(async (req: Request<{ id: string }>, res: Response) => {
    if (erroresDeValidacion(req, res)) return;
    const { id } = req.params;
    const { fecha, nota, items } = req.body as {
      fecha: string;
      nota?: string;
      items: { item_id: number; cantidad: number | string }[];
    };

    const orden = await traerOrden(id);
    if (!orden) {
      res.status(404).json({ success: false, error: 'Orden no encontrada' });
      return;
    }
    if (!(await puedeElProyecto(req, orden.proyecto_id))) {
      res.status(403).json({ success: false, error: 'Sin acceso a esa orden' });
      return;
    }
    if (orden.estado !== 'enviada') {
      res.status(400).json({
        success: false,
        error: 'Solo una orden enviada al proveedor puede recibir entregas',
      });
      return;
    }

    const renglones = await query<{ id: number; cantidad: string; precio_unitario: string }>(
      'SELECT id, cantidad, precio_unitario FROM orden_compra_items WHERE orden_compra_id = $1',
      [id],
    );
    const porId = new Map(renglones.rows.map((r) => [r.id, r]));
    const recibido = await query<{ item_id: number; cantidad: string }>(
      `SELECT ei.item_id, SUM(ei.cantidad) AS cantidad
         FROM orden_compra_entrega_items ei
         JOIN orden_compra_entregas e ON e.id = ei.entrega_id AND e.activo = true
        WHERE e.orden_compra_id = $1
        GROUP BY ei.item_id`,
      [id],
    );
    const yaLlego = new Map(recibido.rows.map((r) => [r.item_id, Number(r.cantidad)]));

    const lineas: { item_id: number; cantidad: number; precio_unitario: number; precio_total: number }[] = [];
    for (const it of items) {
      const cantidad = Number(it.cantidad);
      if (!cantidad) continue; // un renglon que no llego en esta entrega
      const renglon = porId.get(Number(it.item_id));
      if (!renglon) {
        res.status(400).json({ success: false, error: 'Un renglón no es de esta orden' });
        return;
      }
      if (cantidad < 0) {
        res.status(400).json({ success: false, error: 'La cantidad recibida no puede ser negativa' });
        return;
      }
      const falta = Number(renglon.cantidad) - (yaLlego.get(renglon.id) ?? 0);
      if (cantidad > falta) {
        res.status(400).json({
          success: false,
          error: `De un renglón solo faltan ${falta} y se están recibiendo ${cantidad}`,
        });
        return;
      }
      const precio = Number(renglon.precio_unitario);
      lineas.push({
        item_id: renglon.id,
        cantidad,
        precio_unitario: precio,
        precio_total: redondear(cantidad * precio),
      });
    }
    if (lineas.length === 0) {
      res.status(400).json({ success: false, error: 'No se recibió nada' });
      return;
    }

    const subtotal = redondear(lineas.reduce((s, l) => s + l.precio_total, 0));
    const itbms = redondear(subtotal * Number(orden.itbms_tasa));
    const montoTotal = redondear(subtotal + itbms);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const entrega = await client.query<{ id: number; vence: string }>(
        `INSERT INTO orden_compra_entregas
           (orden_compra_id, fecha, vence, subtotal, itbms, monto_total, nota, registrada_por)
         VALUES ($1, $2::date, $2::date + $3::int, $4, $5, $6, $7, $8)
         RETURNING id, vence`,
        [id, fecha, orden.termino_dias, subtotal, itbms, montoTotal, nota || null, req.user!.id],
      );
      for (const l of lineas) {
        await client.query(
          `INSERT INTO orden_compra_entrega_items
             (entrega_id, item_id, cantidad, precio_unitario, precio_total)
           VALUES ($1, $2, $3, $4, $5)`,
          [entrega.rows[0].id, l.item_id, l.cantidad, l.precio_unitario, l.precio_total],
        );
      }
      await registrarAudit(
        req.user!.id,
        'entrega',
        'orden_compra',
        Number(id),
        { numero: orden.numero, entrega_id: entrega.rows[0].id, monto_total: montoTotal },
        client,
      );
      await client.query('COMMIT');
      res.status(201).json({
        success: true,
        data: { id: entrega.rows[0].id, vence: entrega.rows[0].vence, subtotal, itbms, monto_total: montoTotal },
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }),
);

// ---------------------------------------------------------------------------
// POST /:id/activar-pago — nace la solicitud de pago de lo que ya llego
// ---------------------------------------------------------------------------
// Se paga por ENTREGA, no contra el saldo suelto de la orden: cada entrega tiene
// su propio vencimiento y un monto suelto no sabria cual reloj esta parando.
router.post(
  '/:id/activar-pago',
  authenticateToken,
  checkPermission('ordenes_ver'),
  [param('id').isInt(), body('entregas').isArray({ min: 1 }).withMessage('Diga qué entregas se pagan')],
  asyncHandler(async (req: Request<{ id: string }>, res: Response) => {
    if (erroresDeValidacion(req, res)) return;
    const { id } = req.params;
    const { entregas, observaciones } = req.body as {
      entregas: { entrega_id: number; monto: number | string }[];
      observaciones?: string;
    };

    const orden = await traerOrden(id);
    if (!orden) {
      res.status(404).json({ success: false, error: 'Orden no encontrada' });
      return;
    }
    if (!(await puedeElProyecto(req, orden.proyecto_id))) {
      res.status(403).json({ success: false, error: 'Sin acceso a esa orden' });
      return;
    }
    // Tambien se paga una orden DADA DE BAJA: lo que ya llego se sigue
    // debiendo, y si no se pudiera activar el pago esa deuda no tendria salida.
    if (orden.estado !== 'enviada' && orden.estado !== 'dada_de_baja') {
      res.status(400).json({
        success: false,
        error: 'Solo se activa un pago sobre una orden enviada con material recibido',
      });
      return;
    }

    // Lo que queda por reclamar de cada entrega: su monto menos lo que ya tiene
    // encima una solicitud que no fue rechazada.
    const disponibles = await query<{ id: number; disponible: string }>(
      `SELECT e.id,
              (e.monto_total - COALESCE((
                 SELECT SUM(spe.monto)
                   FROM solicitud_pago_entregas spe
                   JOIN solicitudes_pago sp ON sp.id = spe.solicitud_pago_id
                  WHERE spe.entrega_id = e.id AND sp.activo = true
                    AND sp.estado NOT IN ('rechazada', 'devolucion')
               ), 0)) AS disponible
         FROM orden_compra_entregas e
        WHERE e.orden_compra_id = $1 AND e.activo = true`,
      [id],
    );
    const porEntrega = new Map(disponibles.rows.map((r) => [r.id, Number(r.disponible)]));

    let total = 0;
    for (const e of entregas) {
      const monto = redondear(Number(e.monto));
      const disponible = porEntrega.get(Number(e.entrega_id));
      if (disponible === undefined) {
        res.status(400).json({ success: false, error: 'Una entrega no es de esta orden' });
        return;
      }
      if (monto <= 0) {
        res.status(400).json({ success: false, error: 'El monto a pagar debe ser mayor que cero' });
        return;
      }
      if (monto > disponible) {
        res.status(400).json({
          success: false,
          error: `De una entrega solo quedan ${disponible.toFixed(2)} por pagar`,
        });
        return;
      }
      total = redondear(total + monto);
    }

    // La solicitud nace igual que cualquier otra y sigue la misma cadena; lo
    // unico propio es que sabe de que orden y de que entregas viene.
    const { generateNumero } = await import('./solicitudesPago.js');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [orden.proyecto_id]);

      let numero: string;
      try {
        numero = await generateNumero(orden.proyecto_id, 'regular', client);
      } catch (err) {
        await client.query('ROLLBACK');
        if ((err as Error).message === 'PREFIJO_NO_CONFIGURADO') {
          res.status(400).json({
            success: false,
            error: 'Configure el prefijo del proyecto antes de activar un pago',
          });
          return;
        }
        throw err;
      }

      const solicitud = await client.query<{ id: number; numero: string }>(
        `INSERT INTO solicitudes_pago (
           proyecto_id, numero, fecha, proveedor, preparado_por, solicitado_por,
           subtotal, descuentos, impuestos, monto_total, estado, observaciones,
           codigo_verificacion, categoria_id, orden_compra_id
         ) VALUES ($1, $2, CURRENT_DATE, $3, $4, $4, $5, 0, 0, $5, 'pendiente', $6, $7, $8, $9)
         RETURNING id, numero`,
        [
          orden.proyecto_id,
          numero,
          orden.proveedor,
          req.user!.id,
          total,
          observaciones || `Pago de la orden ${orden.numero}`,
          generateCodigoVerificacion(),
          orden.categoria_id,
          id,
        ],
      );
      const solicitudId = solicitud.rows[0].id;

      for (const e of entregas) {
        await client.query(
          `INSERT INTO solicitud_pago_entregas (solicitud_pago_id, entrega_id, monto)
           VALUES ($1, $2, $3)`,
          [solicitudId, e.entrega_id, redondear(Number(e.monto))],
        );
      }

      // Un renglon por entrega, para que la solicitud se lea sola.
      const detalle = await client.query<{ entrega_id: number; fecha: string }>(
        `SELECT e.id AS entrega_id, e.fecha
           FROM orden_compra_entregas e
          WHERE e.id = ANY($1::int[]) ORDER BY e.fecha`,
        [entregas.map((e) => e.entrega_id)],
      );
      for (const [i, d] of detalle.rows.entries()) {
        const monto = redondear(
          Number(entregas.find((e) => Number(e.entrega_id) === d.entrega_id)!.monto),
        );
        await client.query(
          `INSERT INTO solicitud_pago_items
             (solicitud_pago_id, cantidad, unidad, descripcion, precio_unitario, precio_total, orden)
           VALUES ($1, 1, 'entrega', $2, $3, $3, $4)`,
          [solicitudId, `Entrega del ${new Date(d.fecha).toISOString().split('T')[0]} · ${orden.numero}`, monto, i],
        );
      }

      await registrarAudit(
        req.user!.id,
        'crear',
        'solicitud_pago',
        solicitudId,
        { numero: solicitud.rows[0].numero, desde_orden: orden.numero, monto_total: total },
        client,
      );
      await client.query('COMMIT');
      res.status(201).json({ success: true, data: solicitud.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }),
);

// ---------------------------------------------------------------------------
// POST /:id/baja — matar la orden sin borrarla
// ---------------------------------------------------------------------------
// Lo que ya llego se sigue debiendo; lo que faltaba por retirar se suelta.
router.post(
  '/:id/baja',
  authenticateToken,
  requireRole(['admin', 'co-admin']),
  [param('id').isInt(), body('motivo').trim().notEmpty().withMessage('El motivo es obligatorio')],
  asyncHandler(async (req: Request<{ id: string }>, res: Response) => {
    if (erroresDeValidacion(req, res)) return;
    const { id } = req.params;
    const { motivo } = req.body as { motivo: string };
    const orden = await traerOrden(id);
    if (!orden) {
      res.status(404).json({ success: false, error: 'Orden no encontrada' });
      return;
    }
    if (orden.estado === 'dada_de_baja') {
      res.status(400).json({ success: false, error: 'Esa orden ya está dada de baja' });
      return;
    }
    if (orden.estado === 'rechazada') {
      res.status(400).json({ success: false, error: 'Una orden rechazada no se da de baja' });
      return;
    }

    const r = await query<OrdenRow>(
      `UPDATE ordenes_compra
          SET estado = 'dada_de_baja', baja_motivo = $1, baja_por = $2,
              baja_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE id = $3 AND activo = true RETURNING *`,
      [motivo, req.user!.id, id],
    );
    await registrarAudit(req.user!.id, 'dar_de_baja', 'orden_compra', Number(id), {
      numero: orden.numero,
      motivo,
    });
    res.json({ success: true, data: r.rows[0] });
  }),
);

// ---------------------------------------------------------------------------
// POST /:id/cerrar — punto final
// ---------------------------------------------------------------------------
// Normalmente se cierra sola cuando lo recibido esta pagado. A mano existe para
// los centavos de redondeo del ITBMS que ya nadie va a pagar, y por eso pide
// motivo cuando todavia queda algo.
router.post(
  '/:id/cerrar',
  authenticateToken,
  requireRole(['admin', 'co-admin']),
  [param('id').isInt()],
  asyncHandler(async (req: Request<{ id: string }>, res: Response) => {
    if (erroresDeValidacion(req, res)) return;
    const { id } = req.params;
    const orden = await traerOrden(id);
    if (!orden) {
      res.status(404).json({ success: false, error: 'Orden no encontrada' });
      return;
    }
    if (orden.estado !== 'enviada') {
      res.status(400).json({ success: false, error: 'Solo se cierra una orden enviada' });
      return;
    }

    const saldo = await query<{ por_pagar: string }>(
      `SELECT (COALESCE(m.recibido, 0) - COALESCE(m.pagado, 0)) AS por_pagar
         FROM ordenes_compra o ${MONTOS} WHERE o.id = $1`,
      [id],
    );
    const porPagar = Number(saldo.rows[0].por_pagar);
    const motivo = (req.body.motivo as string | undefined)?.trim();
    if (porPagar > 0 && !motivo) {
      res.status(400).json({
        success: false,
        error: `Todavía quedan ${porPagar.toFixed(2)} por pagar: diga el motivo para cerrarla igual`,
      });
      return;
    }

    const r = await query<OrdenRow>(
      `UPDATE ordenes_compra SET estado = 'cerrada', updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND activo = true RETURNING *`,
      [id],
    );
    await registrarAudit(req.user!.id, 'cerrar', 'orden_compra', Number(id), {
      numero: orden.numero,
      por_pagar: porPagar,
      motivo: motivo ?? null,
    });
    res.json({ success: true, data: r.rows[0] });
  }),
);

// ---------------------------------------------------------------------------
// GET /:id/pdf — el papel que Martina baja y le manda al proveedor
// ---------------------------------------------------------------------------
// El sistema no le escribe al proveedor: esto es todo lo que hay para mandarle.
// Mientras la orden no tenga todas las firmas, el papel sale marcado BORRADOR y
// sin codigo, para que no pueda pasar por aprobada.
router.get(
  '/:id/pdf',
  authenticateToken,
  checkPermission('ordenes_ver'),
  [param('id').isInt()],
  asyncHandler(async (req: Request<{ id: string }>, res: Response) => {
    if (erroresDeValidacion(req, res)) return;
    const { id } = req.params;

    const cab = await query<
      OrdenRow & { proyecto_nombre: string; total_aprobadores: number; firmas: number }
    >(
      `SELECT o.*, COALESCE(p.nombre_corto, p.nombre) AS proyecto_nombre,
              (SELECT COUNT(*)::int FROM proyecto_ajustes_aprobacion pas
                WHERE pas.proyecto_id = o.proyecto_id AND pas.activo = true) AS total_aprobadores,
              (SELECT COUNT(*)::int FROM orden_compra_aprobaciones ap
                WHERE ap.orden_compra_id = o.id AND ap.accion = 'aprobado') AS firmas
         FROM ordenes_compra o
         LEFT JOIN proyectos p ON p.id = o.proyecto_id
        WHERE o.id = $1 AND o.activo = true`,
      [id],
    );
    if (cab.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Orden no encontrada' });
      return;
    }
    const orden = cab.rows[0];
    if (!(await puedeElProyecto(req, orden.proyecto_id))) {
      res.status(403).json({ success: false, error: 'Sin acceso a esa orden' });
      return;
    }

    const items = await query(
      `SELECT cantidad, unidad, codigo, descripcion, precio_unitario, precio_total
         FROM orden_compra_items WHERE orden_compra_id = $1 ORDER BY orden, id`,
      [id],
    );

    const { generarOrdenCompraPDF } = await import('../services/ordenCompraPdf.js');
    const pdf = await generarOrdenCompraPDF({
      numero: orden.numero,
      fecha: orden.fecha,
      proveedor: orden.proveedor,
      proveedor_ruc: orden.proveedor_ruc,
      proyecto_nombre: orden.proyecto_nombre,
      termino_dias: orden.termino_dias,
      entrega: orden.entrega,
      condiciones: orden.condiciones,
      subtotal: orden.subtotal,
      descuento: orden.descuento,
      itbms_tasa: orden.itbms_tasa,
      itbms: orden.itbms,
      monto_total: orden.monto_total,
      items: items.rows as never,
      codigo_verificacion: orden.codigo_verificacion,
      aprobada:
        orden.total_aprobadores > 0 && orden.firmas >= orden.total_aprobadores,
    });

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${orden.numero}.pdf"`,
      'Content-Length': String(pdf.length),
    });
    res.send(pdf);
  }),
);

// ---------------------------------------------------------------------------
// Adjuntos: la cotizacion de la orden y el documento de cada entrega
// ---------------------------------------------------------------------------
const subida = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const permitidos = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
    if (permitidos.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Tipo de archivo no permitido. Solo PDF, JPG, PNG y WEBP.'));
  },
});

function limpiarNombre(nombre: string): string {
  return nombre
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_');
}

router.post(
  '/:id/adjuntos',
  authenticateToken,
  checkPermission('ordenes_ver'),
  (req: Request, res: Response, next: NextFunction) => {
    // Sin esto, una foto de 12 MB del telefono falla como «Error interno del
    // servidor» y nadie sabe por que.
    subida.single('archivo')(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        res.status(400).json({
          success: false,
          error:
            err.code === 'LIMIT_FILE_SIZE'
              ? 'El archivo pasa de 10 MB'
              : `No se pudo subir el archivo: ${err.message}`,
        });
        return;
      }
      if (err) {
        res.status(400).json({ success: false, error: (err as Error).message });
        return;
      }
      fixFiles(req);
      next();
    });
  },
  [param('id').isInt()],
  asyncHandler(async (req: Request<{ id: string }>, res: Response) => {
    if (erroresDeValidacion(req, res)) return;
    const { id } = req.params;
    if (!req.file) {
      res.status(400).json({ success: false, error: 'No se recibió ningún archivo' });
      return;
    }
    const orden = await traerOrden(id);
    if (!orden) {
      res.status(404).json({ success: false, error: 'Orden no encontrada' });
      return;
    }
    if (!(await puedeElProyecto(req, orden.proyecto_id))) {
      res.status(403).json({ success: false, error: 'Sin acceso a esa orden' });
      return;
    }

    const entregaId = req.body.entrega_id ? Number(req.body.entrega_id) : null;
    if (entregaId !== null) {
      const e = await query(
        'SELECT 1 FROM orden_compra_entregas WHERE id = $1 AND orden_compra_id = $2 AND activo = true',
        [entregaId, id],
      );
      if (e.rows.length === 0) {
        res.status(400).json({ success: false, error: 'Esa entrega no es de esta orden' });
        return;
      }
    }

    const key = `ordenes-compra/${orden.numero}/${Date.now()}-${limpiarNombre(req.file.originalname)}`;
    await uploadFile(key, req.file.buffer, req.file.mimetype);

    const r = await query(
      `INSERT INTO orden_compra_adjuntos
         (orden_compra_id, entrega_id, nombre_original, r2_key, tipo_mime, tamano, descripcion, subido_por)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [
        id,
        entregaId,
        req.file.originalname,
        key,
        req.file.mimetype,
        req.file.size,
        (req.body.descripcion as string | undefined)?.trim() || null,
        req.user!.id,
      ],
    );
    await registrarAudit(req.user!.id, 'adjuntar', 'orden_compra', Number(id), {
      numero: orden.numero,
      archivo: req.file.originalname,
    });
    res.status(201).json({ success: true, data: r.rows[0] });
  }),
);

router.delete(
  '/:id/adjuntos/:adjuntoId',
  authenticateToken,
  checkPermission('ordenes_ver'),
  [param('id').isInt(), param('adjuntoId').isInt()],
  asyncHandler(
    async (req: Request<{ id: string; adjuntoId: string }>, res: Response) => {
      if (erroresDeValidacion(req, res)) return;
      const { id, adjuntoId } = req.params;
      const orden = await traerOrden(id);
      if (!orden) {
        res.status(404).json({ success: false, error: 'Orden no encontrada' });
        return;
      }
      if (!(await puedeElProyecto(req, orden.proyecto_id))) {
        res.status(403).json({ success: false, error: 'Sin acceso a esa orden' });
        return;
      }
      const adj = await query<{ r2_key: string; nombre_original: string }>(
        'SELECT r2_key, nombre_original FROM orden_compra_adjuntos WHERE id = $1 AND orden_compra_id = $2',
        [adjuntoId, id],
      );
      if (adj.rows.length === 0) {
        res.status(404).json({ success: false, error: 'Adjunto no encontrado' });
        return;
      }

      await query('DELETE FROM orden_compra_adjuntos WHERE id = $1', [adjuntoId]);
      // El archivo se va despues de la fila: si R2 falla, no queda una fila
      // apuntando a un archivo que ya no esta.
      await deleteFile(adj.rows[0].r2_key).catch((err) =>
        console.error('No se pudo borrar el archivo de R2:', err),
      );
      await registrarAudit(req.user!.id, 'eliminar_adjunto', 'orden_compra', Number(id), {
        numero: orden.numero,
        archivo: adj.rows[0].nombre_original,
      });
      res.json({ success: true });
    },
  ),
);

export default router;
