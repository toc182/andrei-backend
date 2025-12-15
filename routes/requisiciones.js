const express = require('express');
const router = express.Router();
const { query } = require('../database/config');
const { authenticateToken, requireManager } = require('../middleware/auth');
const { body, param, validationResult } = require('express-validator');

// ===============================
// GET - Listar requisiciones
// ===============================

// Obtener todas las requisiciones (con filtros opcionales)
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { project_id, estado, archivadas, limit = 50, offset = 0 } = req.query;

    // Por defecto, excluir archivadas (a menos que se pida explicitamente)
    let whereClause = 'WHERE (r.archivada = FALSE OR r.archivada IS NULL)';
    const params = [];
    let paramCount = 0;

    // Si se piden archivadas, mostrar solo archivadas
    if (archivadas === 'true') {
      whereClause = 'WHERE r.archivada = TRUE';
    } else if (archivadas === 'all') {
      whereClause = 'WHERE 1=1';
    }

    if (project_id) {
      paramCount++;
      whereClause += ` AND r.project_id = $${paramCount}`;
      params.push(project_id);
    }

    if (estado) {
      paramCount++;
      whereClause += ` AND r.estado = $${paramCount}`;
      params.push(estado);
    }

    paramCount++;
    const limitParam = paramCount;
    params.push(parseInt(limit));

    paramCount++;
    const offsetParam = paramCount;
    params.push(parseInt(offset));

    const result = await query(`
      SELECT
        r.*,
        p.nombre as proyecto_nombre,
        p.nombre_corto as proyecto_corto,
        u_creador.nombre as creador_nombre,
        u_solicitante.nombre as solicitante_nombre,
        u_apr.nombre as aprobador_nombre,
        u_pag.nombre as pagador_nombre,
        (SELECT COUNT(*) FROM requisicion_items ri WHERE ri.requisicion_id = r.id) as items_count
      FROM requisiciones r
      LEFT JOIN proyectos p ON r.project_id = p.id
      LEFT JOIN users u_creador ON r.solicitado_por = u_creador.id
      LEFT JOIN users u_solicitante ON r.solicitante_id = u_solicitante.id
      LEFT JOIN users u_apr ON r.aprobado_por = u_apr.id
      LEFT JOIN users u_pag ON r.pagado_por = u_pag.id
      ${whereClause}
      ORDER BY r.created_at DESC
      LIMIT $${limitParam} OFFSET $${offsetParam}
    `, params);

    // Contar total para paginacion
    const countResult = await query(`
      SELECT COUNT(*) as total
      FROM requisiciones r
      ${whereClause.replace(` LIMIT $${limitParam} OFFSET $${offsetParam}`, '')}
    `, params.slice(0, -2));

    res.json({
      success: true,
      requisiciones: result.rows,
      total: parseInt(countResult.rows[0].total),
      limit: parseInt(limit),
      offset: parseInt(offset)
    });

  } catch (error) {
    console.error('Error fetching requisiciones:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener requisiciones'
    });
  }
});

// Obtener requisiciones por proyecto
router.get('/project/:projectId', authenticateToken, [
  param('projectId').isInt().withMessage('ID de proyecto invalido')
], async (req, res) => {
  try {
    const { projectId } = req.params;
    const { estado, archivadas } = req.query;

    // Por defecto, excluir archivadas
    let whereClause = 'WHERE r.project_id = $1 AND (r.archivada = FALSE OR r.archivada IS NULL)';
    const params = [projectId];

    // Si se piden archivadas
    if (archivadas === 'true') {
      whereClause = 'WHERE r.project_id = $1 AND r.archivada = TRUE';
    } else if (archivadas === 'all') {
      whereClause = 'WHERE r.project_id = $1';
    }

    if (estado) {
      whereClause += ' AND r.estado = $2';
      params.push(estado);
    }

    const result = await query(`
      SELECT
        r.*,
        u_creador.nombre as creador_nombre,
        u_solicitante.nombre as solicitante_nombre,
        u_apr.nombre as aprobador_nombre,
        (SELECT COUNT(*) FROM requisicion_items ri WHERE ri.requisicion_id = r.id) as items_count
      FROM requisiciones r
      LEFT JOIN users u_creador ON r.solicitado_por = u_creador.id
      LEFT JOIN users u_solicitante ON r.solicitante_id = u_solicitante.id
      LEFT JOIN users u_apr ON r.aprobado_por = u_apr.id
      ${whereClause}
      ORDER BY r.created_at DESC
    `, params);

    res.json({
      success: true,
      requisiciones: result.rows
    });

  } catch (error) {
    console.error('Error fetching project requisiciones:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener requisiciones del proyecto'
    });
  }
});

// Obtener una requisicion por ID (con items e historial)
router.get('/:id', authenticateToken, [
  param('id').isInt().withMessage('ID de requisicion invalido')
], async (req, res) => {
  try {
    const { id } = req.params;

    const result = await query(`
      SELECT
        r.*,
        p.nombre as proyecto_nombre,
        p.nombre_corto as proyecto_corto,
        u_creador.nombre as creador_nombre,
        u_solicitante.nombre as solicitante_nombre,
        u_apr.nombre as aprobador_nombre,
        u_pag.nombre as pagador_nombre
      FROM requisiciones r
      LEFT JOIN proyectos p ON r.project_id = p.id
      LEFT JOIN users u_creador ON r.solicitado_por = u_creador.id
      LEFT JOIN users u_solicitante ON r.solicitante_id = u_solicitante.id
      LEFT JOIN users u_apr ON r.aprobado_por = u_apr.id
      LEFT JOIN users u_pag ON r.pagado_por = u_pag.id
      WHERE r.id = $1
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Requisicion no encontrada'
      });
    }

    // Obtener items de la requisicion
    const items = await query(`
      SELECT
        ri.*,
        pec.nombre as categoria_nombre,
        pec.codigo as categoria_codigo,
        pec.color as categoria_color
      FROM requisicion_items ri
      LEFT JOIN project_expense_categories pec ON ri.categoria_id = pec.id
      WHERE ri.requisicion_id = $1
      ORDER BY ri.id
    `, [id]);

    // Obtener historial de cambios
    const historial = await query(`
      SELECT
        rh.*,
        u.nombre as usuario_nombre
      FROM requisiciones_historial rh
      LEFT JOIN users u ON rh.usuario_id = u.id
      WHERE rh.requisicion_id = $1
      ORDER BY rh.created_at DESC
    `, [id]);

    res.json({
      success: true,
      requisicion: result.rows[0],
      items: items.rows,
      historial: historial.rows
    });

  } catch (error) {
    console.error('Error fetching requisicion:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener requisicion'
    });
  }
});

// ===============================
// POST - Crear requisicion
// ===============================

router.post('/', authenticateToken, [
  body('numero').trim().notEmpty().withMessage('Numero de requisicion requerido'),
  body('project_id').isInt().withMessage('ID de proyecto invalido'),
  body('proveedor').trim().notEmpty().withMessage('Proveedor requerido'),
  body('items').isArray({ min: 1 }).withMessage('Debe incluir al menos un item'),
  body('items.*.descripcion').trim().notEmpty().withMessage('Descripcion del item requerida'),
  body('items.*.cantidad').isNumeric().withMessage('Cantidad debe ser un numero'),
  body('items.*.precio_unitario').isNumeric().withMessage('Precio unitario debe ser un numero'),
  body('concepto').optional().trim(),
  body('fecha').optional().isDate().withMessage('Fecha invalida'),
  body('solicitante_id').optional().isInt().withMessage('ID de solicitante invalido')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Datos invalidos',
        errors: errors.array()
      });
    }

    const {
      numero,
      project_id,
      proveedor,
      concepto,
      fecha,
      pdf_url,
      pdf_nombre,
      items,
      solicitante_id
    } = req.body;

    // Calcular totales desde los items
    let subtotalGeneral = 0;
    let itbmsGeneral = 0;

    const itemsCalculados = items.map(item => {
      const cantidad = parseFloat(item.cantidad);
      const precioUnitario = parseFloat(item.precio_unitario);
      const subtotal = cantidad * precioUnitario;
      const aplicaItbms = item.aplica_itbms === true;
      const itbms = aplicaItbms ? subtotal * 0.07 : 0;
      const total = subtotal + itbms;

      subtotalGeneral += subtotal;
      itbmsGeneral += itbms;

      return {
        ...item,
        cantidad,
        precio_unitario: precioUnitario,
        subtotal,
        aplica_itbms: aplicaItbms,
        itbms,
        total
      };
    });

    const montoTotal = subtotalGeneral + itbmsGeneral;

    // Crear la requisicion
    // solicitante_id: si no se especifica, usa el usuario logueado
    const solicitanteIdFinal = solicitante_id || req.user.id;

    const result = await query(`
      INSERT INTO requisiciones (
        numero, project_id, proveedor, concepto, fecha,
        pdf_url, pdf_nombre, solicitado_por, solicitante_id, estado,
        subtotal, itbms, monto_total
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pendiente', $10, $11, $12)
      RETURNING *
    `, [
      numero,
      project_id,
      proveedor,
      concepto || null,
      fecha || new Date(),
      pdf_url || null,
      pdf_nombre || null,
      req.user.id,           // solicitado_por: quien crea la requisicion
      solicitanteIdFinal,    // solicitante_id: quien la solicita (puede ser otro)
      subtotalGeneral,
      itbmsGeneral,
      montoTotal
    ]);

    const requisicionId = result.rows[0].id;

    // Insertar items
    for (const item of itemsCalculados) {
      await query(`
        INSERT INTO requisicion_items (
          requisicion_id, descripcion, cantidad, unidad,
          precio_unitario, subtotal, aplica_itbms, itbms, total,
          categoria_id, notas
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      `, [
        requisicionId,
        item.descripcion,
        item.cantidad,
        item.unidad || 'unidad',
        item.precio_unitario,
        item.subtotal,
        item.aplica_itbms,
        item.itbms,
        item.total,
        item.categoria_id || null,
        item.notas || null
      ]);
    }

    // Registrar en historial
    await query(`
      INSERT INTO requisiciones_historial (requisicion_id, estado_nuevo, usuario_id, comentario)
      VALUES ($1, 'pendiente', $2, 'Requisicion creada')
    `, [requisicionId, req.user.id]);

    res.status(201).json({
      success: true,
      message: 'Requisicion creada exitosamente',
      requisicion: result.rows[0]
    });

  } catch (error) {
    console.error('Error creating requisicion:', error);
    if (error.code === '23505') {
      return res.status(400).json({
        success: false,
        message: 'Ya existe una requisicion con ese numero'
      });
    }
    res.status(500).json({
      success: false,
      message: 'Error al crear requisicion'
    });
  }
});

// ===============================
// PUT - Actualizar requisicion
// ===============================

router.put('/:id', authenticateToken, [
  param('id').isInt().withMessage('ID de requisicion invalido'),
  body('proveedor').optional().trim().notEmpty(),
  body('concepto').optional().trim(),
  body('items').optional().isArray()
], async (req, res) => {
  try {
    const { id } = req.params;
    const { proveedor, concepto, items } = req.body;

    // Verificar que la requisicion existe y esta en estado editable
    const existing = await query('SELECT * FROM requisiciones WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Requisicion no encontrada'
      });
    }

    if (!['pendiente', 'en_cotizacion'].includes(existing.rows[0].estado)) {
      return res.status(400).json({
        success: false,
        message: 'Solo se pueden editar requisiciones pendientes o en cotizacion'
      });
    }

    // Si hay items, recalcular totales
    let subtotalGeneral = existing.rows[0].subtotal;
    let itbmsGeneral = existing.rows[0].itbms;
    let montoTotal = existing.rows[0].monto_total;

    if (items && items.length > 0) {
      // Eliminar items existentes
      await query('DELETE FROM requisicion_items WHERE requisicion_id = $1', [id]);

      // Recalcular
      subtotalGeneral = 0;
      itbmsGeneral = 0;

      for (const item of items) {
        const cantidad = parseFloat(item.cantidad);
        const precioUnitario = parseFloat(item.precio_unitario);
        const subtotal = cantidad * precioUnitario;
        const aplicaItbms = item.aplica_itbms === true;
        const itbms = aplicaItbms ? subtotal * 0.07 : 0;
        const total = subtotal + itbms;

        subtotalGeneral += subtotal;
        itbmsGeneral += itbms;

        await query(`
          INSERT INTO requisicion_items (
            requisicion_id, descripcion, cantidad, unidad,
            precio_unitario, subtotal, aplica_itbms, itbms, total,
            categoria_id, notas
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        `, [
          id,
          item.descripcion,
          cantidad,
          item.unidad || 'unidad',
          precioUnitario,
          subtotal,
          aplicaItbms,
          itbms,
          total,
          item.categoria_id || null,
          item.notas || null
        ]);
      }

      montoTotal = subtotalGeneral + itbmsGeneral;
    }

    const result = await query(`
      UPDATE requisiciones SET
        proveedor = COALESCE($1, proveedor),
        concepto = COALESCE($2, concepto),
        subtotal = $3,
        itbms = $4,
        monto_total = $5,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $6
      RETURNING *
    `, [proveedor, concepto, subtotalGeneral, itbmsGeneral, montoTotal, id]);

    res.json({
      success: true,
      message: 'Requisicion actualizada',
      requisicion: result.rows[0]
    });

  } catch (error) {
    console.error('Error updating requisicion:', error);
    res.status(500).json({
      success: false,
      message: 'Error al actualizar requisicion'
    });
  }
});

// ===============================
// PATCH - Cambiar estado
// ===============================

router.patch('/:id/estado', authenticateToken, [
  param('id').isInt().withMessage('ID de requisicion invalido'),
  body('estado').isIn(['pendiente', 'en_cotizacion', 'por_aprobar', 'aprobada', 'pagada', 'rechazada'])
    .withMessage('Estado invalido'),
  body('comentario').optional().trim()
], async (req, res) => {
  try {
    // Validar errores
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Datos invalidos',
        errors: errors.array()
      });
    }

    const { id } = req.params;
    const { estado, comentario } = req.body;

    console.log('=== CAMBIO ESTADO REQUISICION ===');
    console.log('ID:', id);
    console.log('Nuevo estado:', estado);

    // Obtener requisicion actual
    const existing = await query('SELECT * FROM requisiciones WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Requisicion no encontrada'
      });
    }

    const estadoAnterior = existing.rows[0].estado;
    const requisicion = existing.rows[0];

    // Validar transiciones de estado permitidas
    const transicionesPermitidas = {
      'pendiente': ['en_cotizacion', 'por_aprobar', 'rechazada'],
      'en_cotizacion': ['por_aprobar', 'pendiente', 'rechazada'],
      'por_aprobar': ['aprobada', 'rechazada', 'pendiente'],
      'aprobada': ['pagada', 'rechazada'],
      'pagada': [], // Estado final
      'rechazada': ['pendiente'] // Puede reactivarse
    };

    if (!transicionesPermitidas[estadoAnterior].includes(estado)) {
      return res.status(400).json({
        success: false,
        message: `No se puede cambiar de "${estadoAnterior}" a "${estado}"`
      });
    }

    // Actualizar campos segun el nuevo estado
    let updateFields = 'estado = $1, updated_at = CURRENT_TIMESTAMP';
    const params = [estado];
    let paramCount = 1;

    if (estado === 'aprobada') {
      paramCount++;
      updateFields += `, aprobado_por = $${paramCount}, fecha_aprobacion = CURRENT_TIMESTAMP`;
      params.push(req.user.id);
    }

    if (estado === 'pagada') {
      paramCount++;
      updateFields += `, pagado_por = $${paramCount}, fecha_pago = CURRENT_TIMESTAMP`;
      params.push(req.user.id);

      // Crear gasto automaticamente con el monto total
      const gastoResult = await query(`
        INSERT INTO project_expenses (
          project_id, descripcion, monto, fecha, tipo_gasto, created_by
        ) VALUES ($1, $2, $3, CURRENT_DATE, 'real', $4)
        RETURNING id
      `, [
        requisicion.project_id,
        `Requisicion ${requisicion.numero}: ${requisicion.concepto || requisicion.proveedor}`,
        requisicion.monto_total,
        req.user.id
      ]);

      paramCount++;
      updateFields += `, expense_id = $${paramCount}`;
      params.push(gastoResult.rows[0].id);
    }

    // Agregar id al final
    paramCount++;
    params.push(id);

    const result = await query(`
      UPDATE requisiciones SET ${updateFields}
      WHERE id = $${paramCount}
      RETURNING *
    `, params);

    // Registrar en historial
    await query(`
      INSERT INTO requisiciones_historial (requisicion_id, estado_anterior, estado_nuevo, usuario_id, comentario)
      VALUES ($1, $2, $3, $4, $5)
    `, [id, estadoAnterior, estado, req.user.id, comentario || null]);

    res.json({
      success: true,
      message: `Requisicion cambiada a "${estado}"`,
      requisicion: result.rows[0]
    });

  } catch (error) {
    console.error('Error changing requisicion estado:', error);
    res.status(500).json({
      success: false,
      message: 'Error al cambiar estado de requisicion'
    });
  }
});

// ===============================
// DELETE - Eliminar requisicion
// ===============================

// Archivar requisicion (soft delete)
router.patch('/:id/archivar', authenticateToken, requireManager, [
  param('id').isInt().withMessage('ID de requisicion invalido')
], async (req, res) => {
  try {
    const { id } = req.params;

    // Verificar que existe
    const existing = await query('SELECT * FROM requisiciones WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Requisicion no encontrada'
      });
    }

    if (existing.rows[0].archivada) {
      return res.status(400).json({
        success: false,
        message: 'La requisicion ya esta archivada'
      });
    }

    // Archivar (soft delete)
    await query(`
      UPDATE requisiciones
      SET archivada = TRUE,
          fecha_archivado = CURRENT_TIMESTAMP,
          archivado_por = $2
      WHERE id = $1
    `, [id, req.user.id]);

    // Registrar en historial
    await query(`
      INSERT INTO requisiciones_historial (requisicion_id, estado_anterior, estado_nuevo, usuario_id, comentario)
      VALUES ($1, $2, 'archivada', $3, 'Requisicion archivada')
    `, [id, existing.rows[0].estado, req.user.id]);

    res.json({
      success: true,
      message: 'Requisicion archivada exitosamente'
    });

  } catch (error) {
    console.error('Error archivando requisicion:', error);
    res.status(500).json({
      success: false,
      message: 'Error al archivar requisicion'
    });
  }
});

// Restaurar requisicion archivada
router.patch('/:id/restaurar', authenticateToken, requireManager, [
  param('id').isInt().withMessage('ID de requisicion invalido')
], async (req, res) => {
  try {
    const { id } = req.params;

    // Verificar que existe y esta archivada
    const existing = await query('SELECT * FROM requisiciones WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Requisicion no encontrada'
      });
    }

    if (!existing.rows[0].archivada) {
      return res.status(400).json({
        success: false,
        message: 'La requisicion no esta archivada'
      });
    }

    // Restaurar
    await query(`
      UPDATE requisiciones
      SET archivada = FALSE,
          fecha_archivado = NULL,
          archivado_por = NULL
      WHERE id = $1
    `, [id]);

    res.json({
      success: true,
      message: 'Requisicion restaurada exitosamente'
    });

  } catch (error) {
    console.error('Error restaurando requisicion:', error);
    res.status(500).json({
      success: false,
      message: 'Error al restaurar requisicion'
    });
  }
});

// Eliminar permanentemente (solo para casos especiales)
router.delete('/:id', authenticateToken, requireManager, [
  param('id').isInt().withMessage('ID de requisicion invalido')
], async (req, res) => {
  try {
    const { id } = req.params;

    // Verificar que existe y esta en estado eliminable
    const existing = await query('SELECT * FROM requisiciones WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Requisicion no encontrada'
      });
    }

    if (!['pendiente', 'rechazada'].includes(existing.rows[0].estado)) {
      return res.status(400).json({
        success: false,
        message: 'Solo se pueden eliminar requisiciones pendientes o rechazadas'
      });
    }

    // Los items se eliminan automaticamente por ON DELETE CASCADE
    await query('DELETE FROM requisiciones WHERE id = $1', [id]);

    res.json({
      success: true,
      message: 'Requisicion eliminada permanentemente'
    });

  } catch (error) {
    console.error('Error deleting requisicion:', error);
    res.status(500).json({
      success: false,
      message: 'Error al eliminar requisicion'
    });
  }
});

// ===============================
// Buscar items (para reportes/analisis)
// ===============================

router.get('/items/search', authenticateToken, async (req, res) => {
  try {
    const { q, project_id, categoria_id } = req.query;

    let whereClause = 'WHERE 1=1';
    const params = [];
    let paramCount = 0;

    if (q) {
      paramCount++;
      whereClause += ` AND ri.descripcion ILIKE $${paramCount}`;
      params.push(`%${q}%`);
    }

    if (project_id) {
      paramCount++;
      whereClause += ` AND r.project_id = $${paramCount}`;
      params.push(project_id);
    }

    if (categoria_id) {
      paramCount++;
      whereClause += ` AND ri.categoria_id = $${paramCount}`;
      params.push(categoria_id);
    }

    const result = await query(`
      SELECT
        ri.*,
        r.numero as requisicion_numero,
        r.proveedor,
        r.estado as requisicion_estado,
        r.fecha as requisicion_fecha,
        p.nombre as proyecto_nombre,
        p.nombre_corto as proyecto_corto,
        pec.nombre as categoria_nombre
      FROM requisicion_items ri
      JOIN requisiciones r ON ri.requisicion_id = r.id
      LEFT JOIN proyectos p ON r.project_id = p.id
      LEFT JOIN project_expense_categories pec ON ri.categoria_id = pec.id
      ${whereClause}
      ORDER BY r.fecha DESC, ri.id
      LIMIT 100
    `, params);

    res.json({
      success: true,
      items: result.rows
    });

  } catch (error) {
    console.error('Error searching items:', error);
    res.status(500).json({
      success: false,
      message: 'Error al buscar items'
    });
  }
});

module.exports = router;
