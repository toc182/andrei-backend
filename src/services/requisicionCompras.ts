/**
 * Comprar lo que pide una requisición: la solicitud de pago o la orden de
 * compra que nace de ella (Ivan, 2026-10-05; plan aprobado el 2026-10-07).
 *
 * Compras escoge las líneas que compra y a qué cotización le compra. La
 * solicitud se crea con el MISMO formulario y la MISMA ruta de siempre, que
 * traen además `desde_requisicion`; al guardarse:
 *
 *   * queda amarrada a esas líneas (requisicion_linea_compras), que pasan a
 *     Atendida, o a Parcial si así se escogió;
 *   * recuerda a qué cotización se le compró (requisicion_cotizacion_id): de
 *     ahí sale la «Comprada · SI-041» de Cotizaciones;
 *   * lleva adjuntas las cotizaciones y los cuadros de esas líneas, y el papel
 *     de la requisición con esas líneas marcadas.
 *
 * Lo primero va dentro de la transacción que crea la solicitud. Los archivos
 * van después, igual que los que sube el formulario: si uno falla, la solicitud
 * queda y se avisa cuál no se adjuntó.
 */
import crypto from 'crypto';
import type { PoolClient } from 'pg';
import { query } from '../database/config.js';
import { registrarAudit } from './auditLog.js';
import { copyFile, uploadFile } from './storage.js';
import { ES_CONSORCIO_SQL, consorcioDelProyecto } from './consorcioProyecto.js';
import { lineasDe, puedeAtender, traer, type ConUsuario, type RequisicionRow } from './requisicionAcceso.js';

export type MarcaCompra = 'atendida' | 'parcial';

interface Archivo {
  id: number;
  nombre_original: string;
  r2_key: string;
  tipo_mime: string | null;
  tamano: number | null;
  /** Lo que dice al lado del archivo en la orden («Cotización · Aceros del Istmo»). */
  descripcion: string;
}

/** Lo que Compras escogió, ya revisado contra la base. */
export interface CompraDesdeRequisicion {
  requisicion: RequisicionRow;
  lineas: { id: number; marca: MarcaCompra }[];
  cotizacionId: number | null;
  /** Las cotizaciones y los cuadros comparativos que van adjuntos. */
  archivos: Archivo[];
  /** Si va también el papel de la requisición. */
  papel: boolean;
}

/** La solicitud o la orden que se acaba de crear. */
export interface Destino {
  tipo: 'solicitud' | 'orden';
  id: number;
  numero: string;
  proveedor: string;
}

const MARCAS_COMPRA: MarcaCompra[] = ['atendida', 'parcial'];

/** Una lista de ids que viene del navegador; null si no es una lista de enteros. */
function listaDeIds(v: unknown): number[] | null {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) return null;
  const n = v.map(Number);
  return n.every(Number.isInteger) ? [...new Set(n)] : null;
}

/**
 * Lee y revisa `desde_requisicion`. Sin él devuelve null: la solicitud de
 * siempre. Con él, o el error para la persona o lo escogido.
 */
export async function leerCompra(
  req: ConUsuario,
  crudo: unknown,
  proyectoId: number,
): Promise<{ error: string; status: number } | CompraDesdeRequisicion | null> {
  if (crudo === undefined || crudo === null) return null;
  const b = crudo as Record<string, unknown>;

  const requisicionId = Number(b.requisicion_id);
  const r = Number.isInteger(requisicionId) && requisicionId > 0 ? await traer(requisicionId) : null;
  if (!r) return { status: 404, error: 'Requisición no encontrada' };
  if (r.proyecto_id !== Number(proyectoId)) {
    return { status: 400, error: 'La requisición es de otro proyecto' };
  }
  if (!(await puedeAtender(req, r))) {
    return r.estado === 'aprobada'
      ? { status: 403, error: 'Lo que sale de una requisición lo crea Compras' }
      : { status: 400, error: 'Solo se compra lo de una requisición aprobada' };
  }

  if (!Array.isArray(b.lineas) || b.lineas.length === 0) {
    return { status: 400, error: 'Escoge qué líneas de la requisición van' };
  }
  const propias = new Set((await lineasDe(r.id)).map((l) => l.id));
  const lineas: { id: number; marca: MarcaCompra }[] = [];
  for (const x of b.lineas as { id?: unknown; marca?: unknown }[]) {
    const id = Number(x?.id);
    const marca = (x?.marca ?? 'atendida') as MarcaCompra;
    if (!propias.has(id) || !MARCAS_COMPRA.includes(marca)) {
      return { status: 400, error: 'Cada línea tiene que ser de la requisición, y quedar Atendida o Parcial' };
    }
    if (!lineas.some((l) => l.id === id)) lineas.push({ id, marca });
  }
  const idsLineas = lineas.map((l) => l.id);

  // La cotización a la que se le compra tiene que cubrir alguna de las líneas
  // que van: comprarle a otro proveedor es «Otro proveedor», sin cotización.
  let cotizacionId: number | null = null;
  if (b.cotizacion_id !== undefined && b.cotizacion_id !== null && b.cotizacion_id !== '') {
    const c = await query(
      `SELECT 1 FROM requisicion_cotizaciones rc
        WHERE rc.id = $1 AND rc.requisicion_id = $2 AND rc.activo
          AND EXISTS (SELECT 1 FROM cotizacion_ofertas o
                        JOIN cotizaciones ct ON ct.id = o.cotizacion_id
                       WHERE o.requisicion_cotizacion_id = rc.id AND o.activo
                         AND ct.requisicion_linea_id = ANY($3::int[]))`,
      [Number(b.cotizacion_id), r.id, idsLineas],
    );
    if (c.rows.length === 0) return { status: 400, error: 'Esa cotización no cubre ninguna de esas líneas' };
    cotizacionId = Number(b.cotizacion_id);
  }

  const adj = (b.adjuntar ?? {}) as Record<string, unknown>;
  const idsCot = listaDeIds(adj.cotizaciones);
  const idsCuadros = listaDeIds(adj.cuadros);
  if (!idsCot || !idsCuadros) return { status: 400, error: 'Los adjuntos no vinieron bien' };
  const cotizaciones = idsCot.length
    ? (
        await query<Archivo>(
          `SELECT id, nombre_original, r2_key, tipo_mime, tamano, 'Cotización · ' || proveedor AS descripcion
             FROM requisicion_cotizaciones
            WHERE requisicion_id = $1 AND activo AND id = ANY($2::int[]) ORDER BY created_at, id`,
          [r.id, idsCot],
        )
      ).rows
    : [];
  const cuadros = idsCuadros.length
    ? (
        await query<Archivo>(
          `SELECT id, nombre_original, r2_key, tipo_mime, tamano, 'Cuadro comparativo' AS descripcion
             FROM requisicion_adjuntos
            WHERE requisicion_id = $1 AND activo AND tipo = 'cuadro_comparativo' AND id = ANY($2::int[])
            ORDER BY created_at, id`,
          [r.id, idsCuadros],
        )
      ).rows
    : [];
  if (cotizaciones.length !== idsCot.length || cuadros.length !== idsCuadros.length) {
    return { status: 400, error: 'Algún adjunto no es de esta requisición' };
  }

  return { requisicion: r, lineas, cotizacionId, archivos: [...cotizaciones, ...cuadros], papel: adj.papel === true };
}

/**
 * Amarra la solicitud o la orden a la requisición, dentro de la transacción
 * que la crea: sus líneas, sus marcas y la cotización a la que se le compró.
 */
export async function enlazarCompra(
  client: PoolClient,
  compra: CompraDesdeRequisicion,
  destino: Destino,
  userId: number,
): Promise<void> {
  const r = compra.requisicion;
  if (destino.tipo === 'solicitud') {
    await client.query(
      'UPDATE solicitudes_pago SET requisicion_id = $1, requisicion_cotizacion_id = $2 WHERE id = $3',
      [r.id, compra.cotizacionId, destino.id],
    );
  } else {
    await client.query(
      'UPDATE ordenes_compra SET requisicion_id = $1, requisicion_cotizacion_id = $2 WHERE id = $3',
      [r.id, compra.cotizacionId, destino.id],
    );
  }

  const todas = await lineasDe(r.id, client);
  const numero = new Map(todas.map((l, i) => [l.id, i + 1]));
  const antes = new Map(todas.map((l) => [l.id, l.marca]));
  for (const l of compra.lineas) {
    await client.query(
      `INSERT INTO requisicion_linea_compras (linea_id, solicitud_pago_id, orden_compra_id, creado_por)
       VALUES ($1, $2, $3, $4)`,
      [l.id, destino.tipo === 'solicitud' ? destino.id : null, destino.tipo === 'orden' ? destino.id : null, userId],
    );
    if (antes.get(l.id) !== l.marca) {
      await client.query(
        `UPDATE requisicion_lineas SET marca = $1, marca_por = $2, marca_at = CURRENT_TIMESTAMP
          WHERE id = $3 AND requisicion_id = $4`,
        [l.marca, userId, l.id, r.id],
      );
    }
  }

  await registrarAudit(
    userId,
    destino.tipo === 'solicitud' ? 'crear_solicitud' : 'crear_orden',
    'requisicion',
    r.id,
    {
      numero: r.numero,
      [destino.tipo]: destino.numero,
      proveedor: destino.proveedor,
      lineas: compra.lineas.map((l) => ({ linea: numero.get(l.id), antes: antes.get(l.id), despues: l.marca })),
    },
    client,
  );
}

function limpiarNombre(nombre: string): string {
  return nombre
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_');
}

/** La clave del archivo en R2, con la misma forma que usa cada módulo. */
function claveDestino(destino: Destino, nombre: string): string {
  return destino.tipo === 'solicitud'
    ? `solicitudes-pago/${destino.id}/${crypto.randomUUID()}_${limpiarNombre(nombre)}`
    : `ordenes-compra/${destino.numero}/${Date.now()}-${limpiarNombre(nombre)}`;
}

async function insertarAdjunto(
  destino: Destino,
  a: { nombre: string; key: string; mime: string; tamano: number; descripcion: string },
  userId: number,
): Promise<void> {
  if (destino.tipo === 'solicitud') {
    await query(
      `INSERT INTO solicitud_pago_adjuntos (solicitud_pago_id, nombre_original, r2_key, tipo_mime, tamano, subido_por)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [destino.id, a.nombre, a.key, a.mime, a.tamano, userId],
    );
  } else {
    await query(
      `INSERT INTO orden_compra_adjuntos (orden_compra_id, nombre_original, r2_key, tipo_mime, tamano, descripcion, subido_por)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [destino.id, a.nombre, a.key, a.mime, a.tamano, a.descripcion, userId],
    );
  }
}

/**
 * Adjunta a la solicitud o la orden recién creada lo que va con ella. Devuelve
 * los nombres de lo que no se pudo adjuntar, para avisar.
 */
export async function adjuntarCompra(
  compra: CompraDesdeRequisicion,
  destino: Destino,
  userId: number,
): Promise<string[]> {
  const fallidos: string[] = [];
  const adjuntados: string[] = [];
  // La copia es de la solicitud: si Compras quita después la cotización de la
  // requisición, el papel que ya se mandó a pagar no se queda sin él.
  for (const a of compra.archivos) {
    try {
      const key = claveDestino(destino, a.nombre_original);
      await copyFile(a.r2_key, key);
      await insertarAdjunto(
        destino,
        {
          nombre: a.nombre_original,
          key,
          mime: a.tipo_mime ?? 'application/octet-stream',
          tamano: a.tamano ?? 0,
          descripcion: a.descripcion,
        },
        userId,
      );
      adjuntados.push(a.nombre_original);
    } catch (err) {
      console.error(`No se pudo adjuntar ${a.nombre_original} a ${destino.numero}:`, err);
      fallidos.push(a.nombre_original);
    }
  }
  if (compra.papel) {
    const nombre = `${compra.requisicion.numero}.pdf`;
    try {
      const pdf = await papelDeRequisicion(compra.requisicion, {
        numero: destino.numero,
        proveedor: destino.proveedor,
        tipo: destino.tipo,
        lineas: new Set(compra.lineas.map((l) => l.id)),
      });
      const key = claveDestino(destino, nombre);
      await uploadFile(key, pdf, 'application/pdf');
      await insertarAdjunto(
        destino,
        { nombre, key, mime: 'application/pdf', tamano: pdf.length, descripcion: `Requisición ${compra.requisicion.numero}` },
        userId,
      );
      adjuntados.push(nombre);
    } catch (err) {
      console.error(`No se pudo adjuntar el papel de ${compra.requisicion.numero} a ${destino.numero}:`, err);
      fallidos.push(nombre);
    }
  }
  // Ya creada la solicitud, nada de aquí puede tumbar la respuesta.
  if (adjuntados.length > 0) {
    await registrarAudit(
      userId,
      'adjuntar',
      destino.tipo === 'solicitud' ? 'solicitud_pago' : 'orden_compra',
      destino.id,
      { archivos: adjuntados, desde: compra.requisicion.numero },
    ).catch((err) => console.error('No se pudo anotar el rastro de los adjuntos:', err));
  }
  return fallidos;
}

/**
 * El papel de la requisición. Con `adjunta`, el que va pegado a una solicitud
 * u orden: dice a cuál y marca las líneas que van en ella.
 */
export async function papelDeRequisicion(
  r: RequisicionRow,
  adjunta?: { numero: string; proveedor: string; tipo: 'solicitud' | 'orden'; lineas: Set<number> },
): Promise<Buffer> {
  const cab = await query<{
    proyecto_nombre: string;
    es_consorcio: boolean;
    contratista: string | null;
    logo_consorcio: string | null;
    escrita_por: string;
    aprobada_por: string | null;
  }>(
    `SELECT COALESCE(NULLIF(p.nombre_corto, ''), p.nombre) AS proyecto_nombre,
            ${ES_CONSORCIO_SQL} AS es_consorcio, p.contratista, p.logo_consorcio,
            uc.nombre AS escrita_por, ua.nombre AS aprobada_por
       FROM requisiciones r
       JOIN proyectos p ON p.id = r.proyecto_id
       JOIN users uc ON uc.id = r.creado_por
       LEFT JOIN users ua ON ua.id = r.aprobada_por
      WHERE r.id = $1`,
    [r.id],
  );
  const c = cab.rows[0];
  const lineas = await lineasDe(r.id);

  // Puppeteer pesa: se carga cuando hace falta un papel, no al arrancar.
  const { generarRequisicionPDF } = await import('./requisicionPdf.js');
  return generarRequisicionPDF({
    numero: r.numero,
    creada_at: r.created_at,
    proyecto_nombre: c.proyecto_nombre,
    consorcio: consorcioDelProyecto(c),
    descripcion: r.descripcion,
    fecha_requerida: r.fecha_requerida,
    prioridad: r.prioridad,
    estado: r.estado,
    escrita_por: c.escrita_por,
    aprobada_por: c.aprobada_por,
    aprobada_at: r.aprobada_at,
    notas: r.notas,
    beneficiario: r.beneficiario,
    banco: r.banco,
    tipo_cuenta: r.tipo_cuenta,
    numero_cuenta: r.numero_cuenta,
    lineas: lineas.map((l, i) => ({
      numero: i + 1,
      cantidad: l.cantidad,
      unidad: l.unidad,
      descripcion: l.descripcion,
      renglon_desglose: l.renglon_desglose,
      marca: l.marca,
      enEsta: adjunta ? adjunta.lineas.has(l.id) : undefined,
    })),
    adjuntaA: adjunta ? { numero: adjunta.numero, proveedor: adjunta.proveedor, tipo: adjunta.tipo } : null,
    generado_at: new Date(),
  });
}
