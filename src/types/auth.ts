import { Request, Response, NextFunction } from 'express';

/**
 * Roles disponibles en el sistema
 */
export type UserRole = 'admin' | 'co-admin' | 'usuario';
export type UserType = 'interno' | 'externo';

/**
 * Permisos individuales del usuario
 */
export interface UserPermissions {
  acceso_global: boolean;
  proyectos_crear: boolean;
  proyectos_editar: boolean;
  proyectos_eliminar: boolean;
  clientes_agregar: boolean;
  clientes_editar: boolean;
  clientes_eliminar: boolean;
  solicitudes_editar_todas: boolean;
  requisiciones_editar_todas: boolean;
  equipos_ver: boolean;
  equipos_agregar: boolean;
  equipos_editar: boolean;
  equipos_eliminar: boolean;
  equipos_asignacion: boolean;
  equipos_uso: boolean;
  equipos_editar_asignacion: boolean;
  documentos_acceso: boolean;
  oportunidades_ver: boolean;
  registrar_pago: boolean;
  caja_menuda: boolean;
  cuentas: boolean;
  cotizaciones: boolean;
  cronogramas_ver: boolean;
  desglose_ver: boolean;
}

/**
 * Usuario autenticado (inyectado en req.user)
 */
export interface AuthUser {
  id: number;
  nombre: string;
  email: string;
  rol: UserRole;
  tipo_usuario?: UserType;
  permissions?: UserPermissions;
  debe_cambiar_password?: boolean;
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
  next: NextFunction,
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
