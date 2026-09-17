/**
 * El borrador del reporte semanal escrito por la IA.
 *
 * Escribe DOS cosas y nada más: el resumen de la semana y la lista de problemas
 * con su día. Los números —personal, equipo, materiales, pagos— no pasan por
 * aquí: los calcula la base (reporteSemanalDatos.ts). Es la regla que puso Ivan
 * el 2026-09-16, y la razón es simple: un modelo puede equivocarse sumando y
 * nadie lo notaría hasta que el papel ya salió por correo.
 *
 * Tampoco escribe la «acción a tomar» de cada problema: eso es criterio de
 * obra, y lo pone el ingeniero.
 *
 * La llave de Anthropic es OPCIONAL, como la del correo: sin ella el botón
 * «Redactar con IA» no aparece y el reporte se escribe a mano, como siempre.
 */

import type Anthropic from '@anthropic-ai/sdk';
import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema';
import { estaConfigurado, obtenerCliente } from './asistentePagos/cliente.js';
import { query } from '../database/config.js';
import { diasDeLaSemana, domingoDe } from './reporteSemana.js';

export { estaConfigurado as iaConfigurada };

/**
 * El modelo. Se puede cambiar sin tocar código, con ANTHROPIC_MODELO_REPORTES.
 *
 * Opus y no Sonnet —al revés que el asistente de pagos— porque aquí lo que se
 * pide es redacción: un párrafo que un ingeniero mande sin reescribirlo. Son
 * unos pocos reportes por semana y por proyecto, así que la diferencia de costo
 * es de centavos, y el borrador que no hay que rehacer vale más.
 */
const MODELO = process.env.ANTHROPIC_MODELO_REPORTES ?? 'claude-opus-5';

/** Un reporte diario, tal como se le cuenta al modelo. */
interface DiaParaIA {
  fecha: string;
  numero: string;
  clima: string;
  horas_perdidas: number;
  motivo: string | null;
  areas: string[];
  que_se_hizo: string;
  atrasos: string | null;
  novedades: string | null;
  personal: { puesto: string; empresa: string | null; cantidad: number }[];
  equipos: { nombre: string; horas: number }[];
  entregas: { descripcion: string; cantidad: number | null; unidad: string | null }[];
}

export interface BorradorIA {
  resumen: string;
  problemas: { fecha: string | null; problema: string }[];
  uso: { entrada: number; salida: number };
}

const INSTRUCCIONES = `Eres el ingeniero residente de una constructora en Panamá y escribes el
reporte SEMANAL de obra a partir de los reportes diarios de esa semana.

QUÉ ESCRIBES
1. resumen: de dos a cuatro párrafos cortos sobre lo que SE LOGRÓ en la semana. Organízalo por
   frente de trabajo —el área, el bloque, el nivel—, no por día: qué quedó terminado, qué quedó a
   medias y con cuánto avance, y qué no se pudo arrancar. Después, lo que atrasó la obra y por
   qué. Si un subcontratista ejecutó algo, nómbralo por el trabajo que hizo.
2. problemas: lo que estorbó el trabajo esa semana, uno por línea, con el día en que pasó. Si algo
   duró varios días, es UN problema y la fecha es la del día en que empezó. Si un día no tuvo
   ningún problema, no inventes ninguno; una semana puede quedarse sin lista.

CÓMO ESCRIBES
- Español de Panamá, de obra: llano, corto y concreto. Nada de «se procedió a» ni «cabe destacar».
- Nombra los elementos como los nombran los diarios: bloque B, nivel 3, eje C, losa, mampostería.
- Frases cortas. Sin adjetivos de relleno ni conclusiones optimistas.
- No abras con «Durante la semana» ni cierres con un resumen del resumen.

LO QUE NO HACES, NUNCA
- No inventes NINGÚN número que no esté en los reportes diarios: ni metros, ni cantidades, ni
  horas, ni cuánta gente hubo. Si un dato no está, no lo pongas.
- No sumes ni promedies nada: de eso se encarga el sistema, y sus tablas van aparte en el mismo
  reporte. Menciona una cantidad solo si un diario la dice tal cual.
- No propongas qué hacer, no repartas culpas y no felicites a nadie.
- No comentes cuánta gente hubo ni cómo estuvo la cuadrilla —«cuadrilla reducida», «poco
  personal»—. El semanal es lo que se HIZO; cuánta gente hubo cada día ya sale en su tabla.
- No escribas la acción a tomar de cada problema: eso lo escribe el ingeniero.
- NO cuentes la semana día por día. Nada de «el lunes se hizo esto, el martes lo otro»: eso ya
  está en los reportes diarios, y quien lee el semanal quiere saber en qué quedó la semana. No
  nombres los días de la semana en el resumen; los días solo aparecen en la lista de problemas.
- No repitas lo que ya dicen los diarios: esto es el resumen de la semana, no su transcripción.`;

const FORMATO = {
  type: 'object',
  properties: {
    resumen: {
      type: 'string',
      description: 'De dos a cuatro párrafos, separados por una línea en blanco.',
    },
    problemas: {
      type: 'array',
      description: 'Lo que estorbó el trabajo. Puede ir vacía.',
      items: {
        type: 'object',
        properties: {
          fecha: {
            type: ['string', 'null'],
            description: 'El día en que pasó, YYYY-MM-DD. null si fue de toda la semana.',
          },
          problema: {
            type: 'string',
            description: 'Qué pasó, en una o dos frases.',
          },
        },
        required: ['fecha', 'problema'],
        additionalProperties: false,
      },
    },
  },
  required: ['resumen', 'problemas'],
  additionalProperties: false,
} as const;

/** Lo que dicen los diarios de esa semana, ordenados por día. */
async function diariosDeLaSemana(proyectoId: number, lunes: string): Promise<DiaParaIA[]> {
  const domingo = domingoDe(lunes);
  const reportes = await query<{
    id: number; numero: string; fecha: Date; clima: string;
    horas_perdidas: string | null; motivo: string | null;
    que_se_hizo: string; atrasos: string | null; novedades: string | null;
  }>(
    `SELECT id, numero, fecha, clima, horas_perdidas, motivo, que_se_hizo, atrasos, novedades
       FROM proyecto_reportes
      WHERE proyecto_id = $1 AND activo = true AND completo = true
        AND fecha BETWEEN $2 AND $3
      ORDER BY fecha, id`,
    [proyectoId, lunes, domingo],
  );
  if (reportes.rows.length === 0) return [];

  const ids = reportes.rows.map((r) => r.id);
  const [areas, personal, equipos, entregas] = await Promise.all([
    query<{ reporte_id: number; nombre: string }>(
      `SELECT ra.reporte_id, a.nombre
         FROM proyecto_reporte_areas ra
         JOIN proyecto_areas a ON a.id = ra.area_id
        WHERE ra.reporte_id = ANY($1)`,
      [ids],
    ),
    query<{ reporte_id: number; puesto: string; empresa: string | null; cantidad: number }>(
      `SELECT p.reporte_id, pu.nombre AS puesto, e.nombre AS empresa, p.cantidad
         FROM proyecto_reporte_personal p
         JOIN proyecto_puestos pu ON pu.id = p.puesto_id
         LEFT JOIN proyecto_empresas e ON e.id = pu.empresa_id
        WHERE p.reporte_id = ANY($1) AND p.cantidad > 0`,
      [ids],
    ),
    query<{ reporte_id: number; nombre: string; horas: string }>(
      `SELECT q.reporte_id, eq.nombre, q.horas
         FROM proyecto_reporte_equipos q
         JOIN proyecto_equipos eq ON eq.id = q.equipo_id
        WHERE q.reporte_id = ANY($1) AND q.horas > 0`,
      [ids],
    ),
    query<{ reporte_id: number; descripcion: string; cantidad: string | null; unidad: string | null }>(
      `SELECT reporte_id, descripcion, cantidad, unidad
         FROM proyecto_reporte_entregas
        WHERE reporte_id = ANY($1)`,
      [ids],
    ),
  ]);

  const porReporte = <T extends { reporte_id: number }>(filas: T[], id: number) =>
    filas.filter((f) => f.reporte_id === id);

  return reportes.rows.map((r) => ({
    fecha: r.fecha.toISOString().slice(0, 10),
    numero: r.numero,
    clima: r.clima,
    horas_perdidas: r.horas_perdidas === null ? 0 : Number(r.horas_perdidas),
    motivo: r.motivo,
    areas: porReporte(areas.rows, r.id).map((a) => a.nombre),
    que_se_hizo: r.que_se_hizo,
    atrasos: r.atrasos,
    novedades: r.novedades,
    personal: porReporte(personal.rows, r.id).map((p) => ({
      puesto: p.puesto, empresa: p.empresa, cantidad: Number(p.cantidad),
    })),
    equipos: porReporte(equipos.rows, r.id).map((e) => ({
      nombre: e.nombre, horas: Number(e.horas),
    })),
    entregas: porReporte(entregas.rows, r.id).map((e) => ({
      descripcion: e.descripcion,
      cantidad: e.cantidad === null ? null : Number(e.cantidad),
      unidad: e.unidad,
    })),
  }));
}

/**
 * Los diarios como texto, que es como mejor los lee un modelo: un bloque por
 * día, con sus etiquetas. JSON crudo se lee peor y gasta más.
 */
export function diariosComoTexto(dias: DiaParaIA[]): string {
  return dias
    .map((d) => {
      const trozos = [
        `## ${d.fecha} (${d.numero})`,
        `Clima: ${d.clima}`,
        d.horas_perdidas > 0
          ? `Horas perdidas: ${d.horas_perdidas}${d.motivo ? ` — ${d.motivo}` : ''}`
          : null,
        d.areas.length ? `Áreas: ${d.areas.join(', ')}` : null,
        `Trabajo ejecutado: ${d.que_se_hizo}`,
        d.atrasos ? `Atrasos o impedimentos: ${d.atrasos}` : null,
        d.novedades ? `Novedades: ${d.novedades}` : null,
        d.personal.length
          ? `Personal: ${d.personal
            .map((p) => `${p.cantidad} ${p.puesto}${p.empresa ? ` (${p.empresa})` : ''}`)
            .join(', ')}`
          : null,
        d.equipos.length
          ? `Equipo: ${d.equipos.map((e) => `${e.nombre} ${e.horas} h`).join(', ')}`
          : null,
        d.entregas.length
          ? `Entregas: ${d.entregas
            .map((e) => `${e.descripcion}${e.cantidad !== null ? ` — ${e.cantidad} ${e.unidad ?? ''}`.trimEnd() : ''}`)
            .join('; ')}`
          : null,
      ];
      return trozos.filter(Boolean).join('\n');
    })
    .join('\n\n');
}

export class SinDiariosError extends Error {}
export class IaNoConfiguradaError extends Error {}

/**
 * Escribe el borrador de esa semana.
 *
 * Lanza SinDiariosError si la semana no tiene ningún reporte diario —no hay de
 * qué escribir— y IaNoConfiguradaError si no hay llave.
 */
export async function redactarSemana(
  proyectoId: number,
  lunes: string,
): Promise<BorradorIA> {
  const cliente = obtenerCliente();
  if (!cliente) throw new IaNoConfiguradaError('No hay conexión con la IA configurada');

  const dias = await diariosDeLaSemana(proyectoId, lunes);
  if (dias.length === 0) throw new SinDiariosError('La semana no tiene reportes diarios');

  const semana = diasDeLaSemana(lunes);
  const encabezado =
    `Semana del ${semana[0]} (lunes) al ${semana[6]} (domingo). ` +
    `Tiene ${dias.length} ${dias.length === 1 ? 'reporte diario' : 'reportes diarios'}.`;

  const respuesta = await cliente.messages.parse({
    model: MODELO,
    max_tokens: 4000,
    // Redactar no es un problema difícil: con esfuerzo bajo escribe igual de
    // bien, responde antes y cuesta menos.
    output_config: { effort: 'low', format: jsonSchemaOutputFormat(FORMATO) },
    system: [
      { type: 'text', text: INSTRUCCIONES, cache_control: { type: 'ephemeral' } },
    ] as Anthropic.TextBlockParam[],
    messages: [
      {
        role: 'user',
        content: `${encabezado}\n\nEstos son los reportes diarios:\n\n${diariosComoTexto(dias)}`,
      },
    ],
  });

  // Un rechazo llega con éxito y sin contenido útil: hay que mirarlo antes de
  // leer nada, o el reporte se queda en blanco sin explicación.
  if (respuesta.stop_reason === 'refusal') {
    throw new Error('La IA no pudo redactar este reporte');
  }

  const salida = respuesta.parsed_output;
  if (!salida) throw new Error('La IA no devolvió el borrador en el formato esperado');

  // Los días que no son de esta semana se dejan sin fecha en vez de tirarse: el
  // problema es bueno aunque el modelo se equivoque de día, y sin fecha sale
  // como «la semana».
  const deLaSemana = new Set(semana);
  return {
    resumen: String(salida.resumen ?? '').trim(),
    problemas: (salida.problemas ?? [])
      .map((p) => ({
        fecha: p.fecha && deLaSemana.has(p.fecha) ? p.fecha : null,
        problema: String(p.problema ?? '').trim(),
      }))
      .filter((p) => p.problema !== ''),
    uso: {
      entrada: respuesta.usage.input_tokens ?? 0,
      salida: respuesta.usage.output_tokens ?? 0,
    },
  };
}
