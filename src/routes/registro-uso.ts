import { Router, Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import { query } from '../database/config.js';
import { authenticateToken, checkPermission } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

const router = Router();

interface RegistroUsoRow {
  id: number;
  asignacion_id: number;
  fecha_inicio: Date;
  fecha_fin: Date;
  cantidad: number;
  observaciones?: string;
  created_at: Date;
}

interface CreateRegistroBody {
  asignacion_id: number;
  fecha_inicio: string;
  fecha_fin: string;
  cantidad: number;
  observaciones?: string;
}

// Crear nuevo registro de uso
router.post('/', [
  body('asignacion_id').isInt().withMessage('ID de asignación requerido'),
  body('fecha_inicio').isISO8601().withMessage('Fecha de inicio requerida'),
  body('fecha_fin').isISO8601().withMessage('Fecha de fin requerida'),
  body('cantidad').isNumeric().withMessage('Cantidad debe ser numérica')
], authenticateToken, checkPermission('equipos_uso'), asyncHandler(async (req: Request<object, object, CreateRegistroBody>, res: Response): Promise<void> => {
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
    asignacion_id,
    fecha_inicio,
    fecha_fin,
    cantidad,
    observaciones
  } = req.body;

  // Si fecha_inicio == fecha_fin (tipo hora), verificar si ya existe un registro para esa fecha
  let result;
  if (fecha_inicio === fecha_fin) {
    const existingRecord = await query<{ id: number }>(`
      SELECT id FROM registro_uso_equipos
      WHERE asignacion_id = $1 AND fecha_inicio = $2
    `, [asignacion_id, fecha_inicio]);

    if (existingRecord.rows.length > 0) {
      // Actualizar registro existente
      result = await query<RegistroUsoRow>(`
        UPDATE registro_uso_equipos
        SET cantidad = $1, observaciones = $2
        WHERE id = $3
        RETURNING *
      `, [cantidad, observaciones || null, existingRecord.rows[0].id]);

      console.log('✅ Registro de uso actualizado:', result.rows[0].id);

      res.json({
        success: true,
        message: 'Registro de uso actualizado exitosamente',
        data: result.rows[0]
      });
      return;
    }
  }

  // Crear nuevo registro
  result = await query<RegistroUsoRow>(`
    INSERT INTO registro_uso_equipos (
      asignacion_id, fecha_inicio, fecha_fin, cantidad, observaciones, created_at
    ) VALUES (
      $1, $2, $3, $4, $5, NOW()
    ) RETURNING *
  `, [asignacion_id, fecha_inicio, fecha_fin, cantidad, observaciones || null]);

  console.log('✅ Registro de uso creado:', result.rows[0].id);

  res.json({
    success: true,
    message: 'Registro de uso creado exitosamente',
    data: result.rows[0]
  });
}));

// Obtener registros de uso por asignación
router.get('/asignacion/:asignacion_id', authenticateToken, checkPermission('equipos_uso'), asyncHandler(async (req: Request<{ asignacion_id: string }>, res: Response): Promise<void> => {
  const { asignacion_id } = req.params;

  const result = await query<RegistroUsoRow>(`
    SELECT * FROM registro_uso_equipos
    WHERE asignacion_id = $1
    ORDER BY fecha_inicio DESC
  `, [asignacion_id]);

  console.log('✅ Registros de uso encontrados:', result.rows.length);

  res.json({
    success: true,
    data: result.rows
  });
}));

export default router;
