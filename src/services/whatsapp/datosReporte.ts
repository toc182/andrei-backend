// Lo que el asistente lleva anotado del reporte, y que le falta por preguntar.
//
// Cuentas puras: ni base de datos ni modelo. Aqui vive la unica lista de
// secciones del reporte diario que el asistente conoce, asi que cuando al
// reporte se le agregue un campo, se agrega una linea a SECCIONES y el
// asistente empieza a preguntar por el.

/** Una seccion del reporte, tal y como se le pregunta a la gente. */
export interface Seccion {
  clave: keyof DatosReporte | 'fotos';
  /** Como se llama en la pantalla, para que el asistente hable igual que ella. */
  nombre: string;
  /** Sin esto el reporte no se puede guardar. */
  obligatoria: boolean;
}

export const SECCIONES: Seccion[] = [
  { clave: 'fecha', nombre: 'Fecha del reporte', obligatoria: true },
  { clave: 'clima', nombre: 'Clima', obligatoria: true },
  { clave: 'horasPerdidas', nombre: 'Horas perdidas y su motivo', obligatoria: false },
  { clave: 'areas', nombre: 'Áreas de trabajo', obligatoria: false },
  { clave: 'queSeHizo', nombre: 'Trabajo ejecutado', obligatoria: true },
  { clave: 'atrasos', nombre: 'Atrasos o impedimentos', obligatoria: false },
  { clave: 'novedades', nombre: 'Novedades del día', obligatoria: false },
  { clave: 'personal', nombre: 'Personal por puesto', obligatoria: false },
  { clave: 'equipos', nombre: 'Equipo y sus horas', obligatoria: false },
  { clave: 'entregas', nombre: 'Lo que llegó a la obra', obligatoria: false },
  { clave: 'fotos', nombre: 'Fotos del día', obligatoria: false },
];

export const CLIMAS = ['Soleado', 'Nublado', 'Lluvia parcial', 'Lluvia todo el día'] as const;
export type Clima = (typeof CLIMAS)[number];

export interface FilaPersonal {
  puestoId: number;
  cantidad: number;
}

export interface FilaEquipo {
  equipoId: number;
  unidades: number;
  horas: number;
}

export interface FilaEntrega {
  categoriaId: number;
  descripcion: string;
  cantidad: number | null;
  unidad: string | null;
  notas: string | null;
}

/** Todo lo que el asistente puede llegar a saber del dia. */
export interface DatosReporte {
  fecha?: string;
  clima?: Clima;
  horasPerdidas?: number;
  motivo?: string;
  areas?: number[];
  queSeHizo?: string;
  atrasos?: string;
  novedades?: string;
  personal?: FilaPersonal[];
  equipos?: FilaEquipo[];
  entregas?: FilaEntrega[];
  /**
   * Las secciones por las que ya se pregunto, aunque la respuesta fuera «nada».
   *
   * Sin esto el asistente volveria a preguntar por las novedades cada vez que
   * el ingeniero conteste otra cosa, porque «sin novedades» y «no le he
   * preguntado» se ven igual en los datos.
   */
  preguntadas?: string[];
}

/** Las listas del proyecto contra las que se valida lo que dice la gente. */
export interface ListasProyecto {
  areas: { id: number; nombre: string }[];
  puestos: { id: number; nombre: string; empresa: string | null }[];
  equipos: { id: number; nombre: string }[];
  categorias: { id: number; nombre: string }[];
}

const texto = (x: unknown): string | null => {
  if (typeof x !== 'string') return null;
  const limpio = x.trim();
  return limpio === '' ? null : limpio;
};

const entero = (x: unknown): number | null => {
  const n = typeof x === 'number' ? x : typeof x === 'string' ? Number(x) : NaN;
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

const numero = (x: unknown): number | null => {
  const n = typeof x === 'number' ? x : typeof x === 'string' ? Number(x) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** Lo que se le devuelve al asistente cuando lo que dijo no se puede anotar. */
export interface Rechazo {
  ok: false;
  motivo: string;
}

export type Fusion = { ok: true; datos: DatosReporte } | Rechazo;

const FECHA = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Mete en los datos lo que el asistente acaba de entender.
 *
 * Valida contra las listas del proyecto: un area, un puesto o un equipo que no
 * sean de ese proyecto se rechazan con su motivo, para que el asistente lo lea
 * y pregunte en vez de inventarse una fila.
 *
 * Lo que no viene en el parche no se toca. Para borrar algo hay que mandarlo
 * explicitamente en blanco o, en las listas, como lista vacia.
 */
export function fusionar(
  datos: DatosReporte,
  parche: Record<string, unknown>,
  listas: ListasProyecto,
): Fusion {
  const nuevo: DatosReporte = { ...datos };

  if ('fecha' in parche) {
    const f = texto(parche.fecha);
    if (!f || !FECHA.test(f)) return { ok: false, motivo: 'La fecha va como 2026-09-17' };
    nuevo.fecha = f;
  }

  if ('clima' in parche) {
    const c = texto(parche.clima);
    if (!c || !(CLIMAS as readonly string[]).includes(c)) {
      return { ok: false, motivo: `El clima solo puede ser: ${CLIMAS.join(', ')}` };
    }
    nuevo.clima = c as Clima;
  }

  if ('horas_perdidas' in parche) {
    const h = numero(parche.horas_perdidas);
    if (h === null || h < 0 || h > 24) {
      return { ok: false, motivo: 'Las horas perdidas van de 0 a 24' };
    }
    nuevo.horasPerdidas = h;
  }

  if ('motivo' in parche) nuevo.motivo = texto(parche.motivo) ?? undefined;
  if ('que_se_hizo' in parche) {
    const q = texto(parche.que_se_hizo);
    if (!q) return { ok: false, motivo: 'El trabajo ejecutado no puede ir en blanco' };
    nuevo.queSeHizo = q;
  }
  if ('atrasos' in parche) nuevo.atrasos = texto(parche.atrasos) ?? undefined;
  if ('novedades' in parche) nuevo.novedades = texto(parche.novedades) ?? undefined;

  if ('areas' in parche) {
    if (!Array.isArray(parche.areas)) return { ok: false, motivo: 'Las áreas van en una lista' };
    const ids: number[] = [];
    for (const a of parche.areas) {
      const id = entero(a);
      if (id === null || !listas.areas.some((x) => x.id === id)) {
        return { ok: false, motivo: `El área ${String(a)} no es de este proyecto` };
      }
      if (!ids.includes(id)) ids.push(id);
    }
    nuevo.areas = ids;
  }

  if ('personal' in parche) {
    if (!Array.isArray(parche.personal)) {
      return { ok: false, motivo: 'El personal va en una lista' };
    }
    const filas: FilaPersonal[] = [];
    for (const f of parche.personal) {
      if (typeof f !== 'object' || f === null) {
        return { ok: false, motivo: 'Cada fila de personal lleva puesto_id y cantidad' };
      }
      const r = f as Record<string, unknown>;
      const puestoId = entero(r.puesto_id);
      const cantidad = entero(r.cantidad);
      if (puestoId === null || !listas.puestos.some((p) => p.id === puestoId)) {
        return { ok: false, motivo: `El puesto ${String(r.puesto_id)} no es de este proyecto` };
      }
      if (cantidad === null || cantidad < 0) {
        return { ok: false, motivo: 'La cantidad de personal no puede ser negativa' };
      }
      filas.push({ puestoId, cantidad });
    }
    nuevo.personal = filas;
  }

  if ('equipos' in parche) {
    if (!Array.isArray(parche.equipos)) return { ok: false, motivo: 'El equipo va en una lista' };
    const filas: FilaEquipo[] = [];
    for (const f of parche.equipos) {
      if (typeof f !== 'object' || f === null) {
        return { ok: false, motivo: 'Cada fila de equipo lleva equipo_id, unidades y horas' };
      }
      const r = f as Record<string, unknown>;
      const equipoId = entero(r.equipo_id);
      const unidades = entero(r.unidades ?? 1);
      const horas = numero(r.horas ?? 0);
      if (equipoId === null || !listas.equipos.some((e) => e.id === equipoId)) {
        return { ok: false, motivo: `El equipo ${String(r.equipo_id)} no es de este proyecto` };
      }
      if (unidades === null || unidades < 0) return { ok: false, motivo: 'Unidades inválidas' };
      if (horas === null || horas < 0 || horas > 24) {
        return { ok: false, motivo: 'Las horas de un equipo van de 0 a 24' };
      }
      filas.push({ equipoId, unidades, horas });
    }
    nuevo.equipos = filas;
  }

  if ('entregas' in parche) {
    if (!Array.isArray(parche.entregas)) {
      return { ok: false, motivo: 'Las entregas van en una lista' };
    }
    const filas: FilaEntrega[] = [];
    for (const f of parche.entregas) {
      if (typeof f !== 'object' || f === null) {
        return { ok: false, motivo: 'Cada entrega lleva categoria_id y descripcion' };
      }
      const r = f as Record<string, unknown>;
      const categoriaId = entero(r.categoria_id);
      const descripcion = texto(r.descripcion);
      if (categoriaId === null || !listas.categorias.some((c) => c.id === categoriaId)) {
        return {
          ok: false,
          motivo: `La categoría ${String(r.categoria_id)} no es de este proyecto`,
        };
      }
      if (!descripcion) return { ok: false, motivo: 'Una entrega sin descripción no sirve' };
      filas.push({
        categoriaId,
        descripcion,
        cantidad: numero(r.cantidad),
        unidad: texto(r.unidad),
        notas: texto(r.notas),
      });
    }
    nuevo.entregas = filas;
  }

  if ('preguntadas' in parche && Array.isArray(parche.preguntadas)) {
    const ya = new Set(nuevo.preguntadas ?? []);
    for (const p of parche.preguntadas) {
      const clave = texto(p);
      if (clave && SECCIONES.some((s) => s.clave === clave)) ya.add(clave);
    }
    nuevo.preguntadas = [...ya];
  }

  return { ok: true, datos: nuevo };
}

/** Tiene esta seccion algo anotado? */
function contestada(datos: DatosReporte, clave: Seccion['clave'], fotos: number): boolean {
  switch (clave) {
    case 'fecha':
      return datos.fecha !== undefined;
    case 'clima':
      return datos.clima !== undefined;
    case 'horasPerdidas':
      return datos.horasPerdidas !== undefined;
    case 'areas':
      return datos.areas !== undefined;
    case 'queSeHizo':
      return datos.queSeHizo !== undefined;
    case 'atrasos':
      return datos.atrasos !== undefined;
    case 'novedades':
      return datos.novedades !== undefined;
    case 'personal':
      return datos.personal !== undefined;
    case 'equipos':
      return datos.equipos !== undefined;
    case 'entregas':
      return datos.entregas !== undefined;
    case 'fotos':
      return fotos > 0;
    default:
      return false;
  }
}

/**
 * Las secciones de las que el ingeniero no ha hablado y por las que tampoco se
 * le ha preguntado. Es la lista que el asistente va vaciando, una pregunta cada
 * vez.
 *
 * Con las listas del proyecto, un proyecto sin areas no pregunta por ellas: no
 * habria nada que anotar. El equipo si se pregunta aunque la lista este vacia,
 * porque la maquina que nombre la persona se agrega a la lista.
 */
export function faltantes(
  datos: DatosReporte,
  fotos: number,
  listas?: ListasProyecto | null,
): Seccion[] {
  const preguntadas = new Set(datos.preguntadas ?? []);
  const sinAreas = listas !== undefined && listas !== null && listas.areas.length === 0;
  return SECCIONES.filter(
    (s) =>
      !contestada(datos, s.clave, fotos) &&
      !preguntadas.has(String(s.clave)) &&
      !(sinAreas && s.clave === 'areas'),
  );
}

/** Un nombre como se compara: sin mayusculas, tildes, espacios ni signos. */
function normalizar(nombre: string): string {
  return nombre
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * La maquina de la lista que se parece a la que se quiere agregar, si hay una.
 *
 * `igual`: es la misma escrita de otra manera («Retro excavadora» y
 * «Retroexcavadora»); esa nunca se agrega. Si no, una contiene a la otra
 * («Retro» y «Retroexcavadora», «Mixer» y «Mixer 2»): puede ser la misma o no,
 * y eso solo lo sabe la persona. Un apodo que no se parece en nada no se caza.
 */
export function equipoParecido(
  nombre: string,
  equipos: { id: number; nombre: string }[],
): { equipo: { id: number; nombre: string }; igual: boolean } | null {
  const buscado = normalizar(nombre);
  if (!buscado) return null;
  const igual = equipos.find((e) => normalizar(e.nombre) === buscado);
  if (igual) return { equipo: igual, igual: true };
  const parecido = equipos.find((e) => {
    const otro = normalizar(e.nombre);
    return (
      Math.min(otro.length, buscado.length) >= 3 &&
      (otro.includes(buscado) || buscado.includes(otro))
    );
  });
  return parecido ? { equipo: parecido, igual: false } : null;
}

/**
 * La pregunta de las areas, con TODAS las del proyecto y numeradas.
 *
 * La lista la pone el codigo y no el modelo: en la primera prueba de verdad
 * (Cesar, 2026-09-18) el modelo resumio las areas con sus palabras y justo se
 * dejo fuera las dos donde se habia trabajado. Lo unico que escribe el modelo
 * es la frase de antes.
 */
export function preguntaDeAreas(
  areas: { id: number; nombre: string }[],
  pregunta?: string | null,
): string {
  const inicio = pregunta?.trim() || '¿En qué áreas se trabajó?';
  const lista = areas.map((a, i) => `${i + 1}. ${a.nombre}`).join('\n');
  return `${inicio}\n\n${lista}\n\nPuedes contestar con los números.`;
}

/** Lo que impide guardar el reporte, aunque ya se haya preguntado todo. */
export function obligatoriasQueFaltan(datos: DatosReporte): Seccion[] {
  return SECCIONES.filter((s) => s.obligatoria && !contestada(datos, s.clave, 0));
}

/** El resumen que se le manda por WhatsApp a la persona. */
export function resumen(
  datos: DatosReporte,
  listas: ListasProyecto,
  fotos: number,
): string {
  const nombre = <T extends { id: number; nombre: string }>(lista: T[], id: number): string =>
    lista.find((x) => x.id === id)?.nombre ?? `#${id}`;

  const lineas: string[] = [];
  if (datos.clima) {
    const horas = datos.horasPerdidas
      ? `, ${datos.horasPerdidas} h perdidas${datos.motivo ? ` (${datos.motivo})` : ''}`
      : '';
    lineas.push(`Clima: ${datos.clima}${horas}`);
  }
  if (datos.areas?.length) {
    lineas.push(`Áreas: ${datos.areas.map((id) => nombre(listas.areas, id)).join(', ')}`);
  }
  if (datos.queSeHizo) lineas.push(`Trabajo: ${datos.queSeHizo}`);
  if (datos.personal?.length) {
    const gente = datos.personal
      .filter((p) => p.cantidad > 0)
      .map((p) => `${p.cantidad} ${nombre(listas.puestos, p.puestoId)}`);
    if (gente.length) lineas.push(`Personal: ${gente.join(', ')}`);
  }
  if (datos.equipos?.length) {
    const maquinas = datos.equipos
      .filter((e) => e.horas > 0 || e.unidades > 0)
      .map((e) => `${nombre(listas.equipos, e.equipoId)} ${e.horas} h`);
    if (maquinas.length) lineas.push(`Equipo: ${maquinas.join(', ')}`);
  }
  if (datos.entregas?.length) {
    const cosas = datos.entregas.map(
      (e) =>
        `${e.descripcion}${e.cantidad !== null ? ` ${e.cantidad}${e.unidad ? ` ${e.unidad}` : ''}` : ''}`,
    );
    lineas.push(`Llegó: ${cosas.join(', ')}`);
  }
  if (datos.atrasos) lineas.push(`Atrasos: ${datos.atrasos}`);
  if (datos.novedades) lineas.push(`Novedades: ${datos.novedades}`);
  lineas.push(`Fotos: ${fotos}`);
  return lineas.join('\n');
}
