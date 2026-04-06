import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { query } from '../database/config.js';
import type {
  AuthUser,
  UserRole,
  JWTPayload,
  UserPermissions,
} from '../types/auth.js';

interface UserRow {
  id: number;
  nombre: string;
  email: string;
  rol: UserRole;
  debe_cambiar_password: boolean;
}

// Whitelist de permisos válidos para evitar SQL injection
const VALID_PERMISSIONS: (keyof UserPermissions)[] = [
  'acceso_global',
  'proyectos_crear',
  'proyectos_editar',
  'proyectos_eliminar',
  'clientes_agregar',
  'clientes_editar',
  'clientes_eliminar',
  'solicitudes_editar_todas',
  'requisiciones_editar_todas',
  'equipos_ver',
  'equipos_agregar',
  'equipos_editar',
  'equipos_eliminar',
  'equipos_asignacion',
  'equipos_uso',
  'equipos_editar_asignacion',
  'documentos_acceso',
  'oportunidades_ver',
  'registrar_pago',
  'caja_menuda',
];

/**
 * Middleware para verificar token JWT
 */
export async function authenticateToken(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

    if (!token) {
      res.status(401).json({
        success: false,
        message: 'Token de acceso requerido',
      });
      return;
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET!, {
      algorithms: ['HS256'],
    }) as JWTPayload;

    // Verificar que el usuario existe y está activo
    const result = await query<UserRow>(
      'SELECT id, nombre, email, rol, debe_cambiar_password FROM users WHERE id = $1 AND activo = true',
      [decoded.userId],
    );

    if (result.rows.length === 0) {
      res.status(401).json({
        success: false,
        message: 'Usuario no válido',
      });
      return;
    }

    const user = result.rows[0] as AuthUser;

    // Si es usuario, cargar permisos
    if (user.rol === 'usuario') {
      const permsResult = await query<UserPermissions>(
        `SELECT acceso_global, proyectos_crear, proyectos_editar, proyectos_eliminar,
                clientes_agregar, clientes_editar, clientes_eliminar,
                solicitudes_editar_todas, requisiciones_editar_todas,
                equipos_ver, equipos_agregar, equipos_editar, equipos_eliminar,
                equipos_asignacion, equipos_uso, equipos_editar_asignacion,
                documentos_acceso, oportunidades_ver, registrar_pago, caja_menuda
         FROM user_permissions WHERE user_id = $1`,
        [user.id],
      );
      if (permsResult.rows.length > 0) {
        user.permissions = permsResult.rows[0];
      }
    }

    req.user = user;
    next();
  } catch (error) {
    const jwtError = error as { name?: string };

    if (jwtError.name === 'TokenExpiredError') {
      res.status(401).json({
        success: false,
        message: 'Token expirado',
      });
      return;
    }

    res.status(401).json({
      success: false,
      message: 'Token inválido',
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
        message: 'No tienes permisos para esta acción',
      });
      return;
    }
    next();
  };
}

/**
 * Middleware para verificar si es admin o co-admin
 */
export const requireAdmin = requireRole(['admin', 'co-admin']);

/**
 * Middleware para verificar si es admin, co-admin o usuario (todos autenticados)
 */
export const requireManager = requireRole(['admin', 'co-admin', 'usuario']);

/**
 * Middleware para verificar un permiso específico.
 * admin/co-admin pasan siempre; usuario verifica su permiso.
 */
export function checkPermission(permiso: keyof UserPermissions) {
  if (!VALID_PERMISSIONS.includes(permiso)) {
    throw new Error(`Permiso inválido: ${permiso}`);
  }
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ success: false, message: 'No autenticado' });
      return;
    }
    // admin y co-admin pasan siempre
    if (req.user.rol === 'admin' || req.user.rol === 'co-admin') {
      next();
      return;
    }
    // usuario verifica permiso
    if (req.user.permissions?.[permiso]) {
      next();
      return;
    }
    res.status(403).json({
      success: false,
      message: 'No tienes permisos para esta acción',
    });
  };
}

/**
 * Middleware para verificar acceso a un proyecto.
 * admin/co-admin pasan; usuario con acceso_global pasa; sino verifica user_project_access.
 */
export function checkProjectAccess(paramName: string = 'id') {
  return async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    if (!req.user) {
      res.status(401).json({ success: false, message: 'No autenticado' });
      return;
    }
    // admin y co-admin pasan siempre
    if (req.user.rol === 'admin' || req.user.rol === 'co-admin') {
      next();
      return;
    }
    // usuario con acceso_global pasa
    if (req.user.permissions?.acceso_global) {
      next();
      return;
    }
    // verificar acceso al proyecto específico
    const projectId = parseInt(req.params[paramName], 10);
    if (isNaN(projectId)) {
      res
        .status(400)
        .json({ success: false, message: 'ID de proyecto inválido' });
      return;
    }
    try {
      const result = await query(
        'SELECT 1 FROM user_project_access WHERE user_id = $1 AND proyecto_id = $2',
        [req.user.id, projectId],
      );
      if (result.rows.length > 0) {
        next();
        return;
      }
      res.status(403).json({
        success: false,
        message: 'No tienes acceso a este proyecto',
      });
    } catch {
      res
        .status(500)
        .json({ success: false, message: 'Error verificando acceso' });
    }
  };
}
