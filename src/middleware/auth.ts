import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { query } from '../database/config.js';
import type { AuthUser, UserRole, JWTPayload } from '../types/auth.js';

interface UserRow {
  id: number;
  nombre: string;
  email: string;
  rol: UserRole;
}

/**
 * Middleware para verificar token JWT
 */
export async function authenticateToken(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

    if (!token) {
      res.status(401).json({
        success: false,
        message: 'Token de acceso requerido'
      });
      return;
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET!, { algorithms: ['HS256'] }) as JWTPayload;

    // Verificar que el usuario existe y está activo
    const result = await query<UserRow>(
      'SELECT id, nombre, email, rol FROM users WHERE id = $1 AND activo = true',
      [decoded.userId]
    );

    if (result.rows.length === 0) {
      res.status(401).json({
        success: false,
        message: 'Usuario no válido'
      });
      return;
    }

    req.user = result.rows[0] as AuthUser;
    next();
  } catch (error) {
    const jwtError = error as { name?: string };

    if (jwtError.name === 'TokenExpiredError') {
      res.status(401).json({
        success: false,
        message: 'Token expirado'
      });
      return;
    }

    res.status(403).json({
      success: false,
      message: 'Token inválido'
    });
  }
}

/**
 * Factory de middleware para verificar roles
 */
export function requireRole(allowedRoles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user || !allowedRoles.includes(req.user.rol)) {
      res.status(403).json({
        success: false,
        message: 'No tienes permisos para esta acción'
      });
      return;
    }
    next();
  };
}

/**
 * Middleware para verificar si es admin
 */
export const requireAdmin = requireRole(['admin']);

/**
 * Middleware para verificar si es admin o usuario (ambos pueden gestionar)
 */
export const requireManager = requireRole(['admin', 'usuario']);

