const express = require('express');
const { body, validationResult, param } = require('express-validator');
const { query } = require('../database/config');
const { authenticateToken, requireManager } = require('../middleware/auth');

const router = express.Router();

// Obtener adendas de un proyecto
router.get('/project/:projectId', authenticateToken, async (req, res) => {
    try {
        const { projectId } = req.params;
        
        const result = await query(`
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

    } catch (error) {
        console.error('Error obteniendo adendas:', error);
        res.status(500).json({
            success: false,
            message: 'Error interno del servidor'
        });
    }
});

// Crear nueva adenda
router.post('/', [
    body('proyecto_id').isInt().withMessage('ID de proyecto debe ser un número'),
    body('tipo').isIn(['tiempo', 'costo', 'mixta']).withMessage('Tipo debe ser tiempo, costo o mixta'),
    authenticateToken,
    requireManager
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                message: 'Datos inválidos',
                errors: errors.array()
            });
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
        const projectCheck = await query('SELECT id FROM proyectos WHERE id = $1', [proyecto_id]);
        if (projectCheck.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Proyecto no encontrado'
            });
        }

        // Obtener el siguiente número de adenda
        const nextNumberResult = await query(`
            SELECT COALESCE(MAX(numero_adenda), 0) + 1 as next_number
            FROM adendas 
            WHERE proyecto_id = $1
        `, [proyecto_id]);
        
        const numero_adenda = nextNumberResult.rows[0].next_number;

        // Validar campos según el tipo
        if ((tipo === 'tiempo' || tipo === 'mixta') && !nueva_fecha_fin) {
            return res.status(400).json({
                success: false,
                message: 'Nueva fecha de fin es requerida para adendas de tiempo'
            });
        }

        if ((tipo === 'costo' || tipo === 'mixta') && !nuevo_monto && !monto_adicional) {
            return res.status(400).json({
                success: false,
                message: 'Nuevo monto o monto adicional es requerido para adendas de costo'
            });
        }

        // Crear la adenda
        const result = await query(`
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

    } catch (error) {
        console.error('Error creando adenda:', error);
        res.status(500).json({
            success: false,
            message: 'Error interno del servidor'
        });
    }
});

// Actualizar adenda
router.put('/:id', [
    param('id').isInt().withMessage('ID debe ser un número'),
    body('tipo').optional().isIn(['tiempo', 'costo', 'mixta']).withMessage('Tipo debe ser tiempo, costo o mixta'),
    body('estado').optional().isIn(['en_proceso', 'aprobada', 'rechazada']).withMessage('Estado inválido'),
    authenticateToken,
    requireManager
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                message: 'Datos inválidos',
                errors: errors.array()
            });
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
        const existingAdenda = await query('SELECT * FROM adendas WHERE id = $1', [id]);
        if (existingAdenda.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Adenda no encontrada'
            });
        }

        // Si se cambia a aprobada, agregar fecha de aprobación
        const fechaAprobacionFinal = estado === 'aprobada' && !existingAdenda.rows[0].fecha_aprobacion
            ? fecha_aprobacion || new Date().toISOString().split('T')[0]
            : fecha_aprobacion;

        // Actualizar la adenda
        const result = await query(`
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

    } catch (error) {
        console.error('Error actualizando adenda:', error);
        res.status(500).json({
            success: false,
            message: 'Error interno del servidor'
        });
    }
});

// Eliminar adenda
router.delete('/:id', [
    param('id').isInt().withMessage('ID debe ser un número'),
    authenticateToken,
    requireManager
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                message: 'Datos inválidos',
                errors: errors.array()
            });
        }

        const { id } = req.params;

        // Verificar que la adenda existe
        const existingAdenda = await query('SELECT * FROM adendas WHERE id = $1', [id]);
        if (existingAdenda.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Adenda no encontrada'
            });
        }

        // Eliminar la adenda
        await query('DELETE FROM adendas WHERE id = $1', [id]);

        res.json({
            success: true,
            message: 'Adenda eliminada exitosamente'
        });

    } catch (error) {
        console.error('Error eliminando adenda:', error);
        res.status(500).json({
            success: false,
            message: 'Error interno del servidor'
        });
    }
});

// Obtener resumen de adendas aprobadas de un proyecto
router.get('/project/:projectId/summary', authenticateToken, async (req, res) => {
    try {
        const { projectId } = req.params;
        
        const result = await query(`
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

    } catch (error) {
        console.error('Error obteniendo resumen de adendas:', error);
        res.status(500).json({
            success: false,
            message: 'Error interno del servidor'
        });
    }
});

module.exports = router;