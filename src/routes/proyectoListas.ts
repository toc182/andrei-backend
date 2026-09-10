/**
 * Las listas del proyecto que alimentan el reporte diario.
 *
 * Cuatro listas con la misma forma —empresas, puestos, equipos y categorías de
 * entrega— y por eso un solo archivo con una tabla de configuración en vez de
 * cuatro rutas casi idénticas. El nombre de la tabla NUNCA sale del usuario:
 * sale de LISTAS, que es un mapa fijo escrito aquí.
 *
 * Reglas que valen para las cuatro (acordadas con Ivan el 2026-09-10):
 *   - Se agregan y se quitan; no se renombran.
 *   - Quitar y volver a poner el mismo nombre REACTIVA la fila vieja. Si se
 *     creara una nueva, un reporte viejo y uno nuevo apuntarían a dos filas con
 *     el mismo nombre y el PDF mostraría la línea dos veces.
 *   - Baja lógica, nunca borrado: los reportes ya guardados siguen apuntando.
 *
 * Los puestos son el caso especial: `empresa_id` nulo es el bloque propio
 * (Pinellas) y con valor es el de esa empresa. Cada bloque es dueño de sus
 * puestos, así que quitar uno del bloque propio no toca los de una empresa.
 */

import { Router, Request, Response } from 'express';
import { query } from '../database/config.js';
import {
  authenticateToken,
  checkPermission,
  checkProjectAccess,
} from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { registrarAudit } from '../services/auditLog.js';

const router = Router();

/** Los cuatro puestos con los que nace un bloque, en su orden. */
export const PUESTOS_BASE = ['Ingenieros', 'Supervisores', 'Calificados', 'Ayudantes'];

/** Las categorías de entrega con las que nace un proyecto. */
const CATEGORIAS_BASE = ['Material', 'Equipo', 'Herramienta'];

interface Lista {
  tabla: string;
  entidad: string;
  singular: string;
}

// El único lugar de donde puede salir un nombre de tabla.
const LISTAS: Record<string, Lista> = {
  empresas: { tabla: 'proyecto_empresas', entidad: 'proyecto_empresa', singular: 'La empresa' },
  puestos: { tabla: 'proyecto_puestos', entidad: 'proyecto_puesto', singular: 'El puesto' },
  equipos: { tabla: 'proyecto_equipos', entidad: 'proyecto_equipo', singular: 'El equipo' },
  categorias: {
    tabla: 'proyecto_entrega_categorias',
    entidad: 'proyecto_entrega_categoria',
    singular: 'La categoría',
  },
};

interface FilaLista {
  id: number;
  proyecto_id: number;
  nombre: string;
  orden: number;
  activo: boolean;
  empresa_id?: number | null;
  fijo?: boolean;
}

function leerNombre(req: Request): string {
  return String((req.body as { nombre?: unknown })?.nombre ?? '').trim();
}

/** empresa_id solo lo usan los puestos; en las demás listas se ignora. */
function leerEmpresaId(req: Request): number | null {
  const v = (req.body as { empresa_id?: unknown })?.empresa_id;
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Un proyecto que nunca ha tenido reportes no tiene listas. En vez de tocar la
 * ruta de creación de proyectos, se siembran la primera vez que alguien las
 * pide. Es idempotente, así que puede llamarse cuantas veces sea.
 */
export async function asegurarListasBase(proyectoId: number | string): Promise<void> {
  await query(
    `INSERT INTO proyecto_puestos (proyecto_id, empresa_id, nombre, orden, fijo)
     SELECT $1, NULL, v.nombre, v.orden, TRUE
       FROM unnest($2::text[]) WITH ORDINALITY AS v(nombre, orden)
      WHERE NOT EXISTS (
        SELECT 1 FROM proyecto_puestos x
         WHERE x.proyecto_id = $1 AND x.empresa_id IS NULL
           AND lower(x.nombre) = lower(v.nombre) AND x.activo
      )`,
    [proyectoId, PUESTOS_BASE],
  );
  await query(
    `INSERT INTO proyecto_entrega_categorias (proyecto_id, nombre, orden)
     SELECT $1, v.nombre, v.orden
       FROM unnest($2::text[]) WITH ORDINALITY AS v(nombre, orden)
      WHERE NOT EXISTS (
        SELECT 1 FROM proyecto_entrega_categorias x
         WHERE x.proyecto_id = $1 AND lower(x.nombre) = lower(v.nombre) AND x.activo
      )`,
    [proyectoId, CATEGORIAS_BASE],
  );
}

/** Una empresa nueva nace con los mismos cuatro puestos, y de ahí se recorta. */
async function sembrarPuestosDeEmpresa(
  proyectoId: number | string,
  empresaId: number,
  usuarioId: number,
): Promise<void> {
  await query(
    `INSERT INTO proyecto_puestos (proyecto_id, empresa_id, nombre, orden, fijo, creado_por)
     SELECT $1, $2, v.nombre, v.orden, FALSE, $4
       FROM unnest($3::text[]) WITH ORDINALITY AS v(nombre, orden)`,
    [proyectoId, empresaId, PUESTOS_BASE, usuarioId],
  );
}

async function leerLista(
  tabla: string,
  proyectoId: number | string,
): Promise<FilaLista[]> {
  const columnas = tabla === 'proyecto_puestos'
    ? 'id, proyecto_id, empresa_id, nombre, orden, fijo, activo'
    : 'id, proyecto_id, nombre, orden, activo';
  const r = await query<FilaLista>(
    `SELECT ${columnas} FROM ${tabla}
      WHERE proyecto_id = $1 AND activo = true
      ORDER BY orden, id`,
    [proyectoId],
  );
  return r.rows;
}

// ---------------------------------------------------------------------------

// GET /api/proyecto-listas/:proyectoId — las cuatro de una vez.
//
// En una sola petición a propósito: el formulario las necesita todas y se llena
// en obra, donde cuatro viajes de red son cuatro maneras de fallar.
router.get(
  '/:proyectoId',
  authenticateToken,
  checkPermission('reportes'),
  checkProjectAccess('proyectoId'),
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const { proyectoId } = req.params;
    await asegurarListasBase(proyectoId);
    const [empresas, puestos, equipos, categorias] = await Promise.all([
      leerLista('proyecto_empresas', proyectoId),
      leerLista('proyecto_puestos', proyectoId),
      leerLista('proyecto_equipos', proyectoId),
      leerLista('proyecto_entrega_categorias', proyectoId),
    ]);
    res.json({ success: true, data: { empresas, puestos, equipos, categorias } });
  }),
);

// POST /api/proyecto-listas/:proyectoId/:lista — agregar (o reactivar)
router.post(
  '/:proyectoId/:lista',
  authenticateToken,
  checkPermission('reportes'),
  checkProjectAccess('proyectoId'),
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const conf = LISTAS[req.params.lista];
    if (!conf) {
      res.status(404).json({ success: false, message: 'Lista desconocida' });
      return;
    }

    const { proyectoId } = req.params;
    const nombre = leerNombre(req);
    if (!nombre) {
      res.status(400).json({ success: false, message: 'El nombre es obligatorio' });
      return;
    }

    const esPuesto = conf.tabla === 'proyecto_puestos';
    const empresaId = esPuesto ? leerEmpresaId(req) : null;

    // El bloque al que pertenece: para los puestos, la empresa (o el propio);
    // para las demás listas, el proyecto entero.
    const filtroBloque = esPuesto
      ? 'AND COALESCE(empresa_id, 0) = COALESCE($3::int, 0)'
      : '';
    const params: unknown[] = esPuesto
      ? [proyectoId, nombre, empresaId]
      : [proyectoId, nombre];

    const yaActiva = await query(
      `SELECT 1 FROM ${conf.tabla}
        WHERE proyecto_id = $1 AND lower(nombre) = lower($2) AND activo = true ${filtroBloque}`,
      params,
    );
    if (yaActiva.rows.length > 0) {
      res.status(409).json({ success: false, message: `${conf.singular} "${nombre}" ya está en la lista` });
      return;
    }

    // Si alguna vez existió y se quitó, se revive. Crear una fila nueva dejaría
    // dos con el mismo nombre y los reportes viejos apuntando a la otra.
    const dormida = await query<{ id: number }>(
      `SELECT id FROM ${conf.tabla}
        WHERE proyecto_id = $1 AND lower(nombre) = lower($2) AND activo = false ${filtroBloque}
        ORDER BY id LIMIT 1`,
      params,
    );

    let fila: FilaLista;
    if (dormida.rows.length > 0) {
      const r = await query<FilaLista>(
        `UPDATE ${conf.tabla} SET activo = true WHERE id = $1 RETURNING *`,
        [dormida.rows[0].id],
      );
      fila = r.rows[0];
      await registrarAudit(req.user!.id, 'crear', conf.entidad, fila.id, {
        proyecto_id: Number(proyectoId), nombre, reactivada: true,
      });
    } else {
      const orden = await query<{ next: number }>(
        `SELECT COALESCE(MAX(orden), 0) + 1 AS next FROM ${conf.tabla} WHERE proyecto_id = $1`,
        [proyectoId],
      );
      const r = esPuesto
        ? await query<FilaLista>(
          `INSERT INTO proyecto_puestos (proyecto_id, empresa_id, nombre, orden, fijo, creado_por)
           VALUES ($1, $2, $3, $4, FALSE, $5) RETURNING *`,
          [proyectoId, empresaId, nombre, orden.rows[0].next, req.user!.id],
        )
        : await query<FilaLista>(
          `INSERT INTO ${conf.tabla} (proyecto_id, nombre, orden, creado_por)
           VALUES ($1, $2, $3, $4) RETURNING *`,
          [proyectoId, nombre, orden.rows[0].next, req.user!.id],
        );
      fila = r.rows[0];
      await registrarAudit(req.user!.id, 'crear', conf.entidad, fila.id, {
        proyecto_id: Number(proyectoId), nombre,
      });
    }

    // Una empresa nueva nace con los cuatro puestos de siempre.
    if (conf.tabla === 'proyecto_empresas') {
      const tiene = await query(
        'SELECT 1 FROM proyecto_puestos WHERE empresa_id = $1 AND activo = true LIMIT 1',
        [fila.id],
      );
      if (tiene.rows.length === 0) {
        await sembrarPuestosDeEmpresa(proyectoId, fila.id, req.user!.id);
      }
    }

    res.status(201).json({ success: true, data: fila });
  }),
);

// DELETE /api/proyecto-listas/:proyectoId/:lista/:id — baja lógica
router.delete(
  '/:proyectoId/:lista/:id',
  authenticateToken,
  checkPermission('reportes'),
  checkProjectAccess('proyectoId'),
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const conf = LISTAS[req.params.lista];
    if (!conf) {
      res.status(404).json({ success: false, message: 'Lista desconocida' });
      return;
    }

    // Los cuatro de arranque del bloque propio no se quitan. Dentro de una
    // empresa sí, porque un subcontratista rara vez trae los cuatro.
    if (conf.tabla === 'proyecto_puestos') {
      const p = await query<{ fijo: boolean }>(
        'SELECT fijo FROM proyecto_puestos WHERE id = $1 AND proyecto_id = $2',
        [req.params.id, req.params.proyectoId],
      );
      if (p.rows[0]?.fijo) {
        res.status(400).json({
          success: false,
          message: 'Ese puesto viene de fábrica y no se puede quitar',
        });
        return;
      }
    }

    const result = await query(
      `UPDATE ${conf.tabla} SET activo = false
        WHERE id = $1 AND proyecto_id = $2 AND activo = true`,
      [req.params.id, req.params.proyectoId],
    );
    if (result.rowCount === 0) {
      res.status(404).json({ success: false, message: 'No encontrado' });
      return;
    }

    // Quitar una empresa se lleva sus puestos: son suyos, no del proyecto.
    if (conf.tabla === 'proyecto_empresas') {
      await query(
        'UPDATE proyecto_puestos SET activo = false WHERE empresa_id = $1',
        [req.params.id],
      );
    }

    await registrarAudit(req.user!.id, 'eliminar', conf.entidad, Number(req.params.id), {
      proyecto_id: Number(req.params.proyectoId),
    });

    res.json({ success: true });
  }),
);

export default router;
