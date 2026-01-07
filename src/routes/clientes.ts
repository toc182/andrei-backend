import { Router, Request, Response } from 'express';
import { param, validationResult } from 'express-validator';
import { query } from '../database/config.js';
import { authenticateToken } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import type { Client } from '../types/models.js';

const router = Router();

interface ClientRow extends Client {}

interface CreateClientBody {
  nombre: string;
  abreviatura?: string;
  contacto?: string;
  telefono?: string;
  email?: string;
  direccion?: string;
  tipo?: 'estado' | 'privado';
}

interface ClientStats {
  total_clientes: string;
  nuevos_mes: string;
  con_email: string;
  con_telefono: string;
  con_abreviatura: string;
}

// Obtener todos los clientes
router.get('/', authenticateToken, asyncHandler(async (_req: Request, res: Response): Promise<void> => {
  const result = await query<ClientRow>(`
    SELECT * FROM clientes
    WHERE activo = true
    ORDER BY nombre ASC
  `);

  res.json({
    success: true,
    data: result.rows
  });
}, {
  tableNotExistsDefault: { clientes: [] }
}));

// Obtener un cliente por ID
router.get('/:id', [
  param('id').isInt().withMessage('ID debe ser un número'),
  authenticateToken
], asyncHandler(async (req: Request<{ id: string }>, res: Response): Promise<void> => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ success: false, message: 'ID inválido', errors: errors.array() });
    return;
  }

  const { id } = req.params;

  const result = await query<ClientRow>(`
    SELECT * FROM clientes
    WHERE id = $1 AND activo = true
  `, [id]);

  if (result.rows.length === 0) {
    res.status(404).json({
      success: false,
      message: 'Cliente no encontrado'
    });
    return;
  }

  res.json({
    success: true,
    data: result.rows[0]
  });
}));

// Crear nuevo cliente
router.post('/', authenticateToken, asyncHandler(async (req: Request<object, object, CreateClientBody>, res: Response): Promise<void> => {
  const { nombre, abreviatura, contacto, telefono, email, direccion, tipo } = req.body;

  // Validar campos requeridos
  if (!nombre) {
    res.status(400).json({
      success: false,
      message: 'El nombre del cliente es requerido'
    });
    return;
  }

  // Validar tipo si se proporciona
  if (tipo && !['estado', 'privado'].includes(tipo)) {
    res.status(400).json({
      success: false,
      message: 'El tipo debe ser "estado" o "privado"'
    });
    return;
  }

  // Verificar si ya existe un cliente con el mismo nombre
  const existingCliente = await query<{ id: number }>(`
    SELECT id FROM clientes
    WHERE nombre = $1 AND activo = true
  `, [nombre]);

  if (existingCliente.rows.length > 0) {
    res.status(400).json({
      success: false,
      message: 'Ya existe un cliente con ese nombre'
    });
    return;
  }

  // Crear el cliente
  const result = await query<ClientRow>(`
    INSERT INTO clientes (nombre, abreviatura, contacto, telefono, email, direccion, tipo)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING *
  `, [nombre, abreviatura || null, contacto || null, telefono || null, email || null, direccion || null, tipo || 'privado']);

  res.status(201).json({
    success: true,
    data: result.rows[0],
    message: 'Cliente creado exitosamente'
  });
}, {
  duplicateMessage: {
    email: 'Ya existe un cliente con ese email',
    abreviatura: 'Ya existe un cliente con esa abreviatura',
    default: 'Ya existe un cliente con esos datos'
  }
}));

// Actualizar cliente
router.put('/:id', authenticateToken, asyncHandler(async (req: Request<{ id: string }, object, CreateClientBody>, res: Response): Promise<void> => {
  const { id } = req.params;
  const { nombre, abreviatura, contacto, telefono, email, direccion } = req.body;

  // Validar campos requeridos
  if (!nombre) {
    res.status(400).json({
      success: false,
      message: 'El nombre del cliente es requerido'
    });
    return;
  }

  // Verificar que el cliente existe
  const existingCliente = await query<{ id: number }>(`
    SELECT id FROM clientes
    WHERE id = $1 AND activo = true
  `, [id]);

  if (existingCliente.rows.length === 0) {
    res.status(404).json({
      success: false,
      message: 'Cliente no encontrado'
    });
    return;
  }

  // Verificar si ya existe otro cliente con el mismo nombre
  const duplicateCliente = await query<{ id: number }>(`
    SELECT id FROM clientes
    WHERE nombre = $1 AND id != $2 AND activo = true
  `, [nombre, id]);

  if (duplicateCliente.rows.length > 0) {
    res.status(400).json({
      success: false,
      message: 'Ya existe otro cliente con ese nombre'
    });
    return;
  }

  // Verificar si ya existe otro cliente con la misma abreviatura (si se proporciona)
  if (abreviatura) {
    const duplicateAbrev = await query<{ id: number }>(`
      SELECT id FROM clientes
      WHERE abreviatura = $1 AND id != $2 AND activo = true
    `, [abreviatura, id]);

    if (duplicateAbrev.rows.length > 0) {
      res.status(400).json({
        success: false,
        message: 'Ya existe otro cliente con esa abreviatura'
      });
      return;
    }
  }

  // Actualizar el cliente
  const result = await query<ClientRow>(`
    UPDATE clientes
    SET nombre = $1, abreviatura = $2, contacto = $3, telefono = $4, email = $5, direccion = $6, updated_at = CURRENT_TIMESTAMP
    WHERE id = $7
    RETURNING *
  `, [nombre, abreviatura || null, contacto || null, telefono || null, email || null, direccion || null, id]);

  res.json({
    success: true,
    data: result.rows[0],
    message: 'Cliente actualizado exitosamente'
  });
}, {
  duplicateMessage: {
    email: 'Ya existe otro cliente con ese email',
    abreviatura: 'Ya existe otro cliente con esa abreviatura',
    default: 'Ya existe otro cliente con esos datos'
  }
}));

// Eliminar cliente (soft delete)
router.delete('/:id', authenticateToken, asyncHandler(async (req: Request<{ id: string }>, res: Response): Promise<void> => {
  const { id } = req.params;

  // Verificar que el cliente existe
  const existingCliente = await query<{ id: number }>(`
    SELECT id FROM clientes
    WHERE id = $1 AND activo = true
  `, [id]);

  if (existingCliente.rows.length === 0) {
    res.status(404).json({
      success: false,
      message: 'Cliente no encontrado'
    });
    return;
  }

  // Verificar si el cliente tiene proyectos asociados
  const projectsCheck = await query<{ id: number }>(`
    SELECT id FROM proyectos
    WHERE cliente_id = $1
  `, [id]);

  if (projectsCheck.rows.length > 0) {
    res.status(400).json({
      success: false,
      message: 'No se puede eliminar el cliente porque tiene proyectos asociados'
    });
    return;
  }

  // Verificar si el cliente tiene asignaciones de equipos
  const asignacionesCheck = await query<{ id: number }>(`
    SELECT id FROM asignaciones_equipos
    WHERE cliente_id = $1
  `, [id]);

  if (asignacionesCheck.rows.length > 0) {
    res.status(400).json({
      success: false,
      message: 'No se puede eliminar el cliente porque tiene asignaciones de equipos'
    });
    return;
  }

  // Soft delete del cliente
  await query(`
    UPDATE clientes
    SET activo = false, updated_at = CURRENT_TIMESTAMP
    WHERE id = $1
  `, [id]);

  res.json({
    success: true,
    message: 'Cliente eliminado exitosamente'
  });
}));

// Obtener estadísticas de clientes
router.get('/stats/dashboard', authenticateToken, asyncHandler(async (_req: Request, res: Response): Promise<void> => {
  const stats = await query<ClientStats>(`
    SELECT
      COUNT(*) as total_clientes,
      COUNT(CASE WHEN created_at >= CURRENT_DATE - INTERVAL '30 days' THEN 1 END) as nuevos_mes,
      COUNT(CASE WHEN email IS NOT NULL AND email != '' THEN 1 END) as con_email,
      COUNT(CASE WHEN telefono IS NOT NULL AND telefono != '' THEN 1 END) as con_telefono,
      COUNT(CASE WHEN abreviatura IS NOT NULL AND abreviatura != '' THEN 1 END) as con_abreviatura
    FROM clientes
    WHERE activo = true
  `);

  res.json({
    success: true,
    data: stats.rows[0]
  });
}));

export default router;
