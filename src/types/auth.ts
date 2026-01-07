import { Request, Response, NextFunction } from 'express';

/**
 * Roles disponibles en el sistema
 */
export type UserRole = 'admin' | 'project_manager' | 'supervisor' | 'operario';

/**
 * Usuario autenticado (inyectado en req.user)
 */
export interface AuthUser {
  id: number;
  nombre: string;
  email: string;
  rol: UserRole;
}

/**
 * Payload del token JWT
 */
export interface JWTPayload {
  userId: number;
  email: string;
  rol: UserRole;
  iat?: number;
  exp?: number;
}

/**
 * Request con usuario autenticado
 */
export interface AuthenticatedRequest extends Request {
  user: AuthUser;
}

/**
 * Tipo para middleware de Express
 */
export type ExpressMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction
) => void | Promise<void>;

/**
 * Tipo para middleware de roles
 */
export type RoleMiddleware = (allowedRoles: UserRole[]) => ExpressMiddleware;

// Extender Express Request para incluir user
declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}
