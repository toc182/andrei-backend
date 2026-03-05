import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { body, validationResult } from 'express-validator';
import rateLimit from 'express-rate-limit';
import { query } from '../database/config.js';
import { authenticateToken } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { registrarAudit } from '../services/auditLog.js';
import type { UserRole, JWTPayload, UserPermissions } from '../types/auth.js';

const router = Router();

interface UserRow {
  id: number;
  nombre: string;
  email: string;
  password: string;
  rol: UserRole;
  debe_cambiar_password: boolean;
}

interface RegisterBody {
  nombre: string;
  email: string;
  password: string;
  rol?: UserRole;
}

interface LoginBody {
  email: string;
  password: string;
}

// Rate limiting para protección contra fuerza bruta
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 5, // límite de 5 intentos por IP
  message: {
    success: false,
    message: 'Demasiados intentos de inicio de sesión. Por favor intenta de nuevo en 15 minutos.'
  },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true
});

// Registro de usuario
router.post('/register', authLimiter, [
  body('nombre').trim().isLength({ min: 2 }).withMessage('Nombre debe tener al menos 2 caracteres'),
  body('email').isEmail().withMessage('Email inválido'),
  body('password').isLength({ min: 6 }).withMessage('Password debe tener al menos 6 caracteres'),
  body('rol').optional().isIn(['admin', 'co-admin', 'usuario']).withMessage('Rol inválido')
], asyncHandler(async (req: Request<object, object, RegisterBody>, res: Response): Promise<void> => {
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

  // Verificar si el email ya existe
  const existingUser = await query<{ id: number }>('SELECT id FROM users WHERE email = $1', [email]);
  if (existingUser.rows.length > 0) {
    res.status(400).json({
      success: false,
      message: 'El email ya está registrado'
    });
    return;
  }

  // Encriptar password
  const saltRounds = 10;
  const hashedPassword = await bcrypt.hash(password, saltRounds);

  // Crear usuario
  const result = await query<Omit<UserRow, 'password'>>(
    'INSERT INTO users (nombre, email, password, rol) VALUES ($1, $2, $3, $4) RETURNING id, nombre, email, rol',
    [nombre, email, hashedPassword, rol]
  );

  const newUser = result.rows[0];

  res.status(201).json({
    success: true,
    message: 'Usuario registrado exitosamente',
    user: newUser
  });
}));

// Login
router.post('/login', authLimiter, [
  body('email').isEmail().withMessage('Email inválido'),
  body('password').notEmpty().withMessage('Password requerido')
], asyncHandler(async (req: Request<object, object, LoginBody>, res: Response): Promise<void> => {
  console.log('🔐 Login attempt received');

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    console.log('❌ Validation errors:', errors.array());
    res.status(400).json({
      success: false,
      message: 'Datos inválidos',
      errors: errors.array()
    });
    return;
  }

  const { email, password } = req.body;

  // Buscar usuario
  console.log('🔍 Looking for user...');
  const result = await query<UserRow>(
    'SELECT id, nombre, email, password, rol, debe_cambiar_password FROM users WHERE email = $1',
    [email]
  );

  console.log('👥 Users found:', result.rows.length);

  if (result.rows.length === 0) {
    console.log('❌ User not found');
    res.status(401).json({
      success: false,
      message: 'Credenciales inválidas'
    });
    return;
  }

  const user = result.rows[0];

  // Verificar password
  const isValidPassword = await bcrypt.compare(password, user.password);
  if (!isValidPassword) {
    res.status(401).json({
      success: false,
      message: 'Credenciales inválidas'
    });
    return;
  }

  // Generar token JWT
  const payload: JWTPayload = {
    userId: user.id,
    email: user.email,
    rol: user.rol
  };

  const token = jwt.sign(payload, process.env.JWT_SECRET!, { expiresIn: '24h' });

  // Remover password del objeto de respuesta
  const { password: _, ...userWithoutPassword } = user;

  // Si es usuario, incluir permisos
  let permissions: UserPermissions | undefined;
  if (user.rol === 'usuario') {
    const permsResult = await query<UserPermissions>(
      `SELECT acceso_global, proyectos_crear, proyectos_editar, proyectos_eliminar,
              clientes_agregar, clientes_editar, clientes_eliminar,
              solicitudes_editar_todas, requisiciones_editar_todas,
              equipos_ver, equipos_agregar, equipos_editar, equipos_eliminar,
              equipos_asignacion, equipos_uso, equipos_editar_asignacion,
              documentos_acceso, oportunidades_ver, registrar_pago
       FROM user_permissions WHERE user_id = $1`,
      [user.id]
    );
    if (permsResult.rows.length > 0) {
      permissions = permsResult.rows[0];
    }
  }

  res.json({
    success: true,
    message: 'Login exitoso',
    token,
    user: { ...userWithoutPassword, permissions, debe_cambiar_password: user.debe_cambiar_password }
  });
}));

// Obtener perfil del usuario actual
router.get('/profile', authenticateToken, asyncHandler(async (req: Request, res: Response): Promise<void> => {
  res.json({
    success: true,
    user: req.user
  });
}));

// Cambiar contraseña
router.post('/change-password', authenticateToken, asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { password_actual, password_nueva } = req.body;
  const userId = req.user!.id;

  if (!password_nueva || password_nueva.length < 6) {
    res.status(400).json({
      success: false,
      message: 'La nueva contraseña debe tener al menos 6 caracteres'
    });
    return;
  }

  // Si debe_cambiar_password es true, no exigir password actual
  if (!req.user!.debe_cambiar_password) {
    if (!password_actual) {
      res.status(400).json({
        success: false,
        message: 'Contraseña actual requerida'
      });
      return;
    }

    const userResult = await query<{ password: string }>(
      'SELECT password FROM users WHERE id = $1',
      [userId]
    );

    const isValid = await bcrypt.compare(password_actual, userResult.rows[0].password);
    if (!isValid) {
      res.status(401).json({
        success: false,
        message: 'Contraseña actual incorrecta'
      });
      return;
    }
  }

  const hashedPassword = await bcrypt.hash(password_nueva, 10);
  await query(
    'UPDATE users SET password = $1, debe_cambiar_password = false, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
    [hashedPassword, userId]
  );

  await registrarAudit(userId, 'cambiar_password', 'user', userId, {});

  res.json({
    success: true,
    message: 'Contraseña actualizada exitosamente'
  });
}));

// Verificar token
router.get('/verify', authenticateToken, (req: Request, res: Response): void => {
  res.json({
    success: true,
    message: 'Token válido',
    user: req.user
  });
});

export default router;
