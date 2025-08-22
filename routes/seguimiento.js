const express = require('express');
const router = express.Router();
const { query } = require('../database/config');
const { authenticateToken } = require('../middleware/auth'); // ← CORRECCIÓN AQUÍ

// Ruta de prueba
router.get('/test', (req, res) => {
  res.json({
    success: true,
    message: 'Seguimiento funcionando'
  });
});

// Obtener dashboard del proyecto (VERSIÓN CORREGIDA)
router.get('/:projectId/dashboard', authenticateToken, async (req, res) => {
  try {
    const { projectId } = req.params;

    console.log('🔍 Buscando datos para proyecto ID:', projectId);

    // Resumen general con datos reales de reportes
    const resumenGeneral = await query(`
        SELECT
            SUM(t.tubos_requeridos) as tubos_totales_requeridos,
            SUM(t.longitud_total) as metros_totales_requeridos,
            COALESCE(SUM(r.tubos_instalados), 0) as tubos_instalados_total,
            COALESCE(SUM(r.metros_instalados), 0) as metros_instalados_total,
            ROUND(
                    (COALESCE(SUM(r.tubos_instalados), 0) * 100.0 / SUM(t.tubos_requeridos)), 2
            ) as porcentaje_avance_total
        FROM tramos_proyecto t
                 LEFT JOIN frentes_trabajo f ON t.id = f.tramo_id
                 LEFT JOIN reportes_diarios r ON f.id = r.frente_id
        WHERE t.proyecto_id = $1 AND t.activo = true
    `, [projectId]);

    console.log('📊 Resumen general:', resumenGeneral.rows);
// Calcular promedio de los últimos 15 días
    const promedioReciente = await query(`
        SELECT
            COALESCE(AVG(tubos_instalados), 0) as promedio_tubos_dia,
            COUNT(*) as dias_con_reporte
        FROM reportes_diarios r
                 JOIN frentes_trabajo f ON r.frente_id = f.id
        WHERE f.proyecto_id = $1
          AND r.fecha >= CURRENT_DATE - INTERVAL '15 days'
          AND r.tubos_instalados > 0
    `, [projectId]);

    // Metas del proyecto
    const metas = await query(`
        SELECT * FROM metas_proyecto
        WHERE proyecto_id = $1
        ORDER BY porcentaje_meta
    `, [projectId]);

    console.log('🎯 Metas:', metas.rows);

    // Avance instalado (por ahora 0)
    const avanceInstalado = {
      tubos_instalados_total: 0,
      metros_instalados_total: 0,
      porcentaje_avance_total: 0
    };

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

  } catch (error) {
    console.error('Error obteniendo dashboard:', error);
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor',
      error: error.message
    });
  }
});

// Obtener frentes de trabajo
router.get('/:projectId/frentes', authenticateToken, async (req, res) => {
  try {
    const { projectId } = req.params;

    const result = await query(`
      SELECT 
        f.*,
        t.nombre as tramo_nombre,
        t.descripcion as tramo_descripcion
      FROM frentes_trabajo f
      JOIN tramos_proyecto t ON f.tramo_id = t.id
      WHERE f.proyecto_id = $1 AND f.activo = true
      ORDER BY t.nombre, f.nombre
    `, [projectId]);

    res.json({
      success: true,
      frentes: result.rows
    });

  } catch (error) {
    console.error('Error obteniendo frentes:', error);
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor'
    });
  }
});

// Crear reporte diario
router.post('/:projectId/reportes', authenticateToken, async (req, res) => {
  try {
    const { projectId } = req.params;
    const { frente_id, fecha, tubos_instalados, observaciones, reportado_por } = req.body;

    const result = await query(`
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

    res.json({
      success: true,
      reporte: result.rows[0],
      message: 'Reporte guardado exitosamente'
    });

  } catch (error) {
    console.error('Error guardando reporte:', error);
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor'
    });
  }
});

// Agregar estos endpoints al final del archivo routes/seguimiento.js (antes de module.exports = router;)

// Obtener tramos del proyecto (para el formulario de crear frentes)
router.get('/:projectId/tramos', authenticateToken, async (req, res) => {
  try {
    const { projectId } = req.params;

    const result = await query(`
      SELECT 
        id, nombre, descripcion, longitud_total, tubos_requeridos
      FROM tramos_proyecto 
      WHERE proyecto_id = $1 AND activo = true
      ORDER BY nombre
    `, [projectId]);

    res.json({
      success: true,
      tramos: result.rows
    });

  } catch (error) {
    console.error('Error obteniendo tramos:', error);
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor'
    });
  }
});

// Crear nuevo frente de trabajo
router.post('/:projectId/frentes', authenticateToken, async (req, res) => {
  try {
    const { projectId } = req.params;
    const { tramo_id, nombre, descripcion } = req.body;

    // Validar que el nombre no existe en ese tramo
    const existeFrente = await query(`
      SELECT id FROM frentes_trabajo 
      WHERE tramo_id = $1 AND nombre = $2 AND activo = true
    `, [tramo_id, nombre]);

    if (existeFrente.rows.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Ya existe un frente con ese nombre en el tramo seleccionado'
      });
    }

    // Crear el frente
    const result = await query(`
      INSERT INTO frentes_trabajo (proyecto_id, tramo_id, nombre, descripcion)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [projectId, tramo_id, nombre, descripcion || null]);

    res.json({
      success: true,
      frente: result.rows[0],
      message: 'Frente de trabajo creado exitosamente'
    });

  } catch (error) {
    console.error('Error creando frente:', error);
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor',
      error: error.message
    });
  }
});

// Obtener estadísticas por frente (para el dashboard mejorado)
router.get('/:projectId/estadisticas-frentes', authenticateToken, async (req, res) => {
  try {
    const { projectId } = req.params;

    const result = await query(`
      SELECT 
        f.id as frente_id,
        f.nombre as frente_nombre,
        t.nombre as tramo_nombre,
        t.tubos_requeridos as tubos_totales_tramo,
        COALESCE(SUM(r.tubos_instalados), 0) as tubos_instalados,
        COALESCE(SUM(r.metros_instalados), 0) as metros_instalados,
        ROUND(
          (COALESCE(SUM(r.tubos_instalados), 0) * 100.0 / GREATEST(t.tubos_requeridos, 1)), 2
        ) as porcentaje_avance,
        COUNT(r.id) as dias_reportados,
        MAX(r.fecha) as ultimo_reporte
      FROM frentes_trabajo f
      JOIN tramos_proyecto t ON f.tramo_id = t.id
      LEFT JOIN reportes_diarios r ON f.id = r.frente_id
      WHERE f.proyecto_id = $1 AND f.activo = true
      GROUP BY f.id, f.nombre, t.nombre, t.tubos_requeridos
      ORDER BY t.nombre, f.nombre
    `, [projectId]);

    res.json({
      success: true,
      estadisticas: result.rows
    });

  } catch (error) {
    console.error('Error obteniendo estadísticas por frente:', error);
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor'
    });
  }
});

// Obtener tramos del proyecto
router.get('/:projectId/tramos', authenticateToken, async (req, res) => {
  try {
    const { projectId } = req.params;

    const result = await query(`
      SELECT 
        id, nombre, descripcion, longitud_total, tubos_requeridos
      FROM tramos_proyecto 
      WHERE proyecto_id = $1 AND activo = true
      ORDER BY nombre
    `, [projectId]);

    res.json({
      success: true,
      tramos: result.rows
    });

  } catch (error) {
    console.error('Error obteniendo tramos:', error);
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor'
    });
  }
});

// Crear nuevo frente de trabajo
router.post('/:projectId/frentes', authenticateToken, async (req, res) => {
  try {
    const { projectId } = req.params;
    const { tramo_id, nombre, descripcion } = req.body;

    const result = await query(`
      INSERT INTO frentes_trabajo (proyecto_id, tramo_id, nombre, descripcion)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [projectId, tramo_id, nombre, descripcion || null]);

    res.json({
      success: true,
      frente: result.rows[0],
      message: 'Frente de trabajo creado exitosamente'
    });

  } catch (error) {
    console.error('Error creando frente:', error);
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor'
    });
  }
});

module.exports = router;