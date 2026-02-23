import { Router, Request, Response } from 'express';
import { body, param, validationResult } from 'express-validator';
import { query } from '../database/config.js';
import { authenticateToken } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

const router = Router();

// Todas las rutas requieren autenticación
router.use(authenticateToken);

// --- Interfaces ---

interface SolicitudRow {
  id: number;
  proyecto_id: number | null;
  numero: string;
  fecha: string;
  proveedor: string;
  preparado_por: number;
  solicitado_por: number | null;
  requisicion_id: number | null;
  subtotal: number;
  descuentos: number;
  impuestos: number;
  monto_total: number;
  estado: string;
  observaciones: string | null;
  beneficiario: string | null;
  banco: string | null;
  tipo_cuenta: string | null;
  numero_cuenta: string | null;
  created_at: Date;
  updated_at: Date;
  proyecto_nombre?: string;
  preparado_nombre?: string;
  solicitado_nombre?: string;
  requisicion_numero?: string;
}

interface ItemRow {
  id: number;
  solicitud_pago_id: number;
  cantidad: number;
  unidad: string;
  descripcion: string;
  descripcion_detallada: string | null;
  precio_unitario: number;
  precio_total: number;
  orden: number;
}

interface AjusteRow {
  id: number;
  solicitud_pago_id: number;
  tipo: string;
  descripcion: string;
  porcentaje: number | null;
  monto: number;
  orden: number;
}

interface CreateBody {
  proyecto_id: number;
  fecha?: string;
  proveedor: string;
  solicitado_por?: number;
  requisicion_id?: number;
  observaciones?: string;
  beneficiario?: string;
  banco?: string;
  tipo_cuenta?: string;
  numero_cuenta?: string;
  items: Array<{
    cantidad: number;
    unidad?: string;
    descripcion: string;
    descripcion_detallada?: string;
    precio_unitario: number;
  }>;
  ajustes?: Array<{
    tipo: string;
    descripcion: string;
    porcentaje?: number;
    monto: number;
  }>;
}

// --- Helpers ---

const TRANSICIONES: Record<string, string[]> = {
  'borrador': ['pendiente', 'rechazada'],
  'pendiente': ['aprobada', 'rechazada'],
  'aprobada': ['pagada', 'rechazada'],
  'rechazada': ['borrador'],
  'pagada': []
};

async function generateNumero(projectId: number): Promise<string> {
  const project = await query<{ sp_prefijo: string | null }>('SELECT sp_prefijo FROM proyectos WHERE id = $1', [projectId]);

  if (project.rows.length === 0) throw new Error('Proyecto no encontrado');

  const prefijo = project.rows[0].sp_prefijo;
  if (!prefijo) throw new Error('PREFIJO_NO_CONFIGURADO');

  const count = await query<{ total: string }>('SELECT COUNT(*)::text as total FROM solicitudes_pago WHERE proyecto_id = $1', [projectId]);
  const nextNum = parseInt(count.rows[0].total) + 1;

  return `${prefijo}-${String(nextNum).padStart(3, '0')}`;
}

// --- GET / — Listar todas (global) ---
router.get('/', asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { estado, proyecto_id } = req.query;

  let whereClause = 'WHERE 1=1';
  const params: unknown[] = [];
  let paramCount = 0;

  if (estado && estado !== 'all') {
    paramCount++;
    whereClause += ` AND sp.estado = $${paramCount}`;
    params.push(estado);
  }

  if (proyecto_id) {
    paramCount++;
    whereClause += ` AND sp.proyecto_id = $${paramCount}`;
    params.push(proyecto_id);
  }

  const result = await query<SolicitudRow>(`
    SELECT sp.*,
      p.nombre as proyecto_nombre,
      u1.nombre as preparado_nombre,
      u2.nombre as solicitado_nombre
    FROM solicitudes_pago sp
    LEFT JOIN proyectos p ON sp.proyecto_id = p.id
    LEFT JOIN users u1 ON sp.preparado_por = u1.id
    LEFT JOIN users u2 ON sp.solicitado_por = u2.id
    ${whereClause}
    ORDER BY sp.created_at DESC
  `, params);

  res.json({ success: true, solicitudes: result.rows });
}));

// --- GET /project/:projectId — Listar del proyecto ---
router.get('/project/:projectId', asyncHandler(async (req: Request<{ projectId: string }>, res: Response): Promise<void> => {
  const { projectId } = req.params;
  const { estado } = req.query;

  let whereClause = 'WHERE sp.proyecto_id = $1';
  const params: unknown[] = [projectId];

  if (estado && estado !== 'all') {
    whereClause += ' AND sp.estado = $2';
    params.push(estado);
  }

  const result = await query<SolicitudRow>(`
    SELECT sp.*,
      u1.nombre as preparado_nombre,
      u2.nombre as solicitado_nombre,
      r.numero as requisicion_numero
    FROM solicitudes_pago sp
    LEFT JOIN users u1 ON sp.preparado_por = u1.id
    LEFT JOIN users u2 ON sp.solicitado_por = u2.id
    LEFT JOIN requisiciones r ON sp.requisicion_id = r.id
    ${whereClause}
    ORDER BY sp.created_at DESC
  `, params);

  // También devolver info del prefijo
  const project = await query<{ sp_prefijo: string | null }>('SELECT sp_prefijo FROM proyectos WHERE id = $1', [projectId]);

  res.json({
    success: true,
    solicitudes: result.rows,
    sp_prefijo: project.rows[0]?.sp_prefijo || null
  });
}));

// --- GET /project/:projectId/next-number — Próximo número ---
router.get('/project/:projectId/next-number', asyncHandler(async (req: Request<{ projectId: string }>, res: Response): Promise<void> => {
  const { projectId } = req.params;

  try {
    const numero = await generateNumero(parseInt(projectId));
    res.json({ success: true, numero });
  } catch (err) {
    const error = err as Error;
    if (error.message === 'PREFIJO_NO_CONFIGURADO') {
      res.status(400).json({ success: false, message: 'El proyecto no tiene prefijo configurado para solicitudes de pago' });
      return;
    }
    throw err;
  }
}));

// --- PUT /project/:projectId/prefijo — Configurar prefijo ---
router.put('/project/:projectId/prefijo', [
  body('prefijo').trim().isLength({ min: 1, max: 20 }).withMessage('Prefijo debe tener entre 1 y 20 caracteres')
], asyncHandler(async (req: Request<{ projectId: string }>, res: Response): Promise<void> => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ success: false, message: 'Datos inválidos', errors: errors.array() });
    return;
  }

  const { projectId } = req.params;
  const { prefijo } = req.body;

  await query('UPDATE proyectos SET sp_prefijo = $1 WHERE id = $2', [prefijo, projectId]);

  res.json({ success: true, message: 'Prefijo actualizado', prefijo });
}));

// --- GET /:id — Detalle completo ---
router.get('/:id', [
  param('id').isInt()
], asyncHandler(async (req: Request<{ id: string }>, res: Response): Promise<void> => {
  const { id } = req.params;

  const solicitud = await query<SolicitudRow>(`
    SELECT sp.*,
      p.nombre as proyecto_nombre,
      u1.nombre as preparado_nombre,
      u2.nombre as solicitado_nombre,
      r.numero as requisicion_numero
    FROM solicitudes_pago sp
    LEFT JOIN proyectos p ON sp.proyecto_id = p.id
    LEFT JOIN users u1 ON sp.preparado_por = u1.id
    LEFT JOIN users u2 ON sp.solicitado_por = u2.id
    LEFT JOIN requisiciones r ON sp.requisicion_id = r.id
    WHERE sp.id = $1
  `, [id]);

  if (solicitud.rows.length === 0) {
    res.status(404).json({ success: false, message: 'Solicitud no encontrada' });
    return;
  }

  const items = await query<ItemRow>(
    'SELECT * FROM solicitud_pago_items WHERE solicitud_pago_id = $1 ORDER BY orden, id', [id]
  );

  const ajustes = await query<AjusteRow>(
    'SELECT * FROM solicitud_pago_ajustes WHERE solicitud_pago_id = $1 ORDER BY orden, id', [id]
  );

  res.json({
    success: true,
    solicitud: solicitud.rows[0],
    items: items.rows,
    ajustes: ajustes.rows
  });
}));

// --- POST / — Crear solicitud ---
router.post('/', [
  body('proyecto_id').isInt().withMessage('Proyecto requerido'),
  body('proveedor').trim().notEmpty().withMessage('Proveedor requerido'),
  body('items').isArray({ min: 1 }).withMessage('Debe incluir al menos un item')
], asyncHandler(async (req: Request<object, object, CreateBody>, res: Response): Promise<void> => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ success: false, message: 'Datos inválidos', errors: errors.array() });
    return;
  }

  const {
    proyecto_id, fecha, proveedor, solicitado_por, requisicion_id,
    observaciones, beneficiario, banco, tipo_cuenta, numero_cuenta,
    items, ajustes = []
  } = req.body;

  // Generar número automático
  let numero: string;
  try {
    numero = await generateNumero(proyecto_id);
  } catch (err) {
    const error = err as Error;
    if (error.message === 'PREFIJO_NO_CONFIGURADO') {
      res.status(400).json({ success: false, message: 'Configure el prefijo del proyecto antes de crear solicitudes' });
      return;
    }
    throw err;
  }

  // Calcular totales
  const itemsCalculados = items.map((item, index) => ({
    ...item,
    precio_total: (item.cantidad || 1) * (item.precio_unitario || 0),
    orden: index
  }));

  const subtotal = itemsCalculados.reduce((sum, item) => sum + item.precio_total, 0);

  const ajustesCalculados = ajustes.map((ajuste, index) => ({
    ...ajuste,
    monto: ajuste.porcentaje ? subtotal * ajuste.porcentaje / 100 : ajuste.monto,
    orden: index
  }));

  const totalDescuentos = ajustesCalculados
    .filter(a => a.tipo === 'descuento')
    .reduce((sum, a) => sum + Math.abs(a.monto), 0);

  const totalImpuestos = ajustesCalculados
    .filter(a => a.tipo === 'impuesto')
    .reduce((sum, a) => sum + Math.abs(a.monto), 0);

  const montoTotal = subtotal - totalDescuentos + totalImpuestos;

  // Insertar solicitud
  const result = await query<SolicitudRow>(`
    INSERT INTO solicitudes_pago (
      proyecto_id, numero, fecha, proveedor, preparado_por, solicitado_por,
      requisicion_id, subtotal, descuentos, impuestos, monto_total,
      estado, observaciones, beneficiario, banco, tipo_cuenta, numero_cuenta
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'borrador', $12, $13, $14, $15, $16)
    RETURNING *
  `, [
    proyecto_id, numero, fecha || new Date().toISOString().split('T')[0],
    proveedor, req.user!.id, solicitado_por || null,
    requisicion_id || null, subtotal, totalDescuentos, totalImpuestos, montoTotal,
    observaciones || null, beneficiario || null, banco || null,
    tipo_cuenta || null, numero_cuenta || null
  ]);

  const solicitudId = result.rows[0].id;

  // Insertar items
  for (const item of itemsCalculados) {
    await query(`
      INSERT INTO solicitud_pago_items (solicitud_pago_id, cantidad, unidad, descripcion, descripcion_detallada, precio_unitario, precio_total, orden)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [solicitudId, item.cantidad || 1, item.unidad || 'unidad', item.descripcion, item.descripcion_detallada || null, item.precio_unitario, item.precio_total, item.orden]);
  }

  // Insertar ajustes
  for (const ajuste of ajustesCalculados) {
    await query(`
      INSERT INTO solicitud_pago_ajustes (solicitud_pago_id, tipo, descripcion, porcentaje, monto, orden)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [solicitudId, ajuste.tipo, ajuste.descripcion, ajuste.porcentaje || null, ajuste.monto, ajuste.orden]);
  }

  res.status(201).json({
    success: true,
    message: 'Solicitud de pago creada',
    solicitud: result.rows[0]
  });
}));

// --- PUT /:id — Editar solicitud ---
router.put('/:id', [
  param('id').isInt(),
  body('proveedor').trim().notEmpty().withMessage('Proveedor requerido'),
  body('items').isArray({ min: 1 }).withMessage('Debe incluir al menos un item')
], asyncHandler(async (req: Request<{ id: string }, object, CreateBody>, res: Response): Promise<void> => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ success: false, message: 'Datos inválidos', errors: errors.array() });
    return;
  }

  const { id } = req.params;

  // Verificar que existe y está en estado editable
  const existing = await query<SolicitudRow>('SELECT id, estado FROM solicitudes_pago WHERE id = $1', [id]);
  if (existing.rows.length === 0) {
    res.status(404).json({ success: false, message: 'Solicitud no encontrada' });
    return;
  }
  if (!['borrador', 'pendiente'].includes(existing.rows[0].estado)) {
    res.status(400).json({ success: false, message: 'Solo se pueden editar solicitudes en borrador o pendiente' });
    return;
  }

  const {
    fecha, proveedor, solicitado_por, requisicion_id,
    observaciones, beneficiario, banco, tipo_cuenta, numero_cuenta,
    items, ajustes = []
  } = req.body;

  // Recalcular totales
  const itemsCalculados = items.map((item, index) => ({
    ...item,
    precio_total: (item.cantidad || 1) * (item.precio_unitario || 0),
    orden: index
  }));

  const subtotal = itemsCalculados.reduce((sum, item) => sum + item.precio_total, 0);

  const ajustesCalculados = ajustes.map((ajuste, index) => ({
    ...ajuste,
    monto: ajuste.porcentaje ? subtotal * ajuste.porcentaje / 100 : ajuste.monto,
    orden: index
  }));

  const totalDescuentos = ajustesCalculados.filter(a => a.tipo === 'descuento').reduce((sum, a) => sum + Math.abs(a.monto), 0);
  const totalImpuestos = ajustesCalculados.filter(a => a.tipo === 'impuesto').reduce((sum, a) => sum + Math.abs(a.monto), 0);
  const montoTotal = subtotal - totalDescuentos + totalImpuestos;

  // Actualizar solicitud
  const result = await query<SolicitudRow>(`
    UPDATE solicitudes_pago SET
      fecha = $1, proveedor = $2, solicitado_por = $3, requisicion_id = $4,
      subtotal = $5, descuentos = $6, impuestos = $7, monto_total = $8,
      observaciones = $9, beneficiario = $10, banco = $11, tipo_cuenta = $12,
      numero_cuenta = $13, updated_at = CURRENT_TIMESTAMP
    WHERE id = $14 RETURNING *
  `, [
    fecha || new Date().toISOString().split('T')[0], proveedor,
    solicitado_por || null, requisicion_id || null,
    subtotal, totalDescuentos, totalImpuestos, montoTotal,
    observaciones || null, beneficiario || null, banco || null,
    tipo_cuenta || null, numero_cuenta || null, id
  ]);

  // Reemplazar items
  await query('DELETE FROM solicitud_pago_items WHERE solicitud_pago_id = $1', [id]);
  for (const item of itemsCalculados) {
    await query(`
      INSERT INTO solicitud_pago_items (solicitud_pago_id, cantidad, unidad, descripcion, descripcion_detallada, precio_unitario, precio_total, orden)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [id, item.cantidad || 1, item.unidad || 'unidad', item.descripcion, item.descripcion_detallada || null, item.precio_unitario, item.precio_total, item.orden]);
  }

  // Reemplazar ajustes
  await query('DELETE FROM solicitud_pago_ajustes WHERE solicitud_pago_id = $1', [id]);
  for (const ajuste of ajustesCalculados) {
    await query(`
      INSERT INTO solicitud_pago_ajustes (solicitud_pago_id, tipo, descripcion, porcentaje, monto, orden)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [id, ajuste.tipo, ajuste.descripcion, ajuste.porcentaje || null, ajuste.monto, ajuste.orden]);
  }

  res.json({ success: true, message: 'Solicitud actualizada', solicitud: result.rows[0] });
}));

// --- PATCH /:id/estado — Cambiar estado ---
router.patch('/:id/estado', [
  param('id').isInt(),
  body('estado').isIn(['borrador', 'pendiente', 'aprobada', 'rechazada', 'pagada']).withMessage('Estado inválido')
], asyncHandler(async (req: Request<{ id: string }>, res: Response): Promise<void> => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ success: false, message: 'Datos inválidos', errors: errors.array() });
    return;
  }

  const { id } = req.params;
  const { estado } = req.body;

  const existing = await query<SolicitudRow>('SELECT id, estado FROM solicitudes_pago WHERE id = $1', [id]);
  if (existing.rows.length === 0) {
    res.status(404).json({ success: false, message: 'Solicitud no encontrada' });
    return;
  }

  const estadoActual = existing.rows[0].estado;
  const permitidos = TRANSICIONES[estadoActual] || [];

  if (!permitidos.includes(estado)) {
    res.status(400).json({
      success: false,
      message: `No se puede cambiar de "${estadoActual}" a "${estado}"`
    });
    return;
  }

  const result = await query<SolicitudRow>(
    'UPDATE solicitudes_pago SET estado = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *',
    [estado, id]
  );

  res.json({ success: true, message: `Estado cambiado a ${estado}`, solicitud: result.rows[0] });
}));

// --- DELETE /:id — Eliminar (solo borrador) ---
router.delete('/:id', [
  param('id').isInt()
], asyncHandler(async (req: Request<{ id: string }>, res: Response): Promise<void> => {
  const { id } = req.params;

  const existing = await query<SolicitudRow>('SELECT id, estado FROM solicitudes_pago WHERE id = $1', [id]);
  if (existing.rows.length === 0) {
    res.status(404).json({ success: false, message: 'Solicitud no encontrada' });
    return;
  }
  if (existing.rows[0].estado !== 'borrador') {
    res.status(400).json({ success: false, message: 'Solo se pueden eliminar solicitudes en borrador' });
    return;
  }

  await query('DELETE FROM solicitudes_pago WHERE id = $1', [id]);

  res.json({ success: true, message: 'Solicitud eliminada' });
}));

export default router;
