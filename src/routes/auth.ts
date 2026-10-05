import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { body, validationResult } from 'express-validator';
import rateLimit from 'express-rate-limit';
import { query } from '../database/config.js';
import { authenticateToken, loadUserPermissions } from '../middleware/auth.js';
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
  tipo_usuario: string;
  debe_cambiar_password: boolean;
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
    message:
      'Demasiados intentos de inicio de sesión. Por favor intenta de nuevo en 15 minutos.',
  },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
});

// No hay registro publico: las cuentas se crean solo desde Administracion
// (POST /api/users, admin o co-admin). Hubo un /register abierto que dejaba
// a cualquiera crearse una cuenta de admin; se quito el 2026-10-05.

// Login
router.post(
  '/login',
  authLimiter,
  [
    body('email').isEmail().withMessage('Email inválido'),
    body('password').notEmpty().withMessage('Password requerido'),
  ],
  asyncHandler(
    async (
      req: Request<object, object, LoginBody>,
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

      const { email, password } = req.body;

      const result = await query<UserRow>(
        'SELECT id, nombre, email, password, rol, tipo_usuario, debe_cambiar_password FROM users WHERE email = $1',
        [email],
      );

      if (result.rows.length === 0) {
        res.status(401).json({
          success: false,
          message: 'Credenciales inválidas',
        });
        return;
      }

      const user = result.rows[0];

      // Bloquear login de usuarios externos
      if (user.tipo_usuario === 'externo') {
        res.status(403).json({
          success: false,
          message: 'Los usuarios externos no pueden iniciar sesión',
        });
        return;
      }

      // Verificar password
      const isValidPassword = await bcrypt.compare(password, user.password);
      if (!isValidPassword) {
        res.status(401).json({
          success: false,
          message: 'Credenciales inválidas',
        });
        return;
      }

      // Generar token JWT
      const payload: JWTPayload = {
        userId: user.id,
        email: user.email,
        rol: user.rol,
      };

      const token = jwt.sign(payload, process.env.JWT_SECRET!, {
        expiresIn: '7d',
      });

      // Remover password del objeto de respuesta
      const { password: _, ...userWithoutPassword } = user;

      // Si es usuario, incluir permisos (misma forma que en authenticateToken)
      const permissions: UserPermissions | undefined =
        user.rol === 'usuario' ? await loadUserPermissions(user.id) : undefined;

      res.json({
        success: true,
        message: 'Login exitoso',
        token,
        user: {
          ...userWithoutPassword,
          permissions,
          debe_cambiar_password: user.debe_cambiar_password,
        },
      });
    },
  ),
);

// Obtener perfil del usuario actual
router.get(
  '/profile',
  authenticateToken,
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    res.json({
      success: true,
      user: req.user,
    });
  }),
);

// Cambiar contraseña
router.post(
  '/change-password',
  authenticateToken,
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const { password_actual, password_nueva } = req.body;
    const userId = req.user!.id;

    if (!password_nueva || password_nueva.length < 6) {
      res.status(400).json({
        success: false,
        message: 'La nueva contraseña debe tener al menos 6 caracteres',
      });
      return;
    }

    // Si debe_cambiar_password es true, no exigir password actual
    if (!req.user!.debe_cambiar_password) {
      if (!password_actual) {
        res.status(400).json({
          success: false,
          message: 'Contraseña actual requerida',
        });
        return;
      }

      const userResult = await query<{ password: string }>(
        'SELECT password FROM users WHERE id = $1',
        [userId],
      );

      const isValid = await bcrypt.compare(
        password_actual,
        userResult.rows[0].password,
      );
      if (!isValid) {
        res.status(401).json({
          success: false,
          message: 'Contraseña actual incorrecta',
        });
        return;
      }
    }

    const hashedPassword = await bcrypt.hash(password_nueva, 10);
    await query(
      'UPDATE users SET password = $1, debe_cambiar_password = false, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [hashedPassword, userId],
    );

    await registrarAudit(userId, 'cambiar_password', 'user', userId, {});

    res.json({
      success: true,
      message: 'Contraseña actualizada exitosamente',
    });
  }),
);

// Verificar token
router.get(
  '/verify',
  authenticateToken,
  (req: Request, res: Response): void => {
    res.json({
      success: true,
      message: 'Token válido',
      user: req.user,
    });
  },
);

export default router;
