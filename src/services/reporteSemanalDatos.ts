/**
 * Los números de la semana: lo que el reporte semanal NO le pide a nadie.
 *
 * Todo lo que aquí se calcula sale de los reportes diarios de esos siete días y
 * de las solicitudes ya pagadas del proyecto. La IA no toca ni uno: escribe el
 * resumen y los problemas, y los números los pone la base (decisión de Ivan,
 * 2026-09-16).
 *
 * Mientras el reporte semanal es borrador esto se calcula al vuelo, porque los
 * diarios todavía se mueven. Al enviarlo, el resultado se guarda tal cual en
 * `proyecto_reportes_semanales.datos` y ya no se vuelve a calcular: el reporte
 * queda como salió por correo. Por eso las filas de aquí son datos planos, sin
 * ids ni nada que dependa de que lo de al lado siga existiendo.
 *
 * Los días van siempre de lunes a domingo, los siete, y un día sin reporte
 * diario lleva `null` —no cero—: no es que no hubiera nadie en la obra, es que
 * nadie lo reportó.
 */

import { query } from '../database/config.js';
import { diasDeLaSemana, domingoDe, lunesDe } from './reporteSemana.js';

export interface DiaDeLaSemana {
  fecha: string;
  /** El reporte diario de ese día; null si no hay. */
  numero: string | null;
}

export interface FilaPorDia {
  nombre: string;
  /** Siete casillas, de lunes a domingo. null = ese día no tiene reporte. */
  por_dia: (number | null)[];
  total: number;
}

export interface DatosSemana {
  dias: DiaDeLaSemana[];
  /** Filas de personal agrupadas por empresa; null es la cuadrilla propia. */
  personal: { empresa: string | null; filas: FilaPorDia[] }[];
  personal_total: (number | null)[];
  personal_promedio: number | null;
  horas_perdidas: {
    por_dia: (number | null)[];
    total: number;
    motivos: { fecha: string; horas: number; motivo: string | null }[];
  };
  equipos: FilaPorDia[];
  materiales: {
    fecha: string;
    categoria: string;
    descripcion: string;
    cantidad: number | null;
    unidad: string | null;
    notas: string | null;
  }[];
  pagos: {
    filas: { categoria: string | null; solicitudes: number; monto: number }[];
    solicitudes: number;
    monto: number;
  };
  /** Esta semana contra la anterior. Solo lo comparable entre semanas. */
  comparacion: {
    semana_anterior: { inicio: string; fin: string };
    filas: { etiqueta: string; anterior: number | null; actual: number | null; unidad: string }[];
  };
}

const num = (v: string | number | null | undefined): number =>
  v === null || v === undefined ? 0 : typeof v === 'number' ? v : parseFloat(v);

/** Una fecha DATE de `pg` como `YYYY-MM-DD`, en el día que dice la base. */
function ymd(fecha: Date | string): string {
  if (fecha instanceof Date) {
    const y = fecha.getFullYear();
    const m = String(fecha.getMonth() + 1).padStart(2, '0');
    const d = String(fecha.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(fecha).slice(0, 10);
}

/**
 * Reparte filas «una por día» en las siete casillas de la semana.
 *
 * `conReporte` dice qué días tienen reporte diario: los que no lo tienen se
 * quedan en null aunque la suma de ese día sea cero.
 */
function enSieteDias(
  dias: string[],
  conReporte: Set<string>,
  valores: Map<string, number>,
): { por_dia: (number | null)[]; total: number } {
  let total = 0;
  const por_dia = dias.map((d) => {
    if (!conReporte.has(d)) return null;
    const v = valores.get(d) ?? 0;
    total += v;
    return v;
  });
  return { por_dia, total };
}

/** Lo poco que se compara entre una semana y otra. */
async function resumenComparable(
  proyectoId: number,
  lunes: string,
): Promise<{ promedio: number | null; horas: number; equipos: Map<string, number> }> {
  // Los días se cuentan por fecha y no por reporte: dos turnos del mismo día
  // son un día, y si no, el promedio de gente por día saldría a la mitad.
  const r = await query<{ dias: string; total: string }>(
    `SELECT COUNT(DISTINCT r.fecha)::text AS dias,
            COALESCE(SUM(p.cantidad), 0)::text AS total
       FROM proyecto_reportes r
       LEFT JOIN proyecto_reporte_personal p ON p.reporte_id = r.id
      WHERE r.proyecto_id = $1 AND r.activo = true AND r.completo = true
        AND r.fecha BETWEEN $2::date AND $2::date + 6`,
    [proyectoId, lunes],
  );
  // Las horas perdidas van en su propia consulta: en la de arriba, el JOIN con
  // el personal repetiría las horas de un día por cada puesto que tenga.
  const h = await query<{ horas: string }>(
    `SELECT COALESCE(SUM(horas_perdidas), 0)::text AS horas
       FROM proyecto_reportes
      WHERE proyecto_id = $1 AND activo = true AND completo = true
        AND fecha BETWEEN $2::date AND $2::date + 6`,
    [proyectoId, lunes],
  );
  const dias = parseInt(r.rows[0]?.dias ?? '0', 10);
  const total = num(r.rows[0]?.total);

  const eq = await query<{ nombre: string; horas: string }>(
    `SELECT q.nombre, COALESCE(SUM(e.horas), 0)::text AS horas
       FROM proyecto_reportes r
       JOIN proyecto_reporte_equipos e ON e.reporte_id = r.id
       JOIN proyecto_equipos q ON q.id = e.equipo_id
      WHERE r.proyecto_id = $1 AND r.activo = true AND r.completo = true
        AND r.fecha BETWEEN $2::date AND $2::date + 6
      GROUP BY q.nombre`,
    [proyectoId, lunes],
  );

  return {
    promedio: dias === 0 ? null : Math.round(total / dias),
    horas: num(h.rows[0]?.horas),
    equipos: new Map(eq.rows.map((x) => [x.nombre, num(x.horas)])),
  };
}

/** Todos los números de esa semana, listos para la pantalla y para el papel. */
export async function datosDeLaSemana(
  proyectoId: number,
  cualquierDia: string,
): Promise<DatosSemana> {
  const lunes = lunesDe(cualquierDia);
  const domingo = domingoDe(cualquierDia);
  const dias = diasDeLaSemana(lunes);

  // ---- qué días tienen reporte diario ----
  const diarios = await query<{ fecha: Date; numero: string }>(
    `SELECT fecha, numero FROM proyecto_reportes
      WHERE proyecto_id = $1 AND activo = true AND completo = true
        AND fecha BETWEEN $2 AND $3
      ORDER BY fecha, id`,
    [proyectoId, lunes, domingo],
  );
  // Un día puede tener más de un reporte (dos turnos, alguien cubriendo): en la
  // semana se suman, y el día se nombra con el primero.
  const numeroDelDia = new Map<string, string>();
  for (const d of diarios.rows) {
    const f = ymd(d.fecha);
    if (!numeroDelDia.has(f)) numeroDelDia.set(f, d.numero);
  }
  const conReporte = new Set(numeroDelDia.keys());

  // ---- personal ----
  const personalRows = await query<{
    empresa: string | null; puesto: string; fecha: Date; cantidad: string; orden: number;
  }>(
    `SELECT e.nombre AS empresa, pu.nombre AS puesto, r.fecha,
            SUM(p.cantidad)::text AS cantidad, MIN(pu.orden) AS orden
       FROM proyecto_reportes r
       JOIN proyecto_reporte_personal p ON p.reporte_id = r.id
       JOIN proyecto_puestos pu ON pu.id = p.puesto_id
       LEFT JOIN proyecto_empresas e ON e.id = pu.empresa_id
      WHERE r.proyecto_id = $1 AND r.activo = true AND r.completo = true
        AND r.fecha BETWEEN $2 AND $3
      GROUP BY e.nombre, pu.nombre, r.fecha
      ORDER BY MIN(pu.orden), pu.nombre`,
    [proyectoId, lunes, domingo],
  );

  const porEmpresa = new Map<string | null, Map<string, Map<string, number>>>();
  for (const row of personalRows.rows) {
    const empresa = row.empresa ?? null;
    if (!porEmpresa.has(empresa)) porEmpresa.set(empresa, new Map());
    const puestos = porEmpresa.get(empresa)!;
    if (!puestos.has(row.puesto)) puestos.set(row.puesto, new Map());
    puestos.get(row.puesto)!.set(ymd(row.fecha), num(row.cantidad));
  }
  const personal = [...porEmpresa.entries()].map(([empresa, puestos]) => ({
    empresa,
    filas: [...puestos.entries()].map(([nombre, valores]) => ({
      nombre,
      ...enSieteDias(dias, conReporte, valores),
    })),
  }));

  const totalPorDia = dias.map((d, i) => {
    if (!conReporte.has(d)) return null;
    let t = 0;
    for (const { filas } of personal) {
      for (const f of filas) t += f.por_dia[i] ?? 0;
    }
    return t;
  });
  const diasConGente = totalPorDia.filter((v): v is number => v !== null);
  const promedio = diasConGente.length === 0
    ? null
    : Math.round(diasConGente.reduce((a, b) => a + b, 0) / diasConGente.length);

  // ---- horas perdidas ----
  const horasRows = await query<{ fecha: Date; horas: string | null; motivo: string | null }>(
    `SELECT fecha, horas_perdidas AS horas, motivo
       FROM proyecto_reportes
      WHERE proyecto_id = $1 AND activo = true AND completo = true
        AND fecha BETWEEN $2 AND $3
      ORDER BY fecha, id`,
    [proyectoId, lunes, domingo],
  );
  const horasPorDia = new Map<string, number>();
  const motivos: { fecha: string; horas: number; motivo: string | null }[] = [];
  for (const row of horasRows.rows) {
    const f = ymd(row.fecha);
    const h = num(row.horas);
    horasPorDia.set(f, (horasPorDia.get(f) ?? 0) + h);
    if (h > 0) motivos.push({ fecha: f, horas: h, motivo: row.motivo });
  }
  const horas = enSieteDias(dias, conReporte, horasPorDia);

  // ---- equipo ----
  const equipoRows = await query<{ nombre: string; fecha: Date; horas: string; orden: number }>(
    `SELECT q.nombre, r.fecha, SUM(e.horas)::text AS horas, MIN(q.orden) AS orden
       FROM proyecto_reportes r
       JOIN proyecto_reporte_equipos e ON e.reporte_id = r.id
       JOIN proyecto_equipos q ON q.id = e.equipo_id
      WHERE r.proyecto_id = $1 AND r.activo = true AND r.completo = true
        AND r.fecha BETWEEN $2 AND $3
      GROUP BY q.nombre, r.fecha
      ORDER BY MIN(q.orden), q.nombre`,
    [proyectoId, lunes, domingo],
  );
  const porEquipo = new Map<string, Map<string, number>>();
  for (const row of equipoRows.rows) {
    if (!porEquipo.has(row.nombre)) porEquipo.set(row.nombre, new Map());
    porEquipo.get(row.nombre)!.set(ymd(row.fecha), num(row.horas));
  }
  const equipos = [...porEquipo.entries()]
    .map(([nombre, valores]) => ({ nombre, ...enSieteDias(dias, conReporte, valores) }))
    // Una máquina que no trabajó ninguna hora esa semana no ocupa una fila.
    .filter((e) => e.total > 0);

  // ---- materiales ----
  const materialesRows = await query<{
    fecha: Date; categoria: string; descripcion: string;
    cantidad: string | null; unidad: string | null; notas: string | null;
  }>(
    `SELECT r.fecha, c.nombre AS categoria, en.descripcion, en.cantidad, en.unidad, en.notas
       FROM proyecto_reportes r
       JOIN proyecto_reporte_entregas en ON en.reporte_id = r.id
       JOIN proyecto_entrega_categorias c ON c.id = en.categoria_id
      WHERE r.proyecto_id = $1 AND r.activo = true AND r.completo = true
        AND r.fecha BETWEEN $2 AND $3
      ORDER BY r.fecha, en.id`,
    [proyectoId, lunes, domingo],
  );
  const materiales = materialesRows.rows.map((m) => ({
    fecha: ymd(m.fecha),
    categoria: m.categoria,
    descripcion: m.descripcion,
    cantidad: m.cantidad === null ? null : num(m.cantidad),
    unidad: m.unidad,
    notas: m.notas,
  }));

  // ---- pagos ----
  //
  // Las mismas solicitudes que cuenta la pantalla de Costos: pagadas o
  // facturadas, con la fecha de pago resuelta desde sus comprobantes. Es a
  // propósito «lo registrado en el sistema» y no «lo gastado»: hay pagos que
  // todavía no entran por aquí, y el papel lo dice con esas palabras.
  const pagosRows = await query<{ categoria: string | null; solicitudes: string; monto: string }>(
    `WITH pagadas AS (
       SELECT s.id, s.monto_total, s.categoria_id,
              COALESCE(MAX(c.fecha_pago), s.fecha) AS fecha_pago
         FROM solicitudes_pago s
         LEFT JOIN comprobantes_pago c ON c.solicitud_pago_id = s.id
        WHERE s.proyecto_id = $1 AND s.activo = TRUE
          AND s.estado IN ('pagada', 'facturada')
        GROUP BY s.id
     )
     SELECT cg.nombre AS categoria,
            COUNT(*)::text AS solicitudes,
            SUM(pg.monto_total)::text AS monto
       FROM pagadas pg
       LEFT JOIN categorias_gastos cg ON cg.id = pg.categoria_id
      WHERE pg.fecha_pago BETWEEN $2 AND $3
      GROUP BY cg.nombre, cg.orden
      ORDER BY cg.orden NULLS LAST, cg.nombre NULLS LAST`,
    [proyectoId, lunes, domingo],
  );
  const filasPagos = pagosRows.rows.map((p) => ({
    categoria: p.categoria,
    solicitudes: parseInt(p.solicitudes, 10),
    monto: num(p.monto),
  }));

  // ---- comparación con la semana anterior ----
  const lunesAnterior = lunesDe(
    ymd(new Date(new Date(`${lunes}T12:00:00Z`).getTime() - 7 * 24 * 60 * 60 * 1000)),
  );
  const [ahora, antes] = await Promise.all([
    resumenComparable(proyectoId, lunes),
    resumenComparable(proyectoId, lunesAnterior),
  ]);
  const nombresEquipo = [...new Set([...ahora.equipos.keys(), ...antes.equipos.keys()])].sort();
  const comparacion = {
    semana_anterior: { inicio: lunesAnterior, fin: domingoDe(lunesAnterior) },
    filas: [
      {
        etiqueta: 'Trabajadores por día (promedio)',
        anterior: antes.promedio,
        actual: ahora.promedio,
        unidad: '',
      },
      {
        etiqueta: 'Horas perdidas',
        anterior: antes.horas,
        actual: ahora.horas,
        unidad: 'h',
      },
      ...nombresEquipo.map((nombre) => ({
        etiqueta: nombre,
        anterior: antes.equipos.get(nombre) ?? null,
        actual: ahora.equipos.get(nombre) ?? null,
        unidad: 'h',
      })),
    ],
  };

  return {
    dias: dias.map((fecha) => ({ fecha, numero: numeroDelDia.get(fecha) ?? null })),
    personal,
    personal_total: totalPorDia,
    personal_promedio: promedio,
    horas_perdidas: { por_dia: horas.por_dia, total: horas.total, motivos },
    equipos,
    materiales,
    pagos: {
      filas: filasPagos,
      solicitudes: filasPagos.reduce((a, b) => a + b.solicitudes, 0),
      monto: filasPagos.reduce((a, b) => a + b.monto, 0),
    },
    comparacion,
  };
}
