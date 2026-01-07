/**
 * asyncHandler - Middleware para manejar errores en endpoints async
 * Creado como parte de la auditoría de código (2026-01-05)
 *
 * Elimina la necesidad de try-catch repetido en cada endpoint.
 * Maneja casos comunes de errores de PostgreSQL.
 */

import { Request, Response, NextFunction } from 'express';

// Tipo para errores de base de datos PostgreSQL
interface DatabaseError extends Error {
  code?: string;
  detail?: string;
  constraint?: string;
}

// Opciones configurables para el handler
interface AsyncHandlerOptions {
  // Mensaje cuando hay duplicado (código 23505)
  duplicateMessage?: string | Record<string, string>;

  // Valor por defecto si la tabla no existe
  tableNotExistsDefault?: Record<string, unknown>;

  // Mensaje personalizado para foreign key violation (código 23503)
  foreignKeyMessage?: string;
}

// Tipo para la función async del endpoint
// Usamos 'any' para los parámetros de Request para compatibilidad con tipos específicos
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AsyncFunction = (
  req: Request<any, any, any, any>,
  res: Response,
  next: NextFunction
) => Promise<void>;

/**
 * Obtiene el mensaje de duplicado correcto basado en el detalle del error
 */
const getDuplicateMessage = (
  detail: string | undefined,
  messages: Record<string, string>
): string => {
  if (!detail) return messages.default || 'Ya existe un registro con esos datos';

  // Buscar qué campo causó el duplicado
  for (const [field, message] of Object.entries(messages)) {
    if (field !== 'default' && detail.toLowerCase().includes(field.toLowerCase())) {
      return message;
    }
  }

  return messages.default || 'Ya existe un registro con esos datos';
};

/**
 * Wrapper para endpoints async que maneja errores automáticamente
 *
 * @param fn - Función async del endpoint
 * @param options - Opciones para manejar casos específicos
 * @returns Middleware de Express
 *
 * @example
 * // Uso simple
 * router.get('/items', asyncHandler(async (req, res) => {
 *   const items = await getItems();
 *   res.json({ success: true, items });
 * }));
 *
 * @example
 * // Con mensaje de duplicado
 * router.post('/projects', asyncHandler(async (req, res) => {
 *   await createProject(req.body);
 *   res.json({ success: true });
 * }, {
 *   duplicateMessage: 'El código de proyecto ya existe'
 * }));
 *
 * @example
 * // Con múltiples mensajes de duplicado
 * router.post('/clientes', asyncHandler(async (req, res) => {
 *   await createCliente(req.body);
 *   res.json({ success: true });
 * }, {
 *   duplicateMessage: {
 *     email: 'Ya existe un cliente con ese email',
 *     default: 'Ya existe un cliente con esos datos'
 *   }
 * }));
 *
 * @example
 * // Con valor por defecto si tabla no existe
 * router.get('/clientes', asyncHandler(async (req, res) => {
 *   const clientes = await getClientes();
 *   res.json({ success: true, clientes });
 * }, {
 *   tableNotExistsDefault: { clientes: [], total: 0 }
 * }));
 */
export const asyncHandler = (
  fn: AsyncFunction,
  options?: AsyncHandlerOptions
) => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await fn(req, res, next);
    } catch (error) {
      const dbError = error as DatabaseError;

      // Código 23505 - Unique violation (duplicado)
      if (dbError.code === '23505' && options?.duplicateMessage) {
        const message = typeof options.duplicateMessage === 'string'
          ? options.duplicateMessage
          : getDuplicateMessage(dbError.detail, options.duplicateMessage);

        res.status(400).json({
          success: false,
          message
        });
        return;
      }

      // Código 23503 - Foreign key violation
      if (dbError.code === '23503' && options?.foreignKeyMessage) {
        res.status(400).json({
          success: false,
          message: options.foreignKeyMessage
        });
        return;
      }

      // Tabla no existe - retornar valor por defecto
      if (
        dbError.message?.includes('does not exist') &&
        options?.tableNotExistsDefault !== undefined
      ) {
        res.json({
          success: true,
          ...options.tableNotExistsDefault
        });
        return;
      }

      // Error genérico
      console.error('Error en endpoint:', error);
      res.status(500).json({
        success: false,
        message: 'Error interno del servidor'
      });
    }
  };
};

export default asyncHandler;
