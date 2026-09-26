// Lo unico que el asistente puede hacer de verdad.
//
// Misma idea que en el asistente de pagos: al modelo se le pide CRITERIO —de
// que proyecto habla, que puesto es «los ayudantes», que fecha es «ayer»— y
// nada mas. Lo que llega a la base pasa por aqui, y aqui se valida contra las
// listas del proyecto y contra los permisos de la persona. Por eso las
// instrucciones del modelo pueden ser cortas: no sostienen la seguridad.

import type Anthropic from '@anthropic-ai/sdk';
import { query } from '../../database/config.js';
import { loadUserPermissions } from '../../middleware/auth.js';
import { HORA_PANAMA } from '../reportePdf.js';
import { agregarALista } from '../../routes/proyectoListas.js';
import { agregarArea } from '../../routes/proyectoAreas.js';
import {
  parecidoEnLista,
  preguntaDeLista,
  fusionar,
  faltantes,
  preguntaDeAreas,
  resumen,
  trabajoFlaco,
  CLIMAS,
  SECCIONES,
  type DatosReporte,
  type ListasProyecto,
} from './datosReporte.js';
import { mensajeSemanaCerrada, semanaCerrada } from '../semanaCerrada.js';
import {
  cerrarConversacion,
  conversacionViva,
  guardarConversacion,
  type Conversacion,
} from './conversacion.js';
import { responder, responderBotones, responderDocumento } from './entrantes.js';
import { armarBorrador, enviarReporte, nombreArchivo, pdfDelBorrador, pdfFinal } from './borrador.js';

export interface Usuario {
  id: number;
  nombre: string;
  rol: 'admin' | 'co-admin' | 'usuario';
}

/** Todo lo que una herramienta necesita saber de quien escribe. */
export interface Contexto {
  usuario: Usuario;
  conversacion: Conversacion;
  /** Cuantas fotos lleva mandadas en esta conversacion. */
  fotos: number;
}

export interface Resultado {
  ok: boolean;
  contenido: unknown;
  /** La herramienta ya le hizo la pregunta a la persona: el turno se acaba ahi. */
  cierraTurno?: boolean;
}

/** El dia de hoy en Panama, que es donde estan las obras. */
export function hoyEnPanama(): string {
  // en-CA da AAAA-MM-DD, que es como se guardan las fechas.
  return new Date().toLocaleDateString('en-CA', { ...HORA_PANAMA });
}

/**
 * Los proyectos en los que esta persona puede reportar.
 *
 * Las mismas reglas que la pantalla: admin y co-admin ven todos; un usuario
 * necesita el permiso de reportes, y ve los suyos —o todos, si tiene acceso
 * global.
 */
export async function proyectosDe(usuario: Usuario): Promise<{ id: number; nombre: string }[]> {
  if (usuario.rol === 'usuario') {
    const permisos = await loadUserPermissions(usuario.id);
    if (!permisos?.reportes) return [];
    if (!permisos.acceso_global) {
      const r = await query<{ id: number; nombre: string }>(
        `SELECT p.id, p.nombre
           FROM proyectos p
           JOIN user_project_access a ON a.proyecto_id = p.id AND a.user_id = $1
          WHERE p.activo = true
          ORDER BY p.nombre`,
        [usuario.id],
      );
      return r.rows;
    }
  }
  const r = await query<{ id: number; nombre: string }>(
    'SELECT id, nombre FROM proyectos WHERE activo = true ORDER BY nombre',
  );
  return r.rows;
}

/** Las listas con las que se llena el reporte de ese proyecto. */
export async function listasDe(proyectoId: number): Promise<ListasProyecto> {
  const [areas, puestos, equipos, categorias] = await Promise.all([
    query<{ id: number; nombre: string }>(
      'SELECT id, nombre FROM proyecto_areas WHERE proyecto_id = $1 AND activo = true ORDER BY orden, id',
      [proyectoId],
    ),
    query<{ id: number; nombre: string; empresa: string | null }>(
      `SELECT p.id, p.nombre, e.nombre AS empresa
         FROM proyecto_puestos p
         LEFT JOIN proyecto_empresas e ON e.id = p.empresa_id
        WHERE p.proyecto_id = $1 AND p.activo = true
        ORDER BY p.orden, p.id`,
      [proyectoId],
    ),
    query<{ id: number; nombre: string }>(
      'SELECT id, nombre FROM proyecto_equipos WHERE proyecto_id = $1 AND activo = true ORDER BY orden, id',
      [proyectoId],
    ),
    query<{ id: number; nombre: string }>(
      'SELECT id, nombre FROM proyecto_entrega_categorias WHERE proyecto_id = $1 AND activo = true ORDER BY orden, id',
      [proyectoId],
    ),
  ]);
  return {
    areas: areas.rows,
    puestos: puestos.rows,
    equipos: equipos.rows,
    categorias: categorias.rows,
  };
}

/**
 * Los ultimos reportes de ese proyecto, para que el asistente entienda como
 * habla esa obra.
 *
 * Son REFERENCIA y nada mas: sirven para saber que «la retro» es la
 * retroexcavadora, no para copiar el trabajo de ayer en el de hoy. Eso se le
 * dice al modelo en las instrucciones, y ademas lo de ayer no entra en `datos`
 * si el ingeniero no lo cuenta.
 */
export async function reportesAnteriores(
  proyectoId: number,
  cuantos = 3,
): Promise<{ fecha: string; clima: string; que_se_hizo: string }[]> {
  const r = await query<{ fecha: string; clima: string; que_se_hizo: string }>(
    `SELECT to_char(fecha, 'YYYY-MM-DD') AS fecha, clima, que_se_hizo
       FROM proyecto_reportes
      WHERE proyecto_id = $1 AND activo = true AND completo = true
      ORDER BY fecha DESC, id DESC
      LIMIT $2`,
    [proyectoId, cuantos],
  );
  return r.rows;
}

export const HERRAMIENTAS: Anthropic.Tool[] = [
  {
    name: 'ver_proyectos',
    description:
      'Los proyectos en los que esta persona puede reportar. Uselo cuando no sepa de que ' +
      'obra habla o cuando la conversacion aun no tiene proyecto.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'preguntar_obras',
    description:
      'Le manda la lista de las obras donde puede reportar, numerada. La escribe el ' +
      'sistema, no usted. Uselo cuando tenga varias y haya que preguntarle cual. Despues ' +
      'de llamarlo no escriba nada mas en ese turno: la pregunta ya salio. Cuando conteste ' +
      'con un numero, ese numero va en elegir_proyecto como numero_de_la_lista.',
    input_schema: {
      type: 'object',
      properties: {
        pregunta: {
          type: 'string',
          description: 'La frase que va antes de la lista, sin nombrar obras',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'elegir_proyecto',
    description:
      'Fija el proyecto del reporte y devuelve sus listas (areas, puestos, equipos, ' +
      'categorias de entrega) y sus ultimos reportes. Hay que llamarlo antes de anotar nada. ' +
      'Si la persona contesto con un numero de la lista que mando preguntar_obras, manda ese ' +
      'numero en numero_de_la_lista y NO adivines el proyecto_id: no son lo mismo.',
    input_schema: {
      type: 'object',
      properties: {
        proyecto_id: { type: 'integer' },
        numero_de_la_lista: { type: 'integer' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'anotar',
    description:
      'Anota en el reporte lo que la persona acaba de contar. Solo lo que dijo: lo que no ' +
      'mande, se queda como estaba. Devuelve lo que ya lleva anotado y lo que falta por ' +
      'preguntar. Use tambien "preguntadas" para marcar las secciones por las que ya ' +
      'pregunto y la persona contesto que no hubo nada.',
    input_schema: {
      type: 'object',
      properties: {
        fecha: { type: 'string', description: 'AAAA-MM-DD' },
        clima: { type: 'string', enum: [...CLIMAS] },
        horas_perdidas: { type: 'number' },
        motivo: { type: 'string' },
        areas: { type: 'array', items: { type: 'integer' } },
        trabajos: {
          type: 'array',
          description:
            'El trabajo ejecutado, en puntos y cada uno con su area. Con las palabras de la ' +
            'persona: si lo conto en lista, un punto por renglon, tal cual. Solo se corrigen ' +
            'faltas de ortografia evidentes. Manda la lista ENTERA cada vez: reemplaza a la ' +
            'anterior.',
          items: {
            type: 'object',
            properties: {
              area_id: {
                type: 'integer',
                description:
                  'El area donde paso eso. Dejalo fuera si no es de ningun area: sale como ' +
                  '«General».',
              },
              texto: { type: 'string' },
            },
            required: ['texto'],
            additionalProperties: false,
          },
        },
        atrasos: { type: 'string' },
        novedades: { type: 'string' },
        personal: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              puesto_id: { type: 'integer' },
              cantidad: { type: 'integer' },
            },
            required: ['puesto_id', 'cantidad'],
            additionalProperties: false,
          },
        },
        equipos: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              equipo_id: { type: 'integer' },
              unidades: { type: 'integer' },
              horas: { type: 'number' },
            },
            required: ['equipo_id', 'horas'],
            additionalProperties: false,
          },
        },
        entregas: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              categoria_id: { type: 'integer' },
              descripcion: { type: 'string' },
              cantidad: { type: 'number' },
              unidad: { type: 'string' },
              notas: { type: 'string' },
            },
            required: ['categoria_id', 'descripcion'],
            additionalProperties: false,
          },
        },
        preguntadas: {
          type: 'array',
          items: { type: 'string', enum: SECCIONES.map((s) => String(s.clave)) },
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'empezar_de_nuevo',
    description:
      'Tira lo anotado y empieza un reporte desde cero. Uselo SOLO cuando la persona ya ' +
      'le dijo que si despues de avisarle de que se pierde lo que lleva anotado. Despues ' +
      'de esto no queda nada: ni obra elegida, ni fotos, ni borrador.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'agregar_equipo',
    description:
      'Agrega una maquina a la lista de equipos del proyecto cuando la persona nombra una ' +
      'que no esta. Devuelve su equipo_id para anotarla despues con anotar. Va con el nombre ' +
      'completo («Retroexcavadora», no «la retro»). Si se parece a una que ya esta, no la ' +
      'agrega y te dice cual: preguntale a la persona si es esa. Si la persona ya te dijo que ' +
      'es otra maquina, vuelve a llamarlo con es_otra.',
    input_schema: {
      type: 'object',
      properties: {
        nombre: { type: 'string' },
        es_otra: {
          type: 'boolean',
          description:
            'Solo cuando la persona ya dijo que no es la maquina parecida que esta en la lista',
        },
      },
      required: ['nombre'],
      additionalProperties: false,
    },
  },
  {
    name: 'agregar_area',
    description:
      'Agrega un area a la lista del proyecto cuando la persona nombra una zona que no ' +
      'esta. Antes hay que decirle que no la tenemos y preguntarle si la agregamos con ese ' +
      'nombre; solo cuando conteste que si se llama con confirmado. Devuelve su id para ' +
      'anotarla con anotar. Si se parece a una que ya esta, no la agrega y te dice cual: ' +
      'preguntale si es esa. Si ya te dijo que es otra zona, llamalo otra vez con es_otra.',
    input_schema: {
      type: 'object',
      properties: {
        nombre: { type: 'string' },
        confirmado: {
          type: 'boolean',
          description: 'La persona ya dijo que si a agregar esa area con ese nombre',
        },
        es_otra: {
          type: 'boolean',
          description: 'Solo cuando la persona ya dijo que no es el area parecida de la lista',
        },
      },
      required: ['nombre', 'confirmado'],
      additionalProperties: false,
    },
  },
  {
    name: 'preguntar_areas',
    description:
      'Le pregunta a la persona en que areas se trabajo. El mensaje sale con TODAS las areas ' +
      'del proyecto, numeradas: la lista la pone el sistema, no usted. Uselo siempre que ' +
      'tenga que preguntar por las areas, tambien cuando lo que contesto no calza con ' +
      'ninguna. Despues de llamarlo no escriba nada mas en ese turno: la pregunta ya salio.',
    input_schema: {
      type: 'object',
      properties: {
        pregunta: {
          type: 'string',
          description:
            'La frase que va antes de la lista, sin nombrar ninguna area. Por ejemplo ' +
            '«¿En qué áreas se trabajó hoy?», o «No encontré "pedestales". ¿Cuál de estas es?»',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'mandar_borrador',
    description:
      'Arma el borrador con lo anotado y le manda a la persona el PDF por WhatsApp para que ' +
      'lo revise. Solo cuando la persona lo pida. No envia el reporte.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'preguntar_si_enviar',
    description:
      'Le manda la pregunta «¿Deseas enviarlo?» con dos botones, Enviar y Cambiar algo. ' +
      'Uselo cuando la persona ya revisó el borrador y dijo que está bien. Despues de ' +
      'llamarlo no escriba nada mas en ese turno: la pregunta ya salió.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'enviar_reporte',
    description:
      'Envia el reporte de verdad: le pone numero, sale el correo y la persona recibe su ' +
      'copia en PDF. Solo despues de que la persona lo haya autorizado mirando el borrador.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'ver_estado',
    description:
      'Lo que lleva anotado el reporte, cuantas fotos hay y que secciones faltan por ' +
      'preguntar. Uselo si duda de si ya pregunto algo.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

/** El estado que se le devuelve al modelo despues de cada herramienta. */
async function estado(ctx: Contexto, listas: ListasProyecto | null): Promise<unknown> {
  const datos = ctx.conversacion.datos;

  // Una semana que ya tiene su reporte semanal enviado no admite diarios. El
  // modelo tiene que saberlo AQUI y no cuando intente armar el borrador: la
  // primera vez que paso de verdad (2026-09-18) se puso a ofrecer otras fechas
  // —de la misma semana— que tampoco se podian, y se contradijo a si mismo.
  let cerrada: string | null = null;
  if (ctx.conversacion.proyectoId !== null) {
    const semana = await semanaCerrada(
      ctx.conversacion.proyectoId,
      datos.fecha ?? hoyEnPanama(),
    );
    if (semana) {
      cerrada =
        mensajeSemanaCerrada(semana, 'ese día ya no admite reporte diario') +
        ' Las demás fechas de esa misma semana tampoco: no ofrezcas otra fecha, dile que ' +
        'esa semana ya se cerró y que lo hable con la oficina.';
    }
  }

  return {
    proyecto_id: ctx.conversacion.proyectoId,
    fecha_de_hoy: hoyEnPanama(),
    ...(cerrada ? { no_se_puede_reportar_esa_fecha: cerrada } : {}),
    ...(trabajoFlaco(datos)
      ? {
          revisar_trabajo:
            'Lo que tienes anotado del trabajo ejecutado es muy corto para un reporte. ' +
            'Léeselo tal cual y pregúntale si así lo quiere o si quiere agregar algo. ' +
            'No lo escribas tú por ella. Si dice que así está bien, déjalo como está.',
        }
      : {}),
    anotado: listas ? resumen(datos, listas, ctx.fotos) : null,
    datos,
    fotos: ctx.fotos,
    // Agrupadas: lo de un mismo grupo se pregunta en un solo mensaje, y la
    // respuesta se reparte entre sus secciones.
    falta_preguntar: faltantes(datos, ctx.fotos, listas).map((s) => ({
      seccion: s.clave,
      nombre: s.nombre,
      obligatoria: s.obligatoria,
      grupo: s.grupo,
    })),
    grupo_que_toca: faltantes(datos, ctx.fotos, listas)[0]?.grupo ?? null,
  };
}

/**
 * Corre una herramienta.
 *
 * Devuelve siempre algo que el modelo pueda leer, tambien cuando dice que no:
 * un «ese equipo no es de este proyecto» es informacion util para el, no un
 * error del sistema.
 */
export async function ejecutarHerramienta(
  nombre: string,
  entrada: unknown,
  ctx: Contexto,
  cache: { listas: ListasProyecto | null },
): Promise<Resultado> {
  const input = (typeof entrada === 'object' && entrada !== null ? entrada : {}) as Record<
    string,
    unknown
  >;

  if (nombre === 'ver_proyectos') {
    const proyectos = await proyectosDe(ctx.usuario);
    return {
      ok: true,
      contenido: {
        proyectos,
        aviso:
          proyectos.length === 0
            ? 'Esta persona no tiene ningun proyecto donde reportar'
            : undefined,
      },
    };
  }

  if (nombre === 'preguntar_obras') {
    const proyectos = await proyectosDe(ctx.usuario);
    if (proyectos.length === 0) {
      return { ok: false, contenido: { error: 'Esta persona no tiene ninguna obra donde reportar' } };
    }
    const pregunta = typeof input.pregunta === 'string' ? input.pregunta : null;
    const salio = await responder(
      ctx.conversacion.telefono,
      preguntaDeLista(proyectos, pregunta, '¿De qué obra es el reporte?'),
      ctx.conversacion.id,
    );
    return salio
      ? {
          ok: true,
          cierraTurno: true,
          contenido: {
            preguntado: 'La lista de obras salió numerada',
            recuerde:
              'Cuando conteste con un número, mándalo en elegir_proyecto como ' +
              'numero_de_la_lista. Ese número es la posición en esta lista, no el id.',
          },
        }
      : { ok: false, contenido: { error: 'No se pudo mandar la lista' } };
  }

  if (nombre === 'elegir_proyecto') {
    const permitidos = await proyectosDe(ctx.usuario);
    // El numero es la POSICION en la lista que mando el sistema. Probandolo
    // (Ivan, 2026-09-26) contesto «5» y el modelo eligio la obra con id 5, que
    // era otra: el numero lo resuelve el codigo, no el modelo.
    const porNumero = input.numero_de_la_lista !== undefined
      ? permitidos[Number(input.numero_de_la_lista) - 1]
      : undefined;
    const proyectoId = porNumero ? porNumero.id : Number(input.proyecto_id);
    const elegido = permitidos.find((p) => p.id === proyectoId);
    if (!elegido) {
      return {
        ok: false,
        contenido: {
          error: 'Esa persona no puede reportar en ese proyecto',
          proyectos: permitidos,
        },
      };
    }
    const listas = await listasDe(proyectoId);
    cache.listas = listas;
    ctx.conversacion.proyectoId = proyectoId;
    ctx.conversacion.modo = 'reporte_diario';
    await guardarConversacion(ctx.conversacion.id, {
      proyectoId,
      modo: 'reporte_diario',
    });
    return {
      ok: true,
      contenido: {
        proyecto: elegido,
        listas,
        reportes_anteriores: await reportesAnteriores(proyectoId),
        ...(await estado(ctx, listas) as object),
      },
    };
  }

  if (nombre === 'anotar') {
    const proyectoId = ctx.conversacion.proyectoId;
    if (proyectoId === null) {
      return {
        ok: false,
        contenido: { error: 'Primero hay que elegir el proyecto con elegir_proyecto' },
      };
    }
    const listas = cache.listas ?? (cache.listas = await listasDe(proyectoId));
    const fusion = fusionar(ctx.conversacion.datos, input, listas);
    if (!fusion.ok) {
      return { ok: false, contenido: { error: fusion.motivo, listas } };
    }
    ctx.conversacion.datos = fusion.datos;
    await guardarConversacion(ctx.conversacion.id, { datos: fusion.datos });
    return { ok: true, contenido: await estado(ctx, listas) };
  }

  if (nombre === 'empezar_de_nuevo') {
    // Decision de Ivan (2026-09-25): si pide empezar otro reporte, se empieza.
    // El asistente avisa de lo que se pierde y pregunta; decidir es de ella.
    if (ctx.conversacion.reporteId !== null) {
      await query(
        `UPDATE proyecto_reportes SET activo = false
          WHERE id = $1 AND completo = false AND activo = true`,
        [ctx.conversacion.reporteId],
      );
    }
    // Se cierra la conversacion entera y se abre otra: asi no arrastra ni las
    // fotos ya mandadas ni lo que se dijeron, que es lo que significa «de cero».
    await cerrarConversacion(ctx.conversacion.id);
    const nueva = await conversacionViva(ctx.conversacion.telefono, ctx.usuario.id);
    Object.assign(ctx.conversacion, nueva);
    ctx.fotos = 0;
    cache.listas = null;
    return {
      ok: true,
      contenido: {
        limpio: 'No queda nada anotado. Empieza otra vez: preguntale de que obra es.',
        ...((await estado(ctx, null)) as object),
      },
    };
  }

  if (nombre === 'agregar_equipo') {
    const proyectoId = ctx.conversacion.proyectoId;
    if (proyectoId === null) {
      return {
        ok: false,
        contenido: { error: 'Primero hay que elegir el proyecto con elegir_proyecto' },
      };
    }
    // Las mismas reglas que el boton de agregar del formulario: puede quien
    // reporta en ese proyecto. Se mira otra vez porque la lista es de todos, y
    // el permiso pudo cambiar desde que empezo la conversacion.
    if (!(await proyectosDe(ctx.usuario)).some((p) => p.id === proyectoId)) {
      return { ok: false, contenido: { error: 'Esa persona ya no puede reportar en este proyecto' } };
    }
    const maquina = typeof input.nombre === 'string' ? input.nombre.trim() : '';
    if (!maquina || maquina.length > 160) {
      return { ok: false, contenido: { error: 'El nombre de la maquina va de 1 a 160 letras' } };
    }

    const listas = cache.listas ?? (cache.listas = await listasDe(proyectoId));
    const parecido = parecidoEnLista(maquina, listas.equipos);
    if (parecido?.igual) {
      return {
        ok: false,
        contenido: {
          error: `Esa máquina ya está en la lista como «${parecido.equipo.nombre}»: anótala con esa`,
          equipo: parecido.equipo,
        },
      };
    }
    if (parecido && input.es_otra !== true) {
      return {
        ok: false,
        contenido: {
          error:
            `Se parece a «${parecido.equipo.nombre}», que ya está en la lista. Pregúntale a la ` +
            'persona si es esa; si dice que es otra máquina, vuelve a llamarlo con es_otra.',
          equipo: parecido.equipo,
        },
      };
    }

    const agregado = await agregarALista(proyectoId, 'equipos', maquina, null, ctx.usuario.id);
    if (!agregado.ok) return { ok: false, contenido: { error: agregado.message } };
    // La lista cambio: lo que se anote en este mismo turno se valida contra la nueva.
    cache.listas = await listasDe(proyectoId);
    return {
      ok: true,
      contenido: {
        agregado: { equipo_id: agregado.fila.id, nombre: agregado.fila.nombre },
        recuerde:
          'Anótala con anotar, con sus horas, y dile a la persona en una línea que la ' +
          'agregaste a los equipos de la obra.',
      },
    };
  }

  if (nombre === 'agregar_area') {
    const proyectoId = ctx.conversacion.proyectoId;
    if (proyectoId === null) {
      return {
        ok: false,
        contenido: { error: 'Primero hay que elegir el proyecto con elegir_proyecto' },
      };
    }
    if (!(await proyectosDe(ctx.usuario)).some((p) => p.id === proyectoId)) {
      return { ok: false, contenido: { error: 'Esa persona ya no puede reportar en este proyecto' } };
    }
    const zona = typeof input.nombre === 'string' ? input.nombre.trim() : '';
    if (!zona) return { ok: false, contenido: { error: 'El area necesita un nombre' } };
    // Un area se queda en la obra para siempre, asi que no se agrega a espaldas
    // de la persona: primero se le dice y se le pregunta (decision de Ivan,
    // 2026-09-25). Lo comprueba el codigo, no las instrucciones del modelo.
    if (input.confirmado !== true) {
      return {
        ok: false,
        contenido: {
          error:
            `«${zona}» no está en las áreas de la obra. Díselo y pregúntale si la agregas ` +
            'con ese nombre. Cuando diga que sí, vuelve a llamarlo con confirmado.',
        },
      };
    }

    const listas = cache.listas ?? (cache.listas = await listasDe(proyectoId));
    const parecido = parecidoEnLista(zona, listas.areas);
    if (parecido?.igual) {
      return {
        ok: false,
        contenido: {
          error: `Esa área ya está en la lista como «${parecido.equipo.nombre}»: usa esa`,
          area: parecido.equipo,
        },
      };
    }
    if (parecido && input.es_otra !== true) {
      return {
        ok: false,
        contenido: {
          error:
            `Se parece a «${parecido.equipo.nombre}», que ya está en la lista. Pregúntale si ` +
            'es esa; si dice que es otra zona, vuelve a llamarlo con es_otra.',
          area: parecido.equipo,
        },
      };
    }

    const agregada = await agregarArea(proyectoId, zona, ctx.usuario.id);
    if (!agregada.ok) return { ok: false, contenido: { error: agregada.message } };
    cache.listas = await listasDe(proyectoId);
    return {
      ok: true,
      contenido: {
        agregada: { area_id: agregada.fila.id, nombre: agregada.fila.nombre },
        recuerde:
          'Anótala con anotar y dile a la persona en una línea que la agregaste a las ' +
          'áreas de la obra.',
      },
    };
  }

  if (nombre === 'preguntar_areas') {
    const proyectoId = ctx.conversacion.proyectoId;
    if (proyectoId === null) {
      return {
        ok: false,
        contenido: { error: 'Primero hay que elegir el proyecto con elegir_proyecto' },
      };
    }
    const listas = cache.listas ?? (cache.listas = await listasDe(proyectoId));
    if (listas.areas.length === 0) {
      return {
        ok: false,
        contenido: { error: 'Este proyecto no tiene areas: no preguntes por ellas' },
      };
    }
    const pregunta = typeof input.pregunta === 'string' ? input.pregunta : null;
    const salio = await responder(
      ctx.conversacion.telefono,
      preguntaDeAreas(listas.areas, pregunta),
      ctx.conversacion.id,
    );
    return salio
      ? {
          ok: true,
          cierraTurno: true,
          contenido: { preguntado: 'La pregunta salió con todas las áreas numeradas' },
        }
      : { ok: false, contenido: { error: 'No se pudo mandar la pregunta' } };
  }

  if (nombre === 'mandar_borrador') {
    const armado = await armarBorrador(ctx.conversacion);
    if (!armado.ok) return { ok: false, contenido: { error: armado.motivo } };

    const pdf = await pdfDelBorrador(armado.reporteId);
    if (!pdf) return { ok: false, contenido: { error: 'No se pudo armar el PDF del borrador' } };

    const salio = await responderDocumento(
      ctx.conversacion.telefono,
      { nombre: nombreArchivo(null, ctx.conversacion.datos.fecha), datos: pdf },
      'Borrador del reporte. Revísalo y dime si hay que cambiar algo.',
      ctx.conversacion.id,
    );
    if (!salio) {
      return { ok: false, contenido: { error: 'WhatsApp no aceptó el archivo; inténtalo otra vez' } };
    }

    ctx.conversacion.reporteId = armado.reporteId;
    ctx.conversacion.borradorEnviadoAt = new Date();
    await guardarConversacion(ctx.conversacion.id, {
      reporteId: armado.reporteId,
      borradorEnviado: true,
    });
    return {
      ok: true,
      contenido: {
        enviado: 'El PDF del borrador ya salió por WhatsApp',
        recuerde: 'No lo describas otra vez: la persona lo tiene delante.',
      },
    };
  }

  if (nombre === 'preguntar_si_enviar') {
    if (ctx.conversacion.borradorEnviadoAt === null) {
      return {
        ok: false,
        contenido: { error: 'Primero hay que mandarle el borrador para que lo revise' },
      };
    }
    const salio = await responderBotones(
      ctx.conversacion.telefono,
      '¿Deseas enviarlo?',
      [
        { id: 'enviar_reporte', titulo: 'Enviar' },
        { id: 'cambiar_algo', titulo: 'Cambiar algo' },
      ],
      ctx.conversacion.id,
    );
    return salio
      ? { ok: true, cierraTurno: true, contenido: { preguntado: 'La pregunta salió con sus dos botones' } }
      : { ok: false, contenido: { error: 'No se pudo mandar la pregunta' } };
  }

  if (nombre === 'enviar_reporte') {
    // La regla que sostiene todo esto: nada sale sin que la persona haya visto
    // el borrador Y haya dicho algo despues. Lo comprueba el codigo, no las
    // instrucciones del modelo.
    if (ctx.conversacion.borradorEnviadoAt === null) {
      return {
        ok: false,
        contenido: { error: 'No se puede enviar sin que la persona haya visto el borrador' },
      };
    }
    const dijoAlgo = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM whatsapp_mensajes
        WHERE conversacion_id = $1 AND direccion = 'entrante' AND created_at > $2`,
      [ctx.conversacion.id, ctx.conversacion.borradorEnviadoAt],
    );
    if (Number(dijoAlgo.rows[0]?.n ?? 0) === 0) {
      return {
        ok: false,
        contenido: {
          error: 'La persona todavía no ha contestado al borrador. Pregúntale con preguntar_si_enviar.',
        },
      };
    }

    const enviado = await enviarReporte(ctx.conversacion);
    if (!enviado.ok) return { ok: false, contenido: { error: enviado.motivo } };

    const pdf = await pdfFinal(ctx.conversacion.reporteId!);
    if (pdf) {
      await responderDocumento(
        ctx.conversacion.telefono,
        { nombre: nombreArchivo(enviado.numero, ctx.conversacion.datos.fecha), datos: pdf },
        `Reporte ${enviado.numero} enviado`,
        ctx.conversacion.id,
      );
    }
    // El reporte salio: esta conversacion se acabo, y el proximo «ayudame con
    // el reporte» empieza limpio.
    await cerrarConversacion(ctx.conversacion.id);
    return {
      ok: true,
      contenido: {
        numero: enviado.numero,
        correo: 'en camino',
        copia: pdf ? 'la persona ya recibio su copia en PDF' : 'no se pudo mandar la copia',
      },
    };
  }

  if (nombre === 'ver_estado') {
    const proyectoId = ctx.conversacion.proyectoId;
    const listas = proyectoId === null
      ? null
      : (cache.listas ?? (cache.listas = await listasDe(proyectoId)));
    return { ok: true, contenido: await estado(ctx, listas) };
  }

  return { ok: false, contenido: { error: `No existe la herramienta ${nombre}` } };
}

export type { DatosReporte, ListasProyecto };
