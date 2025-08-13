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

    // Resumen general simple
    const resumenGeneral = await query(`
        SELECT
            SUM(tubos_requeridos) as tubos_totales_requeridos,
            SUM(longitud_total) as metros_totales_requeridos
        FROM tramos_proyecto
        WHERE proyecto_id = $1 AND activo = true
    `, [projectId]);

    console.log('📊 Resumen general:', resumenGeneral.rows);


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
          ...avanceInstalado
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
module.exports = router;