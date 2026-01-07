import { Router, Request, Response } from 'express';
import { body, validationResult, param } from 'express-validator';
import { query } from '../database/config.js';
import { authenticateToken, requireManager } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

const router = Router();

type AdendaTipo = 'tiempo' | 'costo' | 'mixta';
type AdendaEstado = 'en_proceso' | 'aprobada' | 'rechazada';

interface AdendaRow {
  id: number;
  proyecto_id: number;
  numero_adenda: number;
  tipo: AdendaTipo;
  estado: AdendaEstado;
  nueva_fecha_fin?: Date;
  dias_extension?: number;
  nuevo_monto?: number;
  monto_adicional?: number;
  justificacion: string;
  fecha_solicitud: Date;
  fecha_aprobacion?: Date;
  observaciones?: string;
  proyecto_nombre?: string;
  created_at: Date;
  updated_at: Date;
}

interface CreateAdendaBody {
  proyecto_id: number;
  tipo: AdendaTipo;
  nueva_fecha_fin?: string;
  dias_extension?: number;
  nuevo_monto?: number;
  monto_adicional?: number;
  justificacion: string;
  fecha_solicitud?: string;
  observaciones?: string;
  estado?: AdendaEstado;
}

interface UpdateAdendaBody {
  tipo?: AdendaTipo;
  estado?: AdendaEstado;
  nueva_fecha_fin?: string;
  dias_extension?: number;
  nuevo_monto?: number;
  monto_adicional?: number;
  justificacion?: string;
  fecha_aprobacion?: string;
  observaciones?: string;
}

interface AdendaSummary {
  total_adendas: string;
  adendas_aprobadas: string;
  dias_extension_total: string;
  monto_adicional_total: string;
  fecha_fin_actual?: Date;
}

// Obtener adendas de un proyecto
router.get('/project/:projectId', authenticateToken, asyncHandler(async (req: Request<{ projectId: string }>, res: Response): Promise<void> => {
  const { projectId } = req.params;

  const result = await query<AdendaRow>(`
    SELECT
      a.*,
      p.nombre as proyecto_nombre
    FROM adendas a
    JOIN proyectos p ON a.proyecto_id = p.id
    WHERE a.proyecto_id = $1
    ORDER BY a.numero_adenda ASC
  `, [projectId]);

  res.json({
    success: true,
    adendas: result.rows
  });
}));

// Crear nueva adenda
router.post('/', [
  body('proyecto_id').isInt().withMessage('ID de proyecto debe ser un número'),
  body('tipo').isIn(['tiempo', 'costo', 'mixta']).withMessage('Tipo debe ser tiempo, costo o mixta'),
  authenticateToken,
  requireManager
], asyncHandler(async (req: Request<object, object, CreateAdendaBody>, res: Response): Promise<void> => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({
      success: false,
      message: 'Datos inválidos',
      errors: errors.array()
    });
    return;
  }

  const {
    proyecto_id,
    tipo,
    nueva_fecha_fin,
    dias_extension,
    nuevo_monto,
    monto_adicional,
    justificacion,
    fecha_solicitud,
    observaciones,
    estado = 'en_proceso'
  } = req.body;

  // Verificar que el proyecto existe
  const projectCheck = await query<{ id: number }>('SELECT id FROM proyectos WHERE id = $1', [proyecto_id]);
  if (projectCheck.rows.length === 0) {
    res.status(404).json({
      success: false,
      message: 'Proyecto no encontrado'
    });
    return;
  }

  // Obtener el siguiente número de adenda
  const nextNumberResult = await query<{ next_number: number }>(`
    SELECT COALESCE(MAX(numero_adenda), 0) + 1 as next_number
    FROM adendas
    WHERE proyecto_id = $1
  `, [proyecto_id]);

  const numero_adenda = nextNumberResult.rows[0].next_number;

  // Validar campos según el tipo
  if ((tipo === 'tiempo' || tipo === 'mixta') && !nueva_fecha_fin) {
    res.status(400).json({
      success: false,
      message: 'Nueva fecha de fin es requerida para adendas de tiempo'
    });
    return;
  }

  if ((tipo === 'costo' || tipo === 'mixta') && !nuevo_monto && !monto_adicional) {
    res.status(400).json({
      success: false,
      message: 'Nuevo monto o monto adicional es requerido para adendas de costo'
    });
    return;
  }

  // Crear la adenda
  const result = await query<AdendaRow>(`
    INSERT INTO adendas (
      proyecto_id, numero_adenda, tipo, estado,
      nueva_fecha_fin, dias_extension,
      nuevo_monto, monto_adicional,
      justificacion, fecha_solicitud, observaciones
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    RETURNING *
  `, [
    proyecto_id,
    numero_adenda,
    tipo,
    estado,
    nueva_fecha_fin || null,
    dias_extension || null,
    nuevo_monto || null,
    monto_adicional || null,
    justificacion,
    fecha_solicitud || new Date().toISOString().split('T')[0],
    observaciones || null
  ]);

  res.status(201).json({
    success: true,
    adenda: result.rows[0],
    message: 'Adenda creada exitosamente'
  });
}));

// Actualizar adenda
router.put('/:id', [
  param('id').isInt().withMessage('ID debe ser un número'),
  body('tipo').optional().isIn(['tiempo', 'costo', 'mixta']).withMessage('Tipo debe ser tiempo, costo o mixta'),
  body('estado').optional().isIn(['en_proceso', 'aprobada', 'rechazada']).withMessage('Estado inválido'),
  authenticateToken,
  requireManager
], asyncHandler(async (req: Request<{ id: string }, object, UpdateAdendaBody>, res: Response): Promise<void> => {
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
  const {
    tipo,
    estado,
    nueva_fecha_fin,
    dias_extension,
    nuevo_monto,
    monto_adicional,
    justificacion,
    fecha_aprobacion,
    observaciones
  } = req.body;

  // Verificar que la adenda existe
  const existingAdenda = await query<AdendaRow>('SELECT * FROM adendas WHERE id = $1', [id]);
  if (existingAdenda.rows.length === 0) {
    res.status(404).json({
      success: false,
      message: 'Adenda no encontrada'
    });
    return;
  }

  // Si se cambia a aprobada, agregar fecha de aprobación
  const fechaAprobacionFinal = estado === 'aprobada' && !existingAdenda.rows[0].fecha_aprobacion
    ? fecha_aprobacion || new Date().toISOString().split('T')[0]
    : fecha_aprobacion;

  // Actualizar la adenda
  const result = await query<AdendaRow>(`
    UPDATE adendas SET
      tipo = COALESCE($2, tipo),
      estado = COALESCE($3, estado),
      nueva_fecha_fin = COALESCE($4, nueva_fecha_fin),
      dias_extension = COALESCE($5, dias_extension),
      nuevo_monto = COALESCE($6, nuevo_monto),
      monto_adicional = COALESCE($7, monto_adicional),
      justificacion = COALESCE($8, justificacion),
      fecha_aprobacion = COALESCE($9, fecha_aprobacion),
      observaciones = COALESCE($10, observaciones),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = $1
    RETURNING *
  `, [
    id,
    tipo || null,
    estado || null,
    nueva_fecha_fin || null,
    dias_extension || null,
    nuevo_monto || null,
    monto_adicional || null,
    justificacion || null,
    fechaAprobacionFinal || null,
    observaciones || null
  ]);

  res.json({
    success: true,
    adenda: result.rows[0],
    message: 'Adenda actualizada exitosamente'
  });
}));

// Eliminar adenda
router.delete('/:id', [
  param('id').isInt().withMessage('ID debe ser un número'),
  authenticateToken,
  requireManager
], asyncHandler(async (req: Request<{ id: string }>, res: Response): Promise<void> => {
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

  // Verificar que la adenda existe
  const existingAdenda = await query<AdendaRow>('SELECT * FROM adendas WHERE id = $1', [id]);
  if (existingAdenda.rows.length === 0) {
    res.status(404).json({
      success: false,
      message: 'Adenda no encontrada'
    });
    return;
  }

  // Eliminar la adenda
  await query('DELETE FROM adendas WHERE id = $1', [id]);

  res.json({
    success: true,
    message: 'Adenda eliminada exitosamente'
  });
}));

// Obtener resumen de adendas aprobadas de un proyecto
router.get('/project/:projectId/summary', authenticateToken, asyncHandler(async (req: Request<{ projectId: string }>, res: Response): Promise<void> => {
  const { projectId } = req.params;

  const result = await query<AdendaSummary>(`
    SELECT
      COUNT(*) as total_adendas,
      SUM(CASE WHEN estado = 'aprobada' THEN 1 ELSE 0 END) as adendas_aprobadas,
      SUM(CASE WHEN tipo IN ('tiempo', 'mixta') AND estado = 'aprobada' THEN dias_extension ELSE 0 END) as dias_extension_total,
      SUM(CASE WHEN tipo IN ('costo', 'mixta') AND estado = 'aprobada' THEN COALESCE(monto_adicional, 0) ELSE 0 END) as monto_adicional_total,
      MAX(CASE WHEN tipo IN ('tiempo', 'mixta') AND estado = 'aprobada' THEN nueva_fecha_fin ELSE NULL END) as fecha_fin_actual
    FROM adendas
    WHERE proyecto_id = $1
  `, [projectId]);

  res.json({
    success: true,
    summary: result.rows[0]
  });
}));

export default router;
