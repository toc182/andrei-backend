import { Router, Request, Response } from 'express';
import { body, param, validationResult } from 'express-validator';
import type { PoolClient } from 'pg';
import { query, pool } from '../database/config.js';
import { authenticateToken, requireAdmin } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { registrarAudit } from '../services/auditLog.js';
import { escribirLlavesDePerfil, esLlaveDePerfil } from '../services/perfiles.js';

// Perfiles de permisos (migración 190): el juego de permisos de un puesto.
// Los maneja quien maneja los permisos hoy: admin y co-admin.
const router = Router();
router.use(authenticateToken, requireAdmin);

interface PerfilFila {
  id: number;
  nombre: string;
  descripcion: string | null;
  llaves: string[];
  personas: { id: number; nombre: string; activo: boolean }[];
}

interface PerfilCuerpo {
  nombre?: string;
  descripcion?: string | null;
  llaves?: unknown;
}

function invalido(req: Parameters<typeof validationResult>[0], res: Response): boolean {
  const errores = validationResult(req);
  if (errores.isEmpty()) return false;
  res.status(400).json({ success: false, message: errores.array()[0].msg });
  return true;
}

/** Las llaves que llegan, o un mensaje si alguna no es de perfil. */
function leerLlaves(llaves: unknown): { ok: true; llaves: Set<string> } | { ok: false; mensaje: string } {
  if (!Array.isArray(llaves) || llaves.some((l) => typeof l !== 'string')) {
    return { ok: false, mensaje: 'Los permisos del perfil deben ser una lista' };
  }
  const ajena = (llaves as string[]).find((l) => !esLlaveDePerfil(l));
  if (ajena) return { ok: false, mensaje: `Un perfil no puede dar «${ajena}»` };
  return { ok: true, llaves: new Set(llaves as string[]) };
}

async function nombreOcupado(nombre: string, salvoId: number | null): Promise<boolean> {
  const r = await query(
    'SELECT 1 FROM permission_profiles WHERE activo AND LOWER(nombre) = LOWER($1) AND id <> COALESCE($2, 0)',
    [nombre, salvoId],
  );
  return r.rows.length > 0;
}

async function guardarLlaves(db: PoolClient, perfilId: number, llaves: Set<string>): Promise<void> {
  await db.query('DELETE FROM permission_profile_keys WHERE profile_id = $1', [perfilId]);
  for (const llave of llaves) {
    await db.query(
      'INSERT INTO permission_profile_keys (profile_id, permission_key) VALUES ($1, $2)',
      [perfilId, llave],
    );
  }
}

// GET / — los perfiles vivos, con sus llaves y quiénes lo tienen
router.get(
  '/',
  asyncHandler(async (_req: Request, res: Response): Promise<void> => {
    const r = await query<PerfilFila>(
      `SELECT p.id, p.nombre, p.descripcion,
              COALESCE((SELECT array_agg(k.permission_key ORDER BY k.permission_key)
                          FROM permission_profile_keys k WHERE k.profile_id = p.id), '{}') AS llaves,
              COALESCE((SELECT json_agg(json_build_object('id', u.id, 'nombre', u.nombre, 'activo', u.activo)
                                        ORDER BY u.nombre)
                          FROM users u WHERE u.permission_profile_id = p.id), '[]') AS personas
         FROM permission_profiles p
        WHERE p.activo
        ORDER BY p.nombre`,
    );
    res.json({ success: true, data: r.rows });
  }),
);

// POST / — perfil nuevo. Nace sin personas.
router.post(
  '/',
  [
    body('nombre').isString().trim().isLength({ min: 2, max: 80 })
      .withMessage('El nombre del perfil debe tener entre 2 y 80 caracteres'),
    body('descripcion').optional({ nullable: true }).isString().trim(),
  ],
  asyncHandler(async (req: Request<object, object, PerfilCuerpo>, res: Response): Promise<void> => {
    if (invalido(req, res)) return;
    const nombre = req.body.nombre!;
    const llaves = leerLlaves(req.body.llaves ?? []);
    if (!llaves.ok) {
      res.status(400).json({ success: false, message: llaves.mensaje });
      return;
    }
    if (await nombreOcupado(nombre, null)) {
      res.status(400).json({ success: false, message: `Ya hay un perfil «${nombre}»` });
      return;
    }

    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      const nuevo = await db.query<{ id: number }>(
        `INSERT INTO permission_profiles (nombre, descripcion, created_by, updated_by)
         VALUES ($1, $2, $3, $3) RETURNING id`,
        [nombre, req.body.descripcion || null, req.user!.id],
      );
      const id = nuevo.rows[0].id;
      await guardarLlaves(db, id, llaves.llaves);
      await registrarAudit(req.user!.id, 'crear', 'perfil_permisos', id, {
        nombre,
        llaves: [...llaves.llaves].sort(),
      }, db);
      await db.query('COMMIT');
      res.status(201).json({ success: true, data: { id } });
    } catch (err) {
      await db.query('ROLLBACK');
      // Dos guardados a la vez con el mismo nombre: el índice único lo para.
      if ((err as { code?: string }).code === '23505') {
        res.status(400).json({ success: false, message: 'Ya hay un perfil con ese nombre' });
        return;
      }
      throw err;
    } finally {
      db.release();
    }
  }),
);

// PUT /:id — cambiar nombre, descripción o permisos. Cambiar los permisos los
// cambia para todos los que tienen el perfil, en la misma transacción.
router.put(
  '/:id',
  [
    param('id').isInt().withMessage('Perfil inválido'),
    body('nombre').optional().isString().trim().isLength({ min: 2, max: 80 })
      .withMessage('El nombre del perfil debe tener entre 2 y 80 caracteres'),
    body('descripcion').optional({ nullable: true }).isString().trim(),
  ],
  asyncHandler(async (req: Request<{ id: string }, object, PerfilCuerpo>, res: Response): Promise<void> => {
    if (invalido(req, res)) return;
    const id = parseInt(req.params.id, 10);
    const { nombre, descripcion } = req.body;
    let llaves: Set<string> | null = null;
    if (req.body.llaves !== undefined) {
      const leidas = leerLlaves(req.body.llaves);
      if (!leidas.ok) {
        res.status(400).json({ success: false, message: leidas.mensaje });
        return;
      }
      llaves = leidas.llaves;
    }

    const existe = await query<{ nombre: string }>(
      'SELECT nombre FROM permission_profiles WHERE id = $1 AND activo',
      [id],
    );
    if (existe.rows.length === 0) {
      res.status(404).json({ success: false, message: 'Perfil no encontrado' });
      return;
    }
    if (nombre !== undefined && (await nombreOcupado(nombre, id))) {
      res.status(400).json({ success: false, message: `Ya hay un perfil «${nombre}»` });
      return;
    }

    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      // Solo lo que llegó: lo que no vino no se toca.
      const campos: string[] = [];
      const valores: unknown[] = [];
      if (nombre !== undefined) {
        valores.push(nombre);
        campos.push(`nombre = $${valores.length}`);
      }
      if (descripcion !== undefined) {
        valores.push(descripcion || null);
        campos.push(`descripcion = $${valores.length}`);
      }
      valores.push(req.user!.id);
      campos.push(`updated_by = $${valores.length}`, 'updated_at = CURRENT_TIMESTAMP');
      valores.push(id);
      await db.query(`UPDATE permission_profiles SET ${campos.join(', ')} WHERE id = $${valores.length}`, valores);

      let personas = 0;
      if (llaves) {
        await guardarLlaves(db, id, llaves);
        // Gerencia y el dueño no llevan perfil (lo quita users.ts al cambiar
        // el rol); el filtro por rol es por si acaso.
        const quienes = await db.query<{ id: number }>(
          "SELECT id FROM users WHERE permission_profile_id = $1 AND rol = 'usuario' ORDER BY id",
          [id],
        );
        for (const persona of quienes.rows) {
          const cambios = await escribirLlavesDePerfil(db, persona.id, llaves);
          if (cambios.length > 0) {
            await registrarAudit(req.user!.id, 'aplicar_perfil', 'user', persona.id, {
              perfil_id: id,
              cambios,
            }, db);
          }
        }
        personas = quienes.rows.length;
      }

      await registrarAudit(req.user!.id, 'editar', 'perfil_permisos', id, {
        campos_modificados: Object.keys(req.body).filter((k) => ['nombre', 'descripcion', 'llaves'].includes(k)),
        ...(llaves ? { llaves: [...llaves].sort(), personas } : {}),
      }, db);
      await db.query('COMMIT');
      res.json({ success: true, data: { id, personas } });
    } catch (err) {
      await db.query('ROLLBACK');
      // Dos guardados a la vez con el mismo nombre: el índice único lo para.
      if ((err as { code?: string }).code === '23505') {
        res.status(400).json({ success: false, message: 'Ya hay un perfil con ese nombre' });
        return;
      }
      throw err;
    } finally {
      db.release();
    }
  }),
);

// DELETE /:id — quitar el perfil. Sus personas quedan en «Personalizado» con
// exactamente las mismas llaves: nadie gana ni pierde nada.
router.delete(
  '/:id',
  [param('id').isInt().withMessage('Perfil inválido')],
  asyncHandler(async (req: Request<{ id: string }>, res: Response): Promise<void> => {
    if (invalido(req, res)) return;
    const id = parseInt(req.params.id, 10);
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      const quitado = await db.query<{ nombre: string }>(
        `UPDATE permission_profiles SET activo = false, updated_by = $2, updated_at = CURRENT_TIMESTAMP
          WHERE id = $1 AND activo RETURNING nombre`,
        [id, req.user!.id],
      );
      if (quitado.rows.length === 0) {
        await db.query('ROLLBACK');
        res.status(404).json({ success: false, message: 'Perfil no encontrado' });
        return;
      }
      const sueltos = await db.query<{ id: number }>(
        'UPDATE users SET permission_profile_id = NULL WHERE permission_profile_id = $1 RETURNING id',
        [id],
      );
      await registrarAudit(req.user!.id, 'quitar', 'perfil_permisos', id, {
        nombre: quitado.rows[0].nombre,
        personas_a_personalizado: sueltos.rows.map((r) => r.id),
      }, db);
      await db.query('COMMIT');
      res.json({ success: true, data: { personas: sueltos.rows.length } });
    } catch (err) {
      await db.query('ROLLBACK');
      // Dos guardados a la vez con el mismo nombre: el índice único lo para.
      if ((err as { code?: string }).code === '23505') {
        res.status(400).json({ success: false, message: 'Ya hay un perfil con ese nombre' });
        return;
      }
      throw err;
    } finally {
      db.release();
    }
  }),
);

export default router;
