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
import {
  fusionar,
  faltantes,
  resumen,
  CLIMAS,
  SECCIONES,
  type DatosReporte,
  type ListasProyecto,
} from './datosReporte.js';
import { cerrarConversacion, guardarConversacion, type Conversacion } from './conversacion.js';
import { responderBotones, responderDocumento } from './entrantes.js';
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
    name: 'elegir_proyecto',
    description:
      'Fija el proyecto del reporte y devuelve sus listas (areas, puestos, equipos, ' +
      'categorias de entrega) y sus ultimos reportes. Hay que llamarlo antes de anotar nada.',
    input_schema: {
      type: 'object',
      properties: { proyecto_id: { type: 'integer' } },
      required: ['proyecto_id'],
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
        que_se_hizo: { type: 'string' },
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
  return {
    proyecto_id: ctx.conversacion.proyectoId,
    fecha_de_hoy: hoyEnPanama(),
    anotado: listas ? resumen(datos, listas, ctx.fotos) : null,
    datos,
    fotos: ctx.fotos,
    falta_preguntar: faltantes(datos, ctx.fotos).map((s) => ({
      seccion: s.clave,
      nombre: s.nombre,
      obligatoria: s.obligatoria,
    })),
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

  if (nombre === 'elegir_proyecto') {
    const proyectoId = Number(input.proyecto_id);
    const permitidos = await proyectosDe(ctx.usuario);
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
      ? { ok: true, contenido: { preguntado: 'La pregunta salió con sus dos botones' } }
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
