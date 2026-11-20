import type { PoolClient } from 'pg';
import {
  deCentavos,
  dineroCentavos,
  estadoSegunPagos,
  leerMonto,
  type EstadoPorPagos,
  type SaldoSolicitud,
} from './pagosSolicitud.js';
import { fecha } from '../utils/fechas.js';

/**
 * Corregir y anular los pagos de una solicitud (tema 19, paso 5; migración 191).
 *
 * Ivan, 2026-11-18: un pago mal registrado lo corrige o lo anula un admin, con un
 * motivo, y queda en el historial. Va dentro de la «Corregir solicitud» de
 * siempre (POST /solicitudes-pago/:id/corregir): el mismo motivo y la misma
 * línea del historial cubren el total, la factura y los pagos.
 *
 * Las reglas:
 * - un pago corregido cambia de monto o de fecha; uno anulado se queda en la
 *   base (activo = false, quién, cuándo y el motivo) y deja de contar;
 * - el estado sale de estadoSegunPagos(), la misma regla que al pagar: anulados
 *   todos, la solicitud vuelve a «Por pagar»;
 * - si estaba pagada completa y solo cambia el total, el ÚLTIMO pago se mueve por
 *   la diferencia y sigue pagada (así funcionaba antes de los pagos parciales);
 *   si el admin toca los montos él mismo, manda lo que escribió;
 * - lo pagado nunca pasa del total, y una solicitud con el reembolso a Pinellas
 *   ya registrado (por el total) no puede quedar con saldo.
 */

const ETIQUETA_ESTADO: Record<string, string> = {
  aprobada: 'Por pagar',
  abonada: 'Abonada',
  pagada: 'Pagada',
  facturada: 'Facturada',
};
const etiqueta = (estado: string) => ETIQUETA_ESTADO[estado] ?? estado;

const MAX_ARCHIVOS_POR_PAGO = 5;

interface EdicionPago {
  fecha?: string;
  montoCentavos?: number;
  anular: boolean;
}

export interface PedidoPagos {
  ediciones: Map<number, EdicionPago>;
  archivos: Map<number, Express.Multer.File[]>;
}

/** «2026-11-17» que existe en el calendario. */
function esFecha(valor: unknown): valor is string {
  if (typeof valor !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(valor)) return false;
  const [a, m, d] = valor.split('-').map(Number);
  const dia = new Date(Date.UTC(a, m - 1, d));
  return dia.getUTCFullYear() === a && dia.getUTCMonth() === m - 1 && dia.getUTCDate() === d;
}

/**
 * Lo que la ventana pide hacer con los pagos: el campo `pagos` (JSON, una
 * entrada por pago: { id, fecha_pago?, monto?, anular? }) y los archivos de
 * comprobante nuevos, en el campo `archivos_pago_<id>` de cada pago. No lee la
 * base: que cada id sea un pago activo de la solicitud lo revisa corregirPagos().
 */
export function leerPedidoPagos(
  pagosCrudo: unknown,
  archivos: Express.Multer.File[],
): PedidoPagos | { error: string } {
  let lista: unknown = [];
  if (typeof pagosCrudo === 'string' && pagosCrudo.trim() !== '') {
    try {
      lista = JSON.parse(pagosCrudo);
    } catch {
      return { error: 'Los pagos de la corrección no se pudieron leer' };
    }
  } else if (pagosCrudo !== undefined && pagosCrudo !== '') {
    lista = pagosCrudo;
  }
  if (!Array.isArray(lista)) {
    return { error: 'Los pagos de la corrección no se pudieron leer' };
  }

  const ediciones = new Map<number, EdicionPago>();
  for (const crudo of lista) {
    const e = crudo as { id?: unknown; fecha_pago?: unknown; monto?: unknown; anular?: unknown };
    if (!e || typeof e !== 'object' || !Number.isInteger(e.id) || ediciones.has(e.id as number)) {
      return { error: 'Los pagos de la corrección no se pudieron leer' };
    }
    const edicion: EdicionPago = { anular: e.anular === true };
    if (e.fecha_pago !== undefined) {
      if (!esFecha(e.fecha_pago)) return { error: 'La fecha de un pago no es válida' };
      edicion.fecha = e.fecha_pago;
    }
    if (e.monto !== undefined) {
      const centavos = leerMonto(e.monto);
      if (centavos === null) return { error: 'El monto de un pago no es válido' };
      edicion.montoCentavos = centavos;
    }
    if (edicion.anular && (edicion.fecha !== undefined || edicion.montoCentavos !== undefined)) {
      return { error: 'Un pago que se anula no se corrige al mismo tiempo' };
    }
    ediciones.set(e.id as number, edicion);
  }

  const porPago = new Map<number, Express.Multer.File[]>();
  for (const archivo of archivos) {
    if (archivo.fieldname === 'archivos_factura') continue;
    const m = /^archivos_pago_(\d+)$/.exec(archivo.fieldname);
    if (!m) return { error: 'La corrección trae un archivo que no es de ningún pago' };
    const pagoId = Number(m[1]);
    const del = porPago.get(pagoId) ?? [];
    del.push(archivo);
    if (del.length > MAX_ARCHIVOS_POR_PAGO) {
      return { error: `Cada pago lleva hasta ${MAX_ARCHIVOS_POR_PAGO} archivos de comprobante` };
    }
    porPago.set(pagoId, del);
    if (ediciones.get(pagoId)?.anular) {
      return { error: 'Un pago que se anula no recibe comprobante nuevo' };
    }
  }

  return { ediciones, archivos: porPago };
}

/** Lo que una corrección de pagos deja escrito en el historial. */
export type CambioPago =
  | {
      campo: 'pago';
      pago_id: number;
      descripcion: string;
      cambios: { campo: 'monto' | 'fecha_pago'; anterior: string; nuevo: string }[];
      /** El pago lo movió el sistema al cambiar el total de una pagada completa. */
      ajuste_automatico?: true;
    }
  | { campo: 'pago_anulado'; pago_id: number; descripcion: string }
  | { campo: 'comprobante'; pago_id: number; descripcion: string; anterior: string; nuevo: string }
  | { campo: 'estado'; anterior: string; nuevo: string };

export type ResultadoPagos =
  | { error: string }
  | {
      cambios: CambioPago[];
      estado: EstadoPorPagos;
      pagadoCentavos: number;
      saldoCentavos: number;
      /** Archivos de comprobante reemplazados: se borran de R2 después del COMMIT. */
      clavesViejas: string[];
    };

interface PagoActivo {
  id: number;
  fecha: string;
  montoCentavos: number;
}

/**
 * Aplica a los pagos lo pedido, dentro de la transacción de la corrección y con
 * la fila de la solicitud ya bloqueada (leerSaldoBloqueando). Devuelve los
 * cambios para el historial y el estado que le toca a la solicitud; quien llama
 * lo guarda junto con el resto. Con `error`, quien llama deshace todo.
 */
export async function corregirPagos(
  client: PoolClient,
  a: {
    solicitudId: number;
    userId: number;
    motivo: string;
    sol: SaldoSolicitud;
    totalNuevoCentavos: number;
    pedido: PedidoPagos;
    /** Sube un archivo de comprobante y lo deja enlazado a su pago. */
    subirArchivo: (pagoId: number, archivo: Express.Multer.File) => Promise<void>;
  },
): Promise<ResultadoPagos> {
  const { sol, pedido, totalNuevoCentavos } = a;

  const filas = await client.query<{ id: number; fecha: string; monto: string }>(
    `SELECT id, to_char(fecha_pago, 'YYYY-MM-DD') AS fecha, monto::text
       FROM comprobantes_pago
      WHERE solicitud_pago_id = $1 AND activo
      ORDER BY fecha_pago, id`,
    [a.solicitudId],
  );
  const activos: PagoActivo[] = filas.rows.map((f) => ({
    id: f.id,
    fecha: f.fecha,
    montoCentavos: Math.round(Number(f.monto) * 100),
  }));
  const porId = new Map(activos.map((p) => [p.id, p]));
  for (const pagoId of [...pedido.ediciones.keys(), ...pedido.archivos.keys()]) {
    if (!porId.has(pagoId)) {
      return { error: 'Uno de los pagos no es de esta solicitud o ya está anulado' };
    }
  }

  // Cómo queda cada pago.
  const quedan = activos.map((p) => {
    const e = pedido.ediciones.get(p.id);
    return {
      ...p,
      fechaNueva: e?.fecha ?? p.fecha,
      montoNuevo: e?.montoCentavos ?? p.montoCentavos,
      anulado: e?.anular === true,
      automatico: false,
    };
  });

  // Pagada completa y solo cambió el total: el último pago absorbe la diferencia.
  const tocaMontos = [...pedido.ediciones.values()].some(
    (e) => e.anular || e.montoCentavos !== undefined,
  );
  const diferencia = totalNuevoCentavos - sol.totalCentavos;
  if (sol.pagos > 0 && sol.saldoCentavos === 0 && diferencia !== 0 && !tocaMontos) {
    const ultimo = [...quedan].sort((x, y) =>
      x.fechaNueva === y.fechaNueva ? y.id - x.id : x.fechaNueva < y.fechaNueva ? 1 : -1,
    )[0];
    ultimo.montoNuevo += diferencia;
    ultimo.automatico = true;
    if (ultimo.montoNuevo <= 0) {
      return {
        error: `Con el nuevo total (${dineroCentavos(totalNuevoCentavos)}) el último pago quedaría en cero o menos. Corrija o anule los pagos en esta misma ventana.`,
      };
    }
  }

  const vigentes = quedan.filter((p) => !p.anulado);
  const pagadoCentavos = vigentes.reduce((s, p) => s + p.montoNuevo, 0);
  if (pagadoCentavos > totalNuevoCentavos) {
    return {
      error: `Lo pagado (${dineroCentavos(pagadoCentavos)}) pasa del total de la solicitud (${dineroCentavos(totalNuevoCentavos)})`,
    };
  }
  const saldoCentavos = totalNuevoCentavos - pagadoCentavos;

  if (saldoCentavos > 0) {
    const reembolso = await client.query(
      'SELECT 1 FROM reembolsos_pinellas WHERE solicitud_pago_id = $1',
      [a.solicitudId],
    );
    if (reembolso.rows.length > 0) {
      return {
        error: 'Esta solicitud ya tiene registrado el reembolso a Pinellas por el total: no puede quedar con saldo',
      };
    }
  }

  const estado = estadoSegunPagos({
    tipo: sol.tipo,
    pagos: vigentes.length,
    saldoCentavos,
    conFactura: sol.conFactura,
  });

  // Escribir, y anotar cada cambio.
  const cambios: CambioPago[] = [];
  const clavesViejas: string[] = [];
  for (const p of quedan) {
    const descripcion = `Pago del ${fecha(p.fecha)}`;
    if (p.anulado) {
      await client.query(
        `UPDATE comprobantes_pago
            SET activo = false, anulado_por = $1, anulado_at = CURRENT_TIMESTAMP, motivo_anulacion = $2
          WHERE id = $3`,
        [a.userId, a.motivo, p.id],
      );
      cambios.push({
        campo: 'pago_anulado',
        pago_id: p.id,
        descripcion: `${descripcion} por ${dineroCentavos(p.montoCentavos)}`,
      });
      continue;
    }

    const delPago: { campo: 'monto' | 'fecha_pago'; anterior: string; nuevo: string }[] = [];
    if (p.montoNuevo !== p.montoCentavos) {
      delPago.push({ campo: 'monto', anterior: deCentavos(p.montoCentavos), nuevo: deCentavos(p.montoNuevo) });
    }
    if (p.fechaNueva !== p.fecha) {
      delPago.push({ campo: 'fecha_pago', anterior: p.fecha, nuevo: p.fechaNueva });
    }
    if (delPago.length > 0) {
      await client.query(
        'UPDATE comprobantes_pago SET monto = $1, fecha_pago = $2 WHERE id = $3',
        [deCentavos(p.montoNuevo), p.fechaNueva, p.id],
      );
      cambios.push({
        campo: 'pago',
        pago_id: p.id,
        descripcion,
        cambios: delPago,
        ...(p.automatico ? { ajuste_automatico: true as const } : {}),
      });
    }

    const nuevos = pedido.archivos.get(p.id);
    if (nuevos && nuevos.length > 0) {
      const viejos = await client.query<{ r2_key: string; nombre_original: string }>(
        'SELECT r2_key, nombre_original FROM solicitud_pago_adjuntos WHERE comprobante_pago_id = $1 ORDER BY id',
        [p.id],
      );
      await client.query('DELETE FROM solicitud_pago_adjuntos WHERE comprobante_pago_id = $1', [p.id]);
      clavesViejas.push(...viejos.rows.map((v) => v.r2_key));
      for (const archivo of nuevos) await a.subirArchivo(p.id, archivo);
      cambios.push({
        campo: 'comprobante',
        pago_id: p.id,
        descripcion,
        anterior: viejos.rows.map((v) => v.nombre_original).join(', ') || '—',
        nuevo: nuevos.map((f) => f.originalname).join(', '),
      });
    }
  }

  if (estado !== sol.estado) {
    cambios.push({ campo: 'estado', anterior: etiqueta(sol.estado), nuevo: etiqueta(estado) });
  }

  return { cambios, estado, pagadoCentavos, saldoCentavos, clavesViejas };
}
