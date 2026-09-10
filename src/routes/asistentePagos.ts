// src/routes/asistentePagos.ts
// El asistente de partidas: pedir los cambios hablando.
//
// Se monta bajo /api/costs, al lado de costs.ts. Aqui vive lo que el asistente
// necesita y que no tiene sentido meter en la pantalla de costos.
//
// Solo administradores: una frase puede reescribir la clasificacion de sesenta
// pagos de golpe, y eso no es lo mismo que hacerlo a mano de uno en uno.

import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { pool } from '../database/config.js';
import { authenticateToken, requireAdmin, checkProjectAccess } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { registrarAudit } from '../services/auditLog.js';
import {
  aplicarPartidasDePago,
  centavos,
  leerPartidasDePago,
  partidasDelProyecto,
  RepartoInvalidoError,
} from '../services/partidasProyecto.js';
import { huellaDePago, type Propuesta } from '../services/asistentePagos/propuesta.js';
import { cargarContexto } from '../services/asistentePagos/contexto.js';
import { estaConfigurado } from '../services/asistentePagos/cliente.js';
import { conversar, type MensajeChat } from '../services/asistentePagos/asistente.js';

const router = Router();

// Los topes van por PERSONA, no por direccion de internet: en la oficina todos
// salen por la misma y se quitarian el turno unos a otros. El diario es el que
// de verdad controla la factura; el corto es contra un dedo pegado al boton.
const porUsuario = (req: Request): string => String(req.user?.id ?? req.ip ?? 'anonimo');

const topeCorto = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 10,
  keyGenerator: porUsuario,
  message: { success: false, message: 'Vas muy rápido. Espera un momento antes de volver a preguntar.' },
});

const topeDiario = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 60,
  keyGenerator: porUsuario,
  message: { success: false, message: 'Llegaste al tope de preguntas de hoy al asistente.' },
});

// ---------------------------------------------------------------------------
// GET /costs/asistente-pagos/estado — hay asistente en este servidor?
//
// La pantalla lo pregunta para no ensenar el panel cuando no hay llave puesta.
// Mejor que no aparezca a que aparezca y falle al primer intento.
// ---------------------------------------------------------------------------
router.get(
  '/asistente-pagos/estado',
  authenticateToken,
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const esAdmin = req.user?.rol === 'admin' || req.user?.rol === 'co-admin';
    res.json({ success: true, data: { disponible: estaConfigurado() && esAdmin } });
  }),
);

// ---------------------------------------------------------------------------
// POST /costs/projects/:projectId/asistente-pagos — hablar con el asistente
//
// Devuelve lo que contesta y, si propuso cambios, la propuesta para que la
// pantalla la pinte sobre la tabla. NO ESCRIBE NADA: este camino no tiene
// acceso de escritura, y la unica manera de que algo entre a la base es que la
// persona pulse aplicar, que es el otro endpoint.
// ---------------------------------------------------------------------------
router.post(
  '/projects/:projectId/asistente-pagos',
  authenticateToken,
  requireAdmin,
  checkProjectAccess('projectId'),
  topeCorto,
  topeDiario,
  asyncHandler(async (req: Request<{ projectId: string }>, res: Response): Promise<void> => {
    const proyectoId = parseInt(req.params.projectId, 10);
    if (!Number.isInteger(proyectoId)) {
      res.status(400).json({ success: false, message: 'ID de proyecto inválido' });
      return;
    }
    if (!estaConfigurado()) {
      res.status(503).json({
        success: false,
        message: 'El asistente no está configurado en este servidor',
      });
      return;
    }

    const body = req.body as { mensajes?: unknown; propuestaPrevia?: Propuesta | null };
    const crudos = Array.isArray(body.mensajes) ? body.mensajes : null;
    if (!crudos || crudos.length === 0) {
      res.status(400).json({ success: false, message: 'No hay nada que preguntar' });
      return;
    }
    if (crudos.length > 20) {
      res.status(400).json({ success: false, message: 'La conversación es demasiado larga. Empieza una nueva.' });
      return;
    }

    const mensajes: MensajeChat[] = [];
    for (const m of crudos as { rol?: unknown; texto?: unknown }[]) {
      const rol = m.rol === 'asistente' ? 'asistente' : 'usuario';
      const texto = typeof m.texto === 'string' ? m.texto.trim() : '';
      if (!texto) {
        res.status(400).json({ success: false, message: 'Hay un mensaje vacío' });
        return;
      }
      if (texto.length > 2000) {
        res.status(400).json({ success: false, message: 'Ese mensaje es demasiado largo' });
        return;
      }
      mensajes.push({ rol, texto });
    }

    const ctx = await cargarContexto(proyectoId);
    if (!ctx) {
      res.status(404).json({ success: false, message: 'Proyecto no encontrado' });
      return;
    }
    if (ctx.partidas.length === 0) {
      res.status(400).json({
        success: false,
        message: 'Este proyecto todavía no tiene desglose, así que no hay partidas que asignar',
      });
      return;
    }

    const r = await conversar({
      ctx,
      mensajes,
      propuestaPrevia: body.propuestaPrevia ?? null,
    });

    // Para poder atribuir el gasto despues, y para ver si el cache esta
    // funcionando: si el numero de cache se queda en cero, algo lo rompio.
    console.log(
      `[asistente] proyecto=${proyectoId} usuario=${req.user?.id} `
      + `entrada=${r.uso.entrada} salida=${r.uso.salida} cache=${r.uso.cache} `
      + `cambios=${r.propuesta?.cambios.length ?? 0}`,
    );

    res.json({
      success: true,
      data: { mensaje: r.mensaje, propuesta: r.propuesta, ...(r.aviso ? { aviso: r.aviso } : {}) },
    });
  }),
);

interface CambioEntrante {
  solicitudId?: unknown;
  partidas?: { rowUid?: unknown; monto?: unknown }[];
  huella?: unknown;
}

/** Cuantos pagos puede tocar un lote. El mismo tope que la propuesta. */
const MAX_CAMBIOS = 150;

// ---------------------------------------------------------------------------
// POST /costs/projects/:projectId/pagos/partidas/lote
//
// Guarda de una vez los cambios que la persona dejo marcados en la propuesta.
//
// TODO O NADA. Si uno falla no entra ninguno: quedarse a medias es peor que no
// empezar, porque no se sabe donde se corto.
//
// Y antes de escribir, cada pago tiene que estar como estaba cuando se propuso.
// Esa comprobacion es la HUELLA: se vuelve a calcular contra la base, dentro de
// la transaccion y con los pagos bloqueados. Si alguien los movio mientras la
// propuesta estaba en pantalla, se rechaza el lote entero y se dice cuales
// cambiaron. Pisar el trabajo de otro en silencio no es una opcion.
// ---------------------------------------------------------------------------
router.post(
  '/projects/:projectId/pagos/partidas/lote',
  authenticateToken,
  requireAdmin,
  checkProjectAccess('projectId'),
  asyncHandler(async (req: Request<{ projectId: string }>, res: Response): Promise<void> => {
    const proyectoId = parseInt(req.params.projectId, 10);
    if (!Number.isInteger(proyectoId)) {
      res.status(400).json({ success: false, message: 'ID de proyecto inválido' });
      return;
    }
    const user = req.user;
    if (!user) {
      res.status(401).json({ success: false, message: 'Token inválido' });
      return;
    }

    const body = req.body as { propuestaId?: unknown; cambios?: CambioEntrante[] };
    const propuestaId = typeof body.propuestaId === 'string' ? body.propuestaId : null;
    if (!Array.isArray(body.cambios) || body.cambios.length === 0) {
      res.status(400).json({ success: false, message: 'No hay cambios que aplicar' });
      return;
    }
    if (body.cambios.length > MAX_CAMBIOS) {
      res.status(400).json({ success: false, message: 'Son demasiados cambios de una vez' });
      return;
    }

    // Lo que llega, en limpio. Los montos se validan de verdad mas abajo, ya
    // dentro de la transaccion y contra el desglose que este vivo entonces.
    const cambios: { solicitudId: number; huella: string; lineas: { rowUid: string; monto: number }[] }[] = [];
    for (const c of body.cambios) {
      const solicitudId = typeof c.solicitudId === 'number' ? c.solicitudId : NaN;
      const huella = typeof c.huella === 'string' ? c.huella : '';
      if (!Number.isInteger(solicitudId) || !huella) {
        res.status(400).json({ success: false, message: 'Hay un cambio mal formado' });
        return;
      }
      if (cambios.some((x) => x.solicitudId === solicitudId)) {
        res.status(400).json({ success: false, message: 'Un mismo pago viene dos veces en el lote' });
        return;
      }
      const lineas = Array.isArray(c.partidas) ? c.partidas : [];
      cambios.push({
        solicitudId,
        huella,
        lineas: lineas.map((l) => ({
          rowUid: typeof l.rowUid === 'string' ? l.rowUid : '',
          monto: typeof l.monto === 'number' ? l.monto : NaN,
        })),
      });
    }

    const ids = cambios.map((c) => c.solicitudId);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // FOR UPDATE: dos personas aplicando a la vez se ponen en fila en vez de
      // pisarse. Y el WHERE deja fuera lo que no es de este proyecto o no esta
      // pagado, asi que un id colado no llega a la escritura.
      const pagos = await client.query<{ id: number; monto_total: string; numero: string | null }>(
        `SELECT id, monto_total, numero FROM solicitudes_pago
          WHERE id = ANY($1::int[]) AND proyecto_id = $2 AND activo = TRUE
            AND estado IN ('pagada', 'facturada')
          FOR UPDATE`,
        [ids, proyectoId],
      );
      if (pagos.rows.length !== cambios.length) {
        await client.query('ROLLBACK');
        res.status(400).json({
          success: false,
          message: 'Alguno de esos pagos ya no es de este proyecto o dejó de estar pagado',
        });
        return;
      }

      // El desglose se relee AHORA: entre proponer y aplicar pudieron borrar
      // una partida, y la propuesta apuntaria a una fila que ya no existe.
      const disponible = await partidasDelProyecto(proyectoId);
      if (!disponible) {
        await client.query('ROLLBACK');
        res.status(400).json({
          success: false,
          message: 'Este proyecto ya no tiene desglose, así que no hay partidas que asignar',
        });
        return;
      }
      const validas = new Set(disponible.partidas.map((p) => p.rowUid));

      const actuales = await client.query<{ solicitud_pago_id: number; row_uid: string; monto: string }>(
        `SELECT solicitud_pago_id, row_uid, monto::text AS monto
           FROM solicitud_pago_partidas
          WHERE solicitud_pago_id = ANY($1::int[])`,
        [ids],
      );
      const lineasActuales = new Map<number, { rowUid: string; monto: number }[]>();
      for (const a of actuales.rows) {
        const lista = lineasActuales.get(a.solicitud_pago_id) ?? [];
        lista.push({ rowUid: a.row_uid, monto: parseFloat(a.monto) });
        lineasActuales.set(a.solicitud_pago_id, lista);
      }

      const desactualizados: number[] = [];
      for (const c of cambios) {
        const pago = pagos.rows.find((p) => p.id === c.solicitudId);
        if (!pago) { desactualizados.push(c.solicitudId); continue; }
        const ahora = huellaDePago(
          c.solicitudId,
          centavos(parseFloat(pago.monto_total)),
          lineasActuales.get(c.solicitudId) ?? [],
        );
        if (ahora !== c.huella) desactualizados.push(c.solicitudId);
      }
      if (desactualizados.length > 0) {
        await client.query('ROLLBACK');
        res.status(409).json({
          success: false,
          message: desactualizados.length === 1
            ? 'Uno de esos pagos cambió mientras mirabas la propuesta. Vuelve a pedírsela.'
            : `${desactualizados.length} de esos pagos cambiaron mientras mirabas la propuesta. Vuelve a pedírsela.`,
          desactualizados,
        });
        return;
      }

      for (const c of cambios) {
        const pago = pagos.rows.find((p) => p.id === c.solicitudId)!;
        await aplicarPartidasDePago(client, {
          solicitudId: c.solicitudId,
          presupuestoId: disponible.presupuestoId,
          lineas: c.lineas,
          montoTotalCentavos: centavos(parseFloat(pago.monto_total)),
          validas,
          userId: user.id,
        });
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      if (err instanceof RepartoInvalidoError) {
        res.status(400).json({ success: false, message: err.message });
        return;
      }
      throw err;
    } finally {
      client.release();
    }

    // El rastro se deja despues de que la escritura cuajo, y una linea por
    // pago: asi se puede ver quien toco un pago concreto. `origen` distingue lo
    // que vino del asistente de lo que se puso a mano.
    for (const c of cambios) {
      try {
        await registrarAudit(user.id, 'editar', 'solicitud_pago', c.solicitudId, {
          accion: 'asignar_partidas',
          origen: 'asistente',
          proyecto_id: proyectoId,
          propuesta_id: propuestaId,
          partidas: c.lineas.length,
        });
      } catch (auditErr) {
        console.error('Error registrando audit del lote de partidas:', auditErr);
      }
    }

    const aplicados = [];
    for (const c of cambios) {
      aplicados.push({ solicitudId: c.solicitudId, partidas: await leerPartidasDePago(c.solicitudId) });
    }

    res.json({ success: true, data: { aplicados } });
  }),
);

export default router;
