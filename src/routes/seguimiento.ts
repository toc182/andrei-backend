import { Router, Request, Response } from 'express';
import { query } from '../database/config.js';
import { authenticateToken } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

const router = Router();

interface DashboardResumen {
  tubos_totales_requeridos: string;
  metros_totales_requeridos: string;
  tubos_instalados_total: string;
  metros_instalados_total: string;
  porcentaje_avance_total: string;
}

interface PromedioReciente {
  promedio_tubos_dia: string;
  dias_con_reporte: string;
}

interface MetaRow {
  id: number;
  proyecto_id: number;
  porcentaje_meta: number;
  descripcion?: string;
  created_at: Date;
}

interface FrenteRow {
  id: number;
  proyecto_id: number;
  tramo_id: number;
  nombre: string;
  descripcion?: string;
  tramo_nombre?: string;
  tramo_descripcion?: string;
  activo: boolean;
  created_at: Date;
}

interface TramoRow {
  id: number;
  proyecto_id: number;
  nombre: string;
  descripcion?: string;
  longitud_total?: number;
  tubos_requeridos?: number;
  activo: boolean;
}

interface ReporteRow {
  id: number;
  frente_id: number;
  fecha: Date;
  tubos_instalados: number;
  metros_instalados?: number;
  observaciones?: string;
  reportado_por?: string;
  created_at: Date;
  updated_at: Date;
}

interface EstadisticaFrenteRow {
  frente_id: number;
  frente_nombre: string;
  tramo_nombre: string;
  tubos_totales_tramo: number;
  tubos_instalados: string;
  metros_instalados: string;
  porcentaje_avance: string;
  dias_reportados: string;
  ultimo_reporte?: Date;
}

// Ruta de prueba
router.get('/test', (req: Request, res: Response): void => {
  res.json({ success: true, message: 'Seguimiento funcionando' });
});

// Obtener dashboard del proyecto
router.get('/:projectId/dashboard', authenticateToken, asyncHandler(async (req: Request<{ projectId: string }>, res: Response): Promise<void> => {
  const { projectId } = req.params;

  // First check if seguimiento tables exist
  try {
    await query('SELECT 1 FROM tramos_proyecto LIMIT 1');
  } catch (tableError) {
    const err = tableError as Error;
    if (err.message.includes('does not exist')) {
      console.log('⚠️ Seguimiento tables not found, returning empty dashboard');
      res.json({
        success: true,
        dashboard: {
          resumen: {
            tubos_totales_requeridos: 0,
            metros_totales_requeridos: 0,
            tubos_instalados_total: 0,
            metros_instalados_total: 0,
            porcentaje_avance_total: 0
          },
          promedio_reciente: { promedio_tubos_dia: 0, dias_con_reporte: 0 },
          metas: [],
          actividad_reciente: [],
          avance_por_tramo: []
        }
      });
      return;
    }
    throw tableError;
  }

  console.log('🔍 Buscando datos para proyecto ID:', projectId);

  const resumenGeneral = await query<DashboardResumen>(`
    SELECT
      SUM(t.tubos_requeridos) as tubos_totales_requeridos,
      SUM(t.longitud_total) as metros_totales_requeridos,
      COALESCE(SUM(r.tubos_instalados), 0) as tubos_instalados_total,
      COALESCE(SUM(r.metros_instalados), 0) as metros_instalados_total,
      ROUND((COALESCE(SUM(r.tubos_instalados), 0) * 100.0 / SUM(t.tubos_requeridos)), 2) as porcentaje_avance_total
    FROM tramos_proyecto t
    LEFT JOIN frentes_trabajo f ON t.id = f.tramo_id
    LEFT JOIN reportes_diarios r ON f.id = r.frente_id
    WHERE t.proyecto_id = $1 AND t.activo = true
  `, [projectId]);

  console.log('📊 Resumen general:', resumenGeneral.rows);

  const promedioReciente = await query<PromedioReciente>(`
    SELECT
      COALESCE(AVG(tubos_instalados), 0) as promedio_tubos_dia,
      COUNT(*) as dias_con_reporte
    FROM reportes_diarios r
    JOIN frentes_trabajo f ON r.frente_id = f.id
    WHERE f.proyecto_id = $1
      AND r.fecha >= CURRENT_DATE - INTERVAL '15 days'
      AND r.tubos_instalados > 0
  `, [projectId]);

  const metas = await query<MetaRow>(`
    SELECT * FROM metas_proyecto WHERE proyecto_id = $1 ORDER BY porcentaje_meta
  `, [projectId]);

  console.log('🎯 Metas:', metas.rows);

  res.json({
    success: true,
    dashboard: {
      resumen_general: {
        ...resumenGeneral.rows[0],
        promedio_diario: parseFloat(promedioReciente.rows[0].promedio_tubos_dia).toFixed(1)
      },
      metas: metas.rows
    }
  });
}));

// Obtener frentes de trabajo
router.get('/:projectId/frentes', authenticateToken, asyncHandler(async (req: Request<{ projectId: string }>, res: Response): Promise<void> => {
  const { projectId } = req.params;

  const result = await query<FrenteRow>(`
    SELECT f.*, t.nombre as tramo_nombre, t.descripcion as tramo_descripcion
    FROM frentes_trabajo f
    JOIN tramos_proyecto t ON f.tramo_id = t.id
    WHERE f.proyecto_id = $1 AND f.activo = true
    ORDER BY t.nombre, f.nombre
  `, [projectId]);

  res.json({ success: true, frentes: result.rows });
}, {
  tableNotExistsDefault: { frentes: [] }
}));

// Crear reporte diario
router.post('/:projectId/reportes', authenticateToken, asyncHandler(async (req: Request<{ projectId: string }, object, { frente_id: number; fecha: string; tubos_instalados: number; observaciones?: string; reportado_por?: string }>, res: Response): Promise<void> => {
  const { frente_id, fecha, tubos_instalados, observaciones, reportado_por } = req.body;

  const result = await query<ReporteRow>(`
    INSERT INTO reportes_diarios (frente_id, fecha, tubos_instalados, observaciones, reportado_por)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (frente_id, fecha)
    DO UPDATE SET
      tubos_instalados = EXCLUDED.tubos_instalados,
      observaciones = EXCLUDED.observaciones,
      reportado_por = EXCLUDED.reportado_por,
      updated_at = CURRENT_TIMESTAMP
    RETURNING *
  `, [frente_id, fecha, tubos_instalados, observaciones || null, reportado_por || null]);

  res.json({ success: true, reporte: result.rows[0], message: 'Reporte guardado exitosamente' });
}));

// Obtener tramos del proyecto
router.get('/:projectId/tramos', authenticateToken, asyncHandler(async (req: Request<{ projectId: string }>, res: Response): Promise<void> => {
  const { projectId } = req.params;

  const result = await query<TramoRow>(`
    SELECT id, nombre, descripcion, longitud_total, tubos_requeridos
    FROM tramos_proyecto
    WHERE proyecto_id = $1 AND activo = true
    ORDER BY nombre
  `, [projectId]);

  res.json({ success: true, tramos: result.rows });
}));

// Crear nuevo frente de trabajo
router.post('/:projectId/frentes', authenticateToken, asyncHandler(async (req: Request<{ projectId: string }, object, { tramo_id: number; nombre: string; descripcion?: string }>, res: Response): Promise<void> => {
  const { projectId } = req.params;
  const { tramo_id, nombre, descripcion } = req.body;

  const existeFrente = await query<{ id: number }>(`
    SELECT id FROM frentes_trabajo WHERE tramo_id = $1 AND nombre = $2 AND activo = true
  `, [tramo_id, nombre]);

  if (existeFrente.rows.length > 0) {
    res.status(400).json({ success: false, message: 'Ya existe un frente con ese nombre en el tramo seleccionado' });
    return;
  }

  const result = await query<FrenteRow>(`
    INSERT INTO frentes_trabajo (proyecto_id, tramo_id, nombre, descripcion)
    VALUES ($1, $2, $3, $4)
    RETURNING *
  `, [projectId, tramo_id, nombre, descripcion || null]);

  res.json({ success: true, frente: result.rows[0], message: 'Frente de trabajo creado exitosamente' });
}));

// Obtener estadísticas por frente
router.get('/:projectId/estadisticas-frentes', authenticateToken, asyncHandler(async (req: Request<{ projectId: string }>, res: Response): Promise<void> => {
  const { projectId } = req.params;

  const result = await query<EstadisticaFrenteRow>(`
    SELECT
      f.id as frente_id,
      f.nombre as frente_nombre,
      t.nombre as tramo_nombre,
      t.tubos_requeridos as tubos_totales_tramo,
      COALESCE(SUM(r.tubos_instalados), 0) as tubos_instalados,
      COALESCE(SUM(r.metros_instalados), 0) as metros_instalados,
      ROUND((COALESCE(SUM(r.tubos_instalados), 0) * 100.0 / GREATEST(t.tubos_requeridos, 1)), 2) as porcentaje_avance,
      COUNT(r.id) as dias_reportados,
      MAX(r.fecha) as ultimo_reporte
    FROM frentes_trabajo f
    JOIN tramos_proyecto t ON f.tramo_id = t.id
    LEFT JOIN reportes_diarios r ON f.id = r.frente_id
    WHERE f.proyecto_id = $1 AND f.activo = true
    GROUP BY f.id, f.nombre, t.nombre, t.tubos_requeridos
    ORDER BY t.nombre, f.nombre
  `, [projectId]);

  res.json({ success: true, estadisticas: result.rows });
}));

export default router;
