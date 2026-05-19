import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { body, validationResult } from 'express-validator';
import { query } from '../database/config.js';
import { authenticateToken, requireAdmin } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { registrarAudit } from '../services/auditLog.js';
import type { UserRole, UserType } from '../types/auth.js';

const router = Router();

interface UserRow {
  id: number;
  nombre: string;
  email: string | null;
  rol: UserRole;
  tipo_usuario: UserType;
  activo: boolean;
  created_at: Date;
  updated_at: Date;
}

interface CreateUserBody {
  nombre: string;
  email?: string;
  password?: string;
  rol?: UserRole;
  tipo_usuario?: UserType;
}

interface UpdateUserBody {
  nombre?: string;
  email?: string;
  rol?: UserRole;
}

interface SeleccionableRow {
  id: number;
  nombre: string;
  tipo_usuario: UserType;
}

// GET /seleccionables — Lista mínima para dropdowns (id, nombre, tipo_usuario).
// Cualquier usuario autenticado puede leerla. Se declara ANTES del router.use
// admin-only para que no quede gateada por requireAdmin.
router.get(
  '/seleccionables',
  authenticateToken,
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const tipo = req.query.tipo as string | undefined;

    let sql = 'SELECT id, nombre, tipo_usuario FROM users WHERE activo = true';
    const params: string[] = [];

    if (tipo === 'interno' || tipo === 'externo') {
      sql += ' AND tipo_usuario = $1';
      params.push(tipo);
    }

    sql += ' ORDER BY tipo_usuario, nombre';

    const result = await query<SeleccionableRow>(sql, params);

    res.json({
      success: true,
      data: result.rows,
    });
  }),
);

// Todas las rutas siguientes requieren autenticación + admin
router.use(authenticateToken, requireAdmin);

// GET / — Listar usuarios (filtro opcional: ?tipo=interno|externo)
router.get(
  '/',
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const tipo = req.query.tipo as string | undefined;

    let sql =
      'SELECT id, nombre, email, rol, tipo_usuario, activo, created_at, updated_at FROM users';
    const params: string[] = [];

    if (tipo === 'interno' || tipo === 'externo') {
      sql += ' WHERE tipo_usuario = $1';
      params.push(tipo);
    }

    sql += ' ORDER BY tipo_usuario, nombre';

    const result = await query<UserRow>(sql, params);

    res.json({
      success: true,
      users: result.rows,
    });
  }),
);

// POST / — Crear usuario (interno o externo)
router.post(
  '/',
  [
    body('nombre')
      .trim()
      .isLength({ min: 2 })
      .withMessage('Nombre debe tener al menos 2 caracteres'),
    body('tipo_usuario')
      .optional()
      .isIn(['interno', 'externo'])
      .withMessage('Tipo inválido'),
    // Email y password solo obligatorios para internos (se valida manualmente)
    body('email').optional().isEmail().withMessage('Email inválido'),
    body('password')
      .optional()
      .isLength({ min: 6 })
      .withMessage('Password debe tener al menos 6 caracteres'),
    body('rol')
      .optional()
      .isIn(['admin', 'co-admin', 'usuario'])
      .withMessage('Rol inválido'),
  ],
  asyncHandler(
    async (
      req: Request<object, object, CreateUserBody>,
      res: Response,
    ): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({
          success: false,
          message: 'Datos inválidos',
          errors: errors.array(),
        });
        return;
      }

      const { nombre, tipo_usuario = 'interno' } = req.body;

      if (tipo_usuario === 'externo') {
        // Usuario externo: solo nombre, sin email/password/permisos
        const result = await query<UserRow>(
          `INSERT INTO users (nombre, tipo_usuario, debe_cambiar_password)
       VALUES ($1, 'externo', false)
       RETURNING id, nombre, email, rol, tipo_usuario, activo, created_at, updated_at`,
          [nombre],
        );

        res.status(201).json({
          success: true,
          message: 'Usuario externo creado exitosamente',
          user: result.rows[0],
        });
        return;
      }

      // Usuario interno: flujo original
      const { email, password, rol = 'usuario' } = req.body;

      if (!email) {
        res.status(400).json({
          success: false,
          message: 'Email es requerido para usuarios internos',
        });
        return;
      }
      if (!password || password.length < 6) {
        res.status(400).json({
          success: false,
          message: 'Password debe tener al menos 6 caracteres',
        });
        return;
      }

      // Verificar email duplicado
      const existing = await query<{ id: number }>(
        'SELECT id FROM users WHERE email = $1',
        [email],
      );
      if (existing.rows.length > 0) {
        res.status(400).json({
          success: false,
          message: 'El email ya está registrado',
        });
        return;
      }

      const hashedPassword = await bcrypt.hash(password, 10);

      const result = await query<UserRow>(
        `INSERT INTO users (nombre, email, password, rol, tipo_usuario, debe_cambiar_password)
     VALUES ($1, $2, $3, $4, 'interno', true)
     RETURNING id, nombre, email, rol, tipo_usuario, activo, created_at, updated_at`,
        [nombre, email, hashedPassword, rol],
      );

      // Auto-crear row en user_permissions para usuario y co-admin
      if (rol === 'usuario' || rol === 'co-admin') {
        await query(
          'INSERT INTO user_permissions (user_id) VALUES ($1) ON CONFLICT DO NOTHING',
          [result.rows[0].id],
        );
      }

      res.status(201).json({
        success: true,
        message: 'Usuario creado exitosamente',
        user: result.rows[0],
      });
    },
  ),
);

// PUT /:id — Editar usuario (sin cambiar contraseña)
router.put(
  '/:id',
  [
    body('nombre')
      .optional()
      .trim()
      .isLength({ min: 2 })
      .withMessage('Nombre debe tener al menos 2 caracteres'),
    body('email').optional().isEmail().withMessage('Email inválido'),
    body('rol')
      .optional()
      .isIn(['admin', 'co-admin', 'usuario'])
      .withMessage('Rol inválido'),
  ],
  asyncHandler(
    async (
      req: Request<{ id: string }, object, UpdateUserBody>,
      res: Response,
    ): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({
          success: false,
          message: 'Datos inválidos',
          errors: errors.array(),
        });
        return;
      }

      const { id } = req.params;
      const { nombre, email, rol } = req.body;

      // Verificar que el usuario existe
      const existing = await query<UserRow>(
        'SELECT id, rol, tipo_usuario FROM users WHERE id = $1',
        [id],
      );

      // Si es externo, solo permitir editar nombre
      if (
        existing.rows.length > 0 &&
        existing.rows[0].tipo_usuario === 'externo'
      ) {
        if (email || rol) {
          res.status(400).json({
            success: false,
            message: 'Los usuarios externos solo pueden editar el nombre',
          });
          return;
        }
      }

      // Co-admin no puede modificar usuarios admin
      if (
        existing.rows.length > 0 &&
        existing.rows[0].rol === 'admin' &&
        req.user?.rol === 'co-admin'
      ) {
        res.status(403).json({
          success: false,
          message: 'No puedes modificar usuarios administradores',
        });
        return;
      }
      if (existing.rows.length === 0) {
        res.status(404).json({
          success: false,
          message: 'Usuario no encontrado',
        });
        return;
      }

      // Si cambia email, verificar que no esté duplicado
      if (email) {
        const emailCheck = await query<{ id: number }>(
          'SELECT id FROM users WHERE email = $1 AND id != $2',
          [email, id],
        );
        if (emailCheck.rows.length > 0) {
          res.status(400).json({
            success: false,
            message: 'El email ya está en uso por otro usuario',
          });
          return;
        }
      }

      // Construir query dinámico
      const fields: string[] = [];
      const values: unknown[] = [];
      let paramIndex = 1;

      if (nombre !== undefined) {
        fields.push(`nombre = $${paramIndex++}`);
        values.push(nombre);
      }
      if (email !== undefined) {
        fields.push(`email = $${paramIndex++}`);
        values.push(email);
      }
      if (rol !== undefined) {
        fields.push(`rol = $${paramIndex++}`);
        values.push(rol);
      }

      if (fields.length === 0) {
        res.status(400).json({
          success: false,
          message: 'No se proporcionaron campos para actualizar',
        });
        return;
      }

      fields.push(`updated_at = CURRENT_TIMESTAMP`);
      values.push(id);

      const result = await query<UserRow>(
        `UPDATE users SET ${fields.join(', ')} WHERE id = $${paramIndex} RETURNING id, nombre, email, rol, tipo_usuario, activo, created_at, updated_at`,
        values,
      );

      await registrarAudit(req.user!.id, 'editar', 'usuario', parseInt(id), {
        nombre: result.rows[0].nombre,
        campos_modificados: Object.keys(req.body).filter((k) =>
          ['nombre', 'email', 'rol'].includes(k),
        ),
      });

      res.json({
        success: true,
        message: 'Usuario actualizado exitosamente',
        user: result.rows[0],
      });
    },
  ),
);

// DELETE /:id — Desactivar/activar usuario (toggle)
router.delete(
  '/:id',
  asyncHandler(
    async (req: Request<{ id: string }>, res: Response): Promise<void> => {
      const { id } = req.params;

      // No permitir que se desactive a sí mismo
      if (req.user && req.user.id === parseInt(id)) {
        res.status(400).json({
          success: false,
          message: 'No puedes desactivar tu propia cuenta',
        });
        return;
      }

      // Co-admin no puede desactivar admin
      if (req.user?.rol === 'co-admin') {
        const target = await query<{ rol: string }>(
          'SELECT rol FROM users WHERE id = $1',
          [id],
        );
        if (target.rows.length > 0 && target.rows[0].rol === 'admin') {
          res.status(403).json({
            success: false,
            message: 'No puedes desactivar usuarios administradores',
          });
          return;
        }
      }

      const result = await query<UserRow>(
        'UPDATE users SET activo = NOT activo, updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING id, nombre, email, rol, activo, created_at, updated_at',
        [id],
      );

      if (result.rows.length === 0) {
        res.status(404).json({
          success: false,
          message: 'Usuario no encontrado',
        });
        return;
      }

      const user = result.rows[0];
      const accion = user.activo ? 'activar' : 'desactivar';
      await registrarAudit(req.user!.id, accion, 'usuario', parseInt(id), {
        nombre: user.nombre,
      });

      res.json({
        success: true,
        message: user.activo ? 'Usuario activado' : 'Usuario desactivado',
        user,
      });
    },
  ),
);

export default router;
