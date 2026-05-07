import { Router, Request, Response } from 'express';
import { param, validationResult } from 'express-validator';
import { query } from '../database/config.js';
import { authenticateToken } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

const router = Router();

interface ExternalContactRow {
  id: number;
  nombre: string;
  cargo?: string;
  telefono?: string;
  email?: string;
  notas?: string;
  activo: boolean;
  created_at: Date;
  updated_at: Date;
  creado_por?: number;
  creado_por_nombre?: string;
}

interface CreateContactBody {
  nombre: string;
  cargo?: string;
  telefono?: string;
  email?: string;
  notas?: string;
}

// GET - Obtener todos los contactos externos
router.get(
  '/',
  authenticateToken,
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const { activo } = req.query;

    let whereClause = '';
    if (activo === 'true') {
      whereClause = 'WHERE ec.activo = true';
    } else if (activo === 'false') {
      whereClause = 'WHERE ec.activo = false';
    }

    const result = await query<ExternalContactRow>(`
    SELECT
      ec.id,
      ec.nombre,
      ec.cargo,
      ec.telefono,
      ec.email,
      ec.notas,
      ec.activo,
      ec.created_at,
      ec.updated_at,
      ec.creado_por,
      u.nombre as creado_por_nombre
    FROM contactos_externos ec
    LEFT JOIN users u ON ec.creado_por = u.id
    ${whereClause}
    ORDER BY ec.nombre
  `);

    res.json({
      success: true,
      contacts: result.rows,
    });
  }),
);

// GET - Obtener un contacto externo por ID
router.get(
  '/:id',
  [param('id').isInt().withMessage('ID debe ser un número'), authenticateToken],
  asyncHandler(
    async (req: Request<{ id: string }>, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({
          success: false,
          message: 'ID inválido',
          errors: errors.array(),
        });
        return;
      }

      const { id } = req.params;

      const result = await query<ExternalContactRow>(
        `
    SELECT
      ec.id,
      ec.nombre,
      ec.cargo,
      ec.telefono,
      ec.email,
      ec.notas,
      ec.activo,
      ec.created_at,
      ec.updated_at,
      ec.creado_por,
      u.nombre as creado_por_nombre
    FROM contactos_externos ec
    LEFT JOIN users u ON ec.creado_por = u.id
    WHERE ec.id = $1
  `,
        [id],
      );

      if (result.rows.length === 0) {
        res.status(404).json({
          success: false,
          message: 'Contacto no encontrado',
        });
        return;
      }

      res.json({
        success: true,
        contact: result.rows[0],
      });
    },
  ),
);

// POST - Crear nuevo contacto externo
router.post(
  '/',
  authenticateToken,
  asyncHandler(
    async (
      req: Request<object, object, CreateContactBody>,
      res: Response,
    ): Promise<void> => {
      const { nombre, cargo, telefono, email, notas } = req.body;
      const creado_por = req.user!.id;

      if (!nombre || nombre.trim() === '') {
        res.status(400).json({
          success: false,
          message: 'El nombre es requerido',
        });
        return;
      }

      const result = await query<ExternalContactRow>(
        `
    INSERT INTO contactos_externos (nombre, cargo, telefono, email, notas, creado_por)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING *
  `,
        [
          nombre.trim(),
          cargo?.trim() || null,
          telefono?.trim() || null,
          email?.trim() || null,
          notas?.trim() || null,
          creado_por,
        ],
      );

      res.status(201).json({
        success: true,
        contact: result.rows[0],
        message: 'Contacto creado exitosamente',
      });
    },
  ),
);

// PUT - Actualizar contacto externo
router.put(
  '/:id',
  authenticateToken,
  asyncHandler(
    async (
      req: Request<{ id: string }, object, CreateContactBody>,
      res: Response,
    ): Promise<void> => {
      const { id } = req.params;
      const { nombre, cargo, telefono, email, notas } = req.body;

      if (!nombre || nombre.trim() === '') {
        res.status(400).json({
          success: false,
          message: 'El nombre es requerido',
        });
        return;
      }

      const result = await query<ExternalContactRow>(
        `
    UPDATE contactos_externos
    SET
      nombre = $1,
      cargo = $2,
      telefono = $3,
      email = $4,
      notas = $5,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = $6
    RETURNING *
  `,
        [
          nombre.trim(),
          cargo?.trim() || null,
          telefono?.trim() || null,
          email?.trim() || null,
          notas?.trim() || null,
          id,
        ],
      );

      if (result.rows.length === 0) {
        res.status(404).json({
          success: false,
          message: 'Contacto no encontrado',
        });
        return;
      }

      res.json({
        success: true,
        contact: result.rows[0],
        message: 'Contacto actualizado exitosamente',
      });
    },
  ),
);

// DELETE - Eliminar contacto externo (soft delete)
router.delete(
  '/:id',
  authenticateToken,
  asyncHandler(
    async (req: Request<{ id: string }>, res: Response): Promise<void> => {
      const { id } = req.params;

      // Verificar si el contacto tiene asignaciones activas
      const assignmentsCheck = await query<{ count: string }>(
        `
    SELECT COUNT(*) as count
    FROM proyecto_miembros
    WHERE contacto_externo_id = $1 AND activo = true
  `,
        [id],
      );

      if (parseInt(assignmentsCheck.rows[0].count) > 0) {
        res.status(400).json({
          success: false,
          message:
            'No se puede eliminar: el contacto tiene asignaciones activas en proyectos',
        });
        return;
      }

      const result = await query<ExternalContactRow>(
        `
    UPDATE contactos_externos
    SET activo = false, updated_at = CURRENT_TIMESTAMP
    WHERE id = $1
    RETURNING *
  `,
        [id],
      );

      if (result.rows.length === 0) {
        res.status(404).json({
          success: false,
          message: 'Contacto no encontrado',
        });
        return;
      }

      res.json({
        success: true,
        message: 'Contacto eliminado exitosamente',
      });
    },
  ),
);

// PATCH - Restaurar contacto externo
router.patch(
  '/:id/restaurar',
  authenticateToken,
  asyncHandler(
    async (req: Request<{ id: string }>, res: Response): Promise<void> => {
      const { id } = req.params;

      const result = await query<ExternalContactRow>(
        `
    UPDATE contactos_externos
    SET activo = true, updated_at = CURRENT_TIMESTAMP
    WHERE id = $1
    RETURNING *
  `,
        [id],
      );

      if (result.rows.length === 0) {
        res.status(404).json({
          success: false,
          message: 'Contacto no encontrado',
        });
        return;
      }

      res.json({
        success: true,
        contact: result.rows[0],
        message: 'Contacto restaurado exitosamente',
      });
    },
  ),
);

export default router;
