import { Router, Request, Response } from 'express';
import { body, validationResult, param } from 'express-validator';
import { query } from '../database/config.js';
import { authenticateToken, checkPermission } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

const router = Router();

type TipoUso = 'propio' | 'alquiler';
type TipoCobro = 'hora' | 'dia' | 'mes' | 'global';

interface AsignacionRow {
  id: number;
  equipo_id: number;
  cliente_id: number;
  proyecto_id: number;
  responsable_id?: number;
  fecha_inicio: Date;
  fecha_fin?: Date;
  tipo_uso: TipoUso;
  tipo_cobro?: TipoCobro;
  tarifa?: number;
  incluye_operador?: boolean;
  costo_operador?: number;
  incluye_combustible?: boolean;
  costo_combustible?: number;
  ajuste_monto?: number;
  motivo_ajuste?: string;
  observaciones?: string;
  equipo_codigo?: string;
  equipo_descripcion?: string;
  cliente_nombre?: string;
  cliente_abreviatura?: string;
  proyecto_nombre?: string;
  created_at: Date;
  updated_at: Date;
}

interface CreateAsignacionBody {
  equipo_id: number;
  cliente_id: number;
  proyecto_id: number;
  responsable_id?: number;
  fecha_inicio: string;
  fecha_fin?: string;
  tipo_uso: TipoUso;
  tipo_cobro?: TipoCobro;
  tarifa?: number | string;
  incluye_operador?: boolean;
  costo_operador?: number | string;
  incluye_combustible?: boolean;
  costo_combustible?: number | string;
  observaciones?: string;
}

interface UpdateAsignacionBody extends Partial<CreateAsignacionBody> {
  ajuste_monto?: number | string;
  motivo_ajuste?: string;
}

// Obtener todas las asignaciones
router.get('/', authenticateToken, checkPermission('equipos_asignacion'), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  console.log('=== ASIGNACIONES QUERY ===');
  console.log('📊 Environment:', process.env.NODE_ENV);
  console.log('🔍 User ID:', req.user?.id);

  const result = await query<AsignacionRow>(`
    SELECT
      a.*,
      e.codigo as equipo_codigo,
      e.descripcion as equipo_descripcion,
      c.nombre as cliente_nombre,
      c.abreviatura as cliente_abreviatura,
      p.nombre_corto as proyecto_nombre
    FROM asignaciones_equipos a
    LEFT JOIN equipos e ON a.equipo_id = e.id
    LEFT JOIN clientes c ON a.cliente_id = c.id
    LEFT JOIN proyectos p ON a.proyecto_id = p.id
    ORDER BY a.created_at DESC
  `);

  console.log('✅ Asignaciones encontradas:', result.rows.length);

  res.json({
    success: true,
    data: result.rows
  });
}, {
  tableNotExistsDefault: { data: [] }
}));

// Crear nueva asignación
router.post('/', [
  body('equipo_id').isInt().withMessage('ID de equipo requerido'),
  body('cliente_id').isInt().withMessage('ID de cliente requerido'),
  body('proyecto_id').isInt().withMessage('ID de proyecto requerido'),
  body('fecha_inicio').isISO8601().withMessage('Fecha de inicio requerida'),
  body('tipo_uso').isIn(['propio', 'alquiler']).withMessage('Tipo de uso inválido')
], authenticateToken, checkPermission('equipos_asignacion'), asyncHandler(async (req: Request<object, object, CreateAsignacionBody>, res: Response): Promise<void> => {
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
    equipo_id,
    cliente_id,
    proyecto_id,
    responsable_id,
    fecha_inicio,
    fecha_fin,
    tipo_uso,
    tipo_cobro,
    tarifa,
    incluye_operador,
    costo_operador,
    incluye_combustible,
    costo_combustible,
    observaciones
  } = req.body;

  // Convertir strings vacíos a null para campos numéricos y fechas
  const cleanedData = {
    equipo_id,
    cliente_id,
    proyecto_id,
    responsable_id: responsable_id || null,
    fecha_inicio: fecha_inicio || null,
    fecha_fin: fecha_fin === '' ? null : fecha_fin,
    tipo_uso,
    tipo_cobro: tipo_cobro || null,
    tarifa: tarifa === '' ? null : tarifa,
    incluye_operador,
    costo_operador: costo_operador === '' ? null : costo_operador,
    incluye_combustible,
    costo_combustible: costo_combustible === '' ? null : costo_combustible,
    observaciones: observaciones || null
  };

  const result = await query<AsignacionRow>(`
    INSERT INTO asignaciones_equipos (
      equipo_id, cliente_id, proyecto_id, responsable_id,
      fecha_inicio, tipo_uso, tipo_cobro, tarifa,
      incluye_operador, costo_operador, incluye_combustible, costo_combustible,
      observaciones, created_at, updated_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW(), NOW()
    ) RETURNING *
  `, [
    cleanedData.equipo_id, cleanedData.cliente_id, cleanedData.proyecto_id, cleanedData.responsable_id,
    cleanedData.fecha_inicio, cleanedData.tipo_uso, cleanedData.tipo_cobro, cleanedData.tarifa,
    cleanedData.incluye_operador, cleanedData.costo_operador, cleanedData.incluye_combustible, cleanedData.costo_combustible,
    cleanedData.observaciones
  ]);

  console.log('✅ Asignación creada:', result.rows[0].id);

  res.json({
    success: true,
    message: 'Asignación creada exitosamente',
    data: result.rows[0]
  });
}));

// Actualizar asignación
router.put('/:id', [
  param('id').isInt().withMessage('ID debe ser un número'),
  body('equipo_id').optional().isInt().withMessage('ID de equipo inválido'),
  body('cliente_id').optional().isInt().withMessage('ID de cliente inválido'),
  body('proyecto_id').optional().isInt().withMessage('ID de proyecto inválido')
], authenticateToken, checkPermission('equipos_editar_asignacion'), asyncHandler(async (req: Request<{ id: string }, object, UpdateAsignacionBody>, res: Response): Promise<void> => {
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
  const updateData = req.body;
  const userId = req.user!.id;

  // Si se intenta cambiar tipo_cobro, verificar que no haya registros de uso
  if (updateData.tipo_cobro) {
    const registrosUso = await query<{ count: string }>(
      'SELECT COUNT(*) as count FROM registro_uso_equipos WHERE asignacion_id = $1',
      [id]
    );

    if (parseInt(registrosUso.rows[0].count) > 0) {
      const asignacionActual = await query<{ tipo_cobro: TipoCobro }>('SELECT tipo_cobro FROM asignaciones_equipos WHERE id = $1', [id]);

      if (asignacionActual.rows[0].tipo_cobro !== updateData.tipo_cobro) {
        res.status(400).json({
          success: false,
          message: 'No se puede cambiar el tipo de cobro porque ya existen registros de uso para esta asignación'
        });
        return;
      }
    }
  }

  // Obtener datos anteriores para comparación
  const previousData = await query<AsignacionRow>('SELECT * FROM asignaciones_equipos WHERE id = $1', [id]);

  if (previousData.rows.length === 0) {
    res.status(404).json({
      success: false,
      message: 'Asignación no encontrada'
    });
    return;
  }

  const oldData = previousData.rows[0];

  // Campos a trackear
  const camposTrackear = [
    'cliente_id', 'proyecto_id', 'responsable_id', 'fecha_inicio', 'fecha_fin',
    'tipo_uso', 'tipo_cobro', 'tarifa', 'incluye_operador', 'costo_operador',
    'incluye_combustible', 'costo_combustible', 'ajuste_monto', 'motivo_ajuste', 'observaciones'
  ];

  // Registrar cambios en historial
  for (const campo of camposTrackear) {
    if (Object.prototype.hasOwnProperty.call(updateData, campo)) {
      const valorAnterior = oldData[campo as keyof AsignacionRow];
      const valorNuevo = updateData[campo as keyof UpdateAsignacionBody];

      // Solo registrar si hay cambio real
      if (String(valorAnterior) !== String(valorNuevo)) {
        await query(`
          INSERT INTO asignaciones_historial (
            asignacion_id, campo_modificado, valor_anterior, valor_nuevo, usuario_id
          ) VALUES ($1, $2, $3, $4, $5)
        `, [id, campo, valorAnterior, valorNuevo, userId]);
      }
    }
  }

  // Limpiar strings vacíos en updateData antes de actualizar
  const cleanedUpdateData: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(updateData)) {
    if (key === 'fecha_fin' && value === '') {
      cleanedUpdateData[key] = null;
    } else if (['tarifa', 'costo_operador', 'costo_combustible', 'ajuste_monto'].includes(key) && value === '') {
      cleanedUpdateData[key] = null;
    } else {
      cleanedUpdateData[key] = value;
    }
  }

  // Actualizar asignación
  cleanedUpdateData.updated_at = new Date();
  const fields = Object.keys(cleanedUpdateData).map((key, index) => `${key} = $${index + 2}`).join(', ');
  const values = [id, ...Object.values(cleanedUpdateData)];

  const result = await query<AsignacionRow>(`
    UPDATE asignaciones_equipos
    SET ${fields}
    WHERE id = $1
    RETURNING *
  `, values);

  console.log('✅ Asignación actualizada:', id);

  res.json({
    success: true,
    message: 'Asignación actualizada exitosamente',
    data: result.rows[0]
  });
}));

// Eliminar asignación
router.delete('/:id', [
  param('id').isInt().withMessage('ID debe ser un número')
], authenticateToken, checkPermission('equipos_asignacion'), asyncHandler(async (req: Request<{ id: string }>, res: Response): Promise<void> => {
  const { id } = req.params;

  const result = await query('DELETE FROM asignaciones_equipos WHERE id = $1', [id]);

  if (result.rowCount === 0) {
    res.status(404).json({
      success: false,
      message: 'Asignación no encontrada'
    });
    return;
  }

  console.log('✅ Asignación eliminada:', id);

  res.json({
    success: true,
    message: 'Asignación eliminada exitosamente'
  });
}));

export default router;
