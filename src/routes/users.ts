import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { body, validationResult } from 'express-validator';
import { query } from '../database/config.js';
import { authenticateToken, requireAdmin } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { registrarAudit } from '../services/auditLog.js';
import type { UserRole } from '../types/auth.js';

const router = Router();

interface UserRow {
  id: number;
  nombre: string;
  email: string;
  rol: UserRole;
  activo: boolean;
  created_at: Date;
  updated_at: Date;
}

interface CreateUserBody {
  nombre: string;
  email: string;
  password: string;
  rol?: UserRole;
}

interface UpdateUserBody {
  nombre?: string;
  email?: string;
  rol?: UserRole;
}

// Todas las rutas requieren autenticación + admin
router.use(authenticateToken, requireAdmin);

// GET / — Listar todos los usuarios
router.get('/', asyncHandler(async (_req: Request, res: Response): Promise<void> => {
  const result = await query<UserRow>(
    'SELECT id, nombre, email, rol, activo, created_at, updated_at FROM users ORDER BY id'
  );

  res.json({
    success: true,
    users: result.rows
  });
}));

// POST / — Crear usuario
router.post('/', [
  body('nombre').trim().isLength({ min: 2 }).withMessage('Nombre debe tener al menos 2 caracteres'),
  body('email').isEmail().withMessage('Email inválido'),
  body('password').isLength({ min: 6 }).withMessage('Password debe tener al menos 6 caracteres'),
  body('rol').optional().isIn(['admin', 'co-admin', 'usuario']).withMessage('Rol inválido')
], asyncHandler(async (req: Request<object, object, CreateUserBody>, res: Response): Promise<void> => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({
      success: false,
      message: 'Datos inválidos',
      errors: errors.array()
    });
    return;
  }

  const { nombre, email, password, rol = 'usuario' } = req.body;

  // Verificar email duplicado
  const existing = await query<{ id: number }>('SELECT id FROM users WHERE email = $1', [email]);
  if (existing.rows.length > 0) {
    res.status(400).json({
      success: false,
      message: 'El email ya está registrado'
    });
    return;
  }

  const hashedPassword = await bcrypt.hash(password, 10);

  const result = await query<UserRow>(
    'INSERT INTO users (nombre, email, password, rol) VALUES ($1, $2, $3, $4) RETURNING id, nombre, email, rol, activo, created_at, updated_at',
    [nombre, email, hashedPassword, rol]
  );

  // Auto-crear row en user_permissions para usuario y co-admin
  if (rol === 'usuario' || rol === 'co-admin') {
    await query('INSERT INTO user_permissions (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [result.rows[0].id]);
  }

  res.status(201).json({
    success: true,
    message: 'Usuario creado exitosamente',
    user: result.rows[0]
  });
}));

// PUT /:id — Editar usuario (sin cambiar contraseña)
router.put('/:id', [
  body('nombre').optional().trim().isLength({ min: 2 }).withMessage('Nombre debe tener al menos 2 caracteres'),
  body('email').optional().isEmail().withMessage('Email inválido'),
  body('rol').optional().isIn(['admin', 'co-admin', 'usuario']).withMessage('Rol inválido')
], asyncHandler(async (req: Request<{ id: string }, object, UpdateUserBody>, res: Response): Promise<void> => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({
      success: false,
      message: 'Datos inválidos',
      errors: errors.array()
    });
    return;
  }

  const { id } = req.params;
  const { nombre, email, rol } = req.body;

  // Verificar que el usuario existe
  const existing = await query<UserRow>('SELECT id, rol FROM users WHERE id = $1', [id]);

  // Co-admin no puede modificar usuarios admin
  if (existing.rows.length > 0 && existing.rows[0].rol === 'admin' && req.user?.rol === 'co-admin') {
    res.status(403).json({
      success: false,
      message: 'No puedes modificar usuarios administradores'
    });
    return;
  }
  if (existing.rows.length === 0) {
    res.status(404).json({
      success: false,
      message: 'Usuario no encontrado'
    });
    return;
  }

  // Si cambia email, verificar que no esté duplicado
  if (email) {
    const emailCheck = await query<{ id: number }>('SELECT id FROM users WHERE email = $1 AND id != $2', [email, id]);
    if (emailCheck.rows.length > 0) {
      res.status(400).json({
        success: false,
        message: 'El email ya está en uso por otro usuario'
      });
      return;
    }
  }

  // Construir query dinámico
  const fields: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (nombre !== undefined) { fields.push(`nombre = $${paramIndex++}`); values.push(nombre); }
  if (email !== undefined) { fields.push(`email = $${paramIndex++}`); values.push(email); }
  if (rol !== undefined) { fields.push(`rol = $${paramIndex++}`); values.push(rol); }

  if (fields.length === 0) {
    res.status(400).json({
      success: false,
      message: 'No se proporcionaron campos para actualizar'
    });
    return;
  }

  fields.push(`updated_at = CURRENT_TIMESTAMP`);
  values.push(id);

  const result = await query<UserRow>(
    `UPDATE users SET ${fields.join(', ')} WHERE id = $${paramIndex} RETURNING id, nombre, email, rol, activo, created_at, updated_at`,
    values
  );

  await registrarAudit(req.user!.id, 'editar', 'usuario', parseInt(id), {
    nombre: result.rows[0].nombre,
    campos_modificados: Object.keys(req.body).filter(k => ['nombre', 'email', 'rol'].includes(k))
  });

  res.json({
    success: true,
    message: 'Usuario actualizado exitosamente',
    user: result.rows[0]
  });
}));

// DELETE /:id — Desactivar/activar usuario (toggle)
router.delete('/:id', asyncHandler(async (req: Request<{ id: string }>, res: Response): Promise<void> => {
  const { id } = req.params;

  // No permitir que se desactive a sí mismo
  if (req.user && req.user.id === parseInt(id)) {
    res.status(400).json({
      success: false,
      message: 'No puedes desactivar tu propia cuenta'
    });
    return;
  }

  // Co-admin no puede desactivar admin
  if (req.user?.rol === 'co-admin') {
    const target = await query<{ rol: string }>('SELECT rol FROM users WHERE id = $1', [id]);
    if (target.rows.length > 0 && target.rows[0].rol === 'admin') {
      res.status(403).json({
        success: false,
        message: 'No puedes desactivar usuarios administradores'
      });
      return;
    }
  }

  const result = await query<UserRow>(
    'UPDATE users SET activo = NOT activo, updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING id, nombre, email, rol, activo, created_at, updated_at',
    [id]
  );

  if (result.rows.length === 0) {
    res.status(404).json({
      success: false,
      message: 'Usuario no encontrado'
    });
    return;
  }

  const user = result.rows[0];
  const accion = user.activo ? 'activar' : 'desactivar';
  await registrarAudit(req.user!.id, accion, 'usuario', parseInt(id), { nombre: user.nombre });

  res.json({
    success: true,
    message: user.activo ? 'Usuario activado' : 'Usuario desactivado',
    user
  });
}));

export default router;
