// src/services/asistentePagos/herramientas.ts
// Las cuatro cosas que el asistente puede hacer. No hay una quinta.
//
// Dos de leer y dos de proponer. Ninguna escribe en la base: las de leer
// filtran el contexto que ya esta en memoria, y las de proponer llenan un
// borrador que muere con la peticion. El unico camino a la base es el boton de
// aplicar, que pulsa una persona.
//
// NO HAY UNA HERRAMIENTA PARA DEJAR UN PAGO SIN PARTIDA, y no se vuelve a
// anadir. La hubo, y el asistente la usaba como salida facil: cuando no tenia
// clara la partida, insistia en ofrecer "lo dejamos sin partida" en vez de
// preguntar. Todo gasto pagado pertenece a alguna partida del contrato; que
// todavia no se sepa a cual es una pregunta, no un destino. Quitarle la partida
// a un pago sigue siendo posible a mano, vaciando el reparto en el cuadro y
// guardando: eso lo decide una persona mirando, no una frase de chat.
//
// TODA la validacion vive aqui, no en las instrucciones que se le dan al
// modelo. Las instrucciones son una recomendacion; esto es una puerta. Un pago
// de otro proyecto, una partida que no existe, unos porcentajes que no suman
// cien o un reparto que no cuadra al centavo no entran, diga lo que diga el
// modelo. Cuando algo no pasa, el error vuelve en espanol y el asistente se
// corrige solo en la misma vuelta.

import type { ContextoProyecto, PagoContexto } from './contexto.js';
import { repartirPorPeso, type ParteConPeso } from './reparto.js';
import { Borrador, type LineaPropuesta, type ReglaPropuesta } from './propuesta.js';


const centavos = (n: number): number => Math.round(n * 100);

/** Sin tildes y en minusculas: buscar "diseno" tiene que encontrar "diseño". */
const normalizar = (s: string): string =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export interface ResultadoHerramienta {
  ok: boolean;
  /** Lo que se le devuelve al modelo: el resultado, o el motivo del rechazo. */
  contenido: unknown;
}

const falla = (motivo: string): ResultadoHerramienta => ({ ok: false, contenido: { error: motivo } });

// ---------------------------------------------------------------------------
// Las definiciones que ve el modelo
// ---------------------------------------------------------------------------

export const HERRAMIENTAS = [
  {
    name: 'buscar_pagos',
    description:
      'Busca pagos ya pagados de este proyecto. Uselo siempre antes de proponer, ' +
      'para saber exactamente cuales son. Devuelve todos los que coinciden.',
    input_schema: {
      type: 'object' as const,
      properties: {
        texto: { type: 'string', description: 'Busca en el proveedor, el numero y el concepto' },
        sin_partida: { type: 'boolean', description: 'Solo los que no tienen partida asignada' },
        con_partida: { type: 'boolean', description: 'Solo los que ya tienen partida' },
        desde: { type: 'string', description: 'Fecha de pago desde, YYYY-MM-DD' },
        hasta: { type: 'string', description: 'Fecha de pago hasta, YYYY-MM-DD' },
        monto_min: { type: 'number' },
        monto_max: { type: 'number' },
        categoria_codigo: { type: 'string', description: 'Codigo de la categoria de gasto' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'buscar_partidas',
    description:
      'Busca partidas del desglose del proyecto por su nombre o su numero de item. ' +
      'Uselo para convertir lo que dice el usuario ("el cajon pluvial") en la partida exacta.',
    input_schema: {
      type: 'object' as const,
      properties: {
        texto: { type: 'string', description: 'Busca en el numero de item y en la descripcion' },
        seccion_uid: { type: 'string', description: 'Solo las de esta seccion' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'proponer_asignacion',
    description:
      'Propone que estos pagos vayan ENTEROS a una sola partida. No aplica nada: ' +
      'la persona lo revisa y decide.',
    input_schema: {
      type: 'object' as const,
      properties: {
        solicitudIds: { type: 'array', items: { type: 'integer' } },
        rowUid: { type: 'string', description: 'La partida que recibe el pago completo' },
        motivo: { type: 'string', description: 'Por que, en una linea y en espanol' },
      },
      required: ['solicitudIds', 'rowUid', 'motivo'],
      additionalProperties: false,
    },
  },
  {
    name: 'proponer_reparto',
    description:
      'Propone repartir cada uno de estos pagos entre varias partidas, segun una regla. ' +
      'Los montos los calcula el servidor: usted nunca dice cifras.',
    input_schema: {
      type: 'object' as const,
      properties: {
        solicitudIds: { type: 'array', items: { type: 'integer' } },
        regla: {
          type: 'string',
          enum: ['proporcional_presupuesto', 'partes_iguales', 'porcentajes'],
          description:
            'proporcional_presupuesto reparte segun lo que tenga presupuestado cada partida; ' +
            'partes_iguales da lo mismo a cada una; porcentajes usa los que usted indique.',
        },
        partidas: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              rowUid: { type: 'string' },
              porcentaje: { type: 'number', description: 'Solo con la regla porcentajes; deben sumar 100' },
            },
            required: ['rowUid'],
            additionalProperties: false,
          },
        },
        motivo: { type: 'string' },
      },
      required: ['solicitudIds', 'regla', 'partidas', 'motivo'],
      additionalProperties: false,
    },
  },
];

// ---------------------------------------------------------------------------
// La ejecucion
// ---------------------------------------------------------------------------

const sinPartidaViva = (p: PagoContexto): boolean =>
  p.partidas.length === 0 || p.partidas.every((x) => x.item == null);

function buscarPagos(ctx: ContextoProyecto, input: Record<string, unknown>): ResultadoHerramienta {
  const texto = typeof input.texto === 'string' ? normalizar(input.texto.trim()) : '';
  let pagos = ctx.pagos;

  if (texto) {
    pagos = pagos.filter((p) =>
      normalizar(p.proveedor ?? '').includes(texto)
      || normalizar(p.numero ?? '').includes(texto)
      || normalizar(p.concepto ?? '').includes(texto));
  }
  if (input.sin_partida === true) pagos = pagos.filter(sinPartidaViva);
  if (input.con_partida === true) pagos = pagos.filter((p) => !sinPartidaViva(p));
  if (typeof input.desde === 'string') pagos = pagos.filter((p) => p.fecha >= (input.desde as string));
  if (typeof input.hasta === 'string') pagos = pagos.filter((p) => p.fecha <= (input.hasta as string));
  if (typeof input.monto_min === 'number') pagos = pagos.filter((p) => p.monto >= (input.monto_min as number));
  if (typeof input.monto_max === 'number') pagos = pagos.filter((p) => p.monto <= (input.monto_max as number));
  if (typeof input.categoria_codigo === 'string') {
    const cod = normalizar(input.categoria_codigo);
    pagos = pagos.filter((p) => normalizar(p.categoria ?? '').startsWith(cod));
  }

  return {
    ok: true,
    contenido: {
      total: pagos.length,
      suma: Math.round(pagos.reduce((s, p) => s + p.monto, 0) * 100) / 100,
      pagos,
    },
  };
}

function buscarPartidas(ctx: ContextoProyecto, input: Record<string, unknown>): ResultadoHerramienta {
  const texto = typeof input.texto === 'string' ? normalizar(input.texto.trim()) : '';
  let partidas = ctx.partidas;

  if (typeof input.seccion_uid === 'string') {
    partidas = partidas.filter((p) => p.seccionUid === input.seccion_uid);
  }
  if (texto) {
    partidas = partidas.filter((p) =>
      normalizar(p.item).includes(texto) || normalizar(p.descripcion).includes(texto));
  }

  return {
    ok: true,
    contenido: {
      total: partidas.length,
      partidas,
    },
  };
}

/** Los pagos que nombra una propuesta, o el motivo del rechazo. */
function resolverPagos(
  ctx: ContextoProyecto,
  input: Record<string, unknown>,
): { pagos: PagoContexto[] } | { error: string } {
  const ids = Array.isArray(input.solicitudIds) ? input.solicitudIds : null;
  if (!ids || ids.length === 0) return { error: 'Hay que decir al menos un pago' };

  const pagos: PagoContexto[] = [];
  for (const id of ids) {
    const pago = ctx.pagos.find((p) => p.id === id);
    if (!pago) {
      return { error: `El pago ${String(id)} no es de este proyecto o no esta pagado. Use buscar_pagos.` };
    }
    if (pagos.some((p) => p.id === pago.id)) continue;
    pagos.push(pago);
  }
  return { pagos };
}

function lineaDe(ctx: ContextoProyecto, rowUid: string, monto: number): LineaPropuesta | null {
  const partida = ctx.partidas.find((p) => p.rowUid === rowUid);
  if (!partida) return null;
  return { rowUid, item: partida.item, descripcion: partida.descripcion, monto };
}

function proponerAsignacion(
  ctx: ContextoProyecto, borrador: Borrador, input: Record<string, unknown>,
): ResultadoHerramienta {
  const resueltos = resolverPagos(ctx, input);
  if ('error' in resueltos) return falla(resueltos.error);

  const rowUid = typeof input.rowUid === 'string' ? input.rowUid : '';
  const motivo = typeof input.motivo === 'string' ? input.motivo : '';
  if (!ctx.partidas.some((p) => p.rowUid === rowUid)) {
    return falla('Esa partida no esta en el desglose del proyecto. Use buscar_partidas.');
  }

  for (const pago of resueltos.pagos) {
    const linea = lineaDe(ctx, rowUid, pago.monto);
    if (!linea) return falla('Esa partida no esta en el desglose del proyecto.');
    if (centavos(pago.monto) <= 0) {
      return falla(`El pago ${pago.numero ?? pago.id} no tiene monto que asignar.`);
    }
    borrador.poner(pago, [linea], 'una_partida', motivo);
  }

  return {
    ok: true,
    contenido: { propuestos: resueltos.pagos.length, en_el_borrador: borrador.tamano },
  };
}

function proponerReparto(
  ctx: ContextoProyecto, borrador: Borrador, input: Record<string, unknown>,
): ResultadoHerramienta {
  const resueltos = resolverPagos(ctx, input);
  if ('error' in resueltos) return falla(resueltos.error);

  const regla = input.regla as ReglaPropuesta;
  if (regla !== 'proporcional_presupuesto' && regla !== 'partes_iguales' && regla !== 'porcentajes') {
    return falla('La regla tiene que ser proporcional_presupuesto, partes_iguales o porcentajes.');
  }

  const crudas = Array.isArray(input.partidas) ? input.partidas : [];
  if (crudas.length === 0) return falla('Hay que decir entre que partidas se reparte.');

  const pesos: ParteConPeso[] = [];
  for (const cruda of crudas as { rowUid?: unknown; porcentaje?: unknown }[]) {
    const rowUid = typeof cruda.rowUid === 'string' ? cruda.rowUid : '';
    const partida = ctx.partidas.find((p) => p.rowUid === rowUid);
    if (!partida) {
      return falla('Alguna de esas partidas no esta en el desglose del proyecto. Use buscar_partidas.');
    }
    if (pesos.some((p) => p.rowUid === rowUid)) {
      return falla('Esa partida esta repetida en el reparto.');
    }

    if (regla === 'porcentajes') {
      const pct = typeof cruda.porcentaje === 'number' ? cruda.porcentaje : NaN;
      if (!Number.isFinite(pct) || pct <= 0) {
        return falla('Con la regla porcentajes, cada partida necesita un porcentaje mayor que cero.');
      }
      pesos.push({ rowUid, peso: pct });
    } else if (regla === 'partes_iguales') {
      pesos.push({ rowUid, peso: 1 });
    } else {
      pesos.push({ rowUid, peso: partida.presupuestado });
    }
  }

  if (regla === 'porcentajes') {
    const suma = pesos.reduce((s, p) => s + centavos(p.peso ?? 0), 0);
    if (suma !== 10000) {
      return falla('Los porcentajes tienen que sumar exactamente 100.');
    }
  }

  // UNA PARTIDA EN CERO NUNCA SE DESCARTA. Que no tenga costo escrito no
  // significa que ahi no pueda ir gasto: significa que todavia no se costeo, y
  // el gasto que reciba la dejara pasada, que es justo lo que hay que ver.
  //
  // Lo unico que el cero no sabe decir es que PROPORCION le toca, porque esa
  // regla se calcula sobre esa misma cifra. Asi que si en el grupo hay aunque
  // sea una en cero, el reparto entero pasa a PARTES IGUALES y se avisa. Nunca
  // se reparte dejando a alguna fuera.
  const sinCosto = pesos.filter((p) => p.peso == null || p.peso <= 0);

  let reglaAplicada: ReglaPropuesta = regla;
  let pesosFinales = pesos;
  let aviso: string | null = null;

  if (regla === 'proporcional_presupuesto' && sinCosto.length > 0) {
    reglaAplicada = 'partes_iguales';
    pesosFinales = pesos.map((p) => ({ rowUid: p.rowUid, peso: 1 }));
    aviso = sinCosto.length === pesos.length
      ? 'Ninguna de esas partidas tiene costo escrito en el presupuesto, asi que no hay proporcion que calcular y se reparte en partes iguales. Digaselo al usuario.'
      : `${sinCosto.length} de esas partidas no tienen costo escrito en el presupuesto. Ninguna se deja fuera, asi que el reparto entero va en partes iguales. Digaselo al usuario.`;
  }

  const motivo = typeof input.motivo === 'string' ? input.motivo : '';
  for (const pago of resueltos.pagos) {
    const partes = repartirPorPeso(pesosFinales, pago.monto);
    if (partes.length === 0) {
      return falla('No se pudo repartir ese pago entre esas partidas.');
    }

    const lineas: LineaPropuesta[] = [];
    for (const parte of partes) {
      const linea = lineaDe(ctx, parte.rowUid, parte.monto);
      if (!linea) return falla('Alguna de esas partidas no esta en el desglose del proyecto.');
      lineas.push(linea);
    }

    // La ultima puerta antes del borrador: el reparto tiene que dar el monto
    // del pago al centavo. Con el metodo del resto mayor siempre da, pero esto
    // es lo que el guardado exige y no se confia en que "siempre" sea cierto.
    const suma = lineas.reduce((s, l) => s + centavos(l.monto), 0);
    if (suma !== centavos(pago.monto)) {
      return falla(`El reparto del pago ${pago.numero ?? pago.id} no cuadra con su monto.`);
    }

    borrador.poner(pago, lineas, reglaAplicada, motivo);
  }

  return {
    ok: true,
    contenido: {
      propuestos: resueltos.pagos.length,
      en_el_borrador: borrador.tamano,
      regla_aplicada: reglaAplicada,
      ...(aviso ? { aviso } : {}),
    },
  };
}

/** Corre una herramienta. Nunca lanza: un rechazo es un resultado, y el modelo
 *  lo lee y se corrige. */
export function ejecutarHerramienta(
  nombre: string,
  input: unknown,
  ctx: ContextoProyecto,
  borrador: Borrador,
): ResultadoHerramienta {
  const args = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;

  switch (nombre) {
    case 'buscar_pagos': return buscarPagos(ctx, args);
    case 'buscar_partidas': return buscarPartidas(ctx, args);
    case 'proponer_asignacion': return proponerAsignacion(ctx, borrador, args);
    case 'proponer_reparto': return proponerReparto(ctx, borrador, args);
    // Si el modelo se inventa la que ya no existe, el rechazo le dice que hacer
    // en su lugar en vez de dejarlo dando vueltas.
    case 'proponer_sin_partida':
      return falla(
        'Dejar un pago sin partida no es una opcion y esa herramienta no existe. '
        + 'Todo gasto pagado pertenece a alguna partida del contrato. Si no sabe a '
        + 'cual, preguntele al usuario y no proponga nada para ese pago.',
      );
    default: return falla(`No existe la herramienta ${nombre}.`);
  }
}
