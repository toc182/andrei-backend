const express = require('express');
const router = express.Router();
const { query } = require('../database/config');
const { authenticateToken } = require('../middleware/auth');

// GET - Obtener todos los contactos externos
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { activo } = req.query;

    let whereClause = '';
    if (activo === 'true') {
      whereClause = 'WHERE ec.activo = true';
    } else if (activo === 'false') {
      whereClause = 'WHERE ec.activo = false';
    }

    const result = await query(`
      SELECT
        ec.id,
        ec.nombre,
        ec.cargo,
        ec.telefono,
        ec.email,
        ec.notas,
        ec.activo,
        ec.created_at,
        ec.updated_at,
        ec.created_by,
        u.nombre as creado_por_nombre
      FROM external_contacts ec
      LEFT JOIN users u ON ec.created_by = u.id
      ${whereClause}
      ORDER BY ec.nombre
    `);

    res.json({
      success: true,
      contacts: result.rows
    });

  } catch (error) {
    console.error('Error fetching external contacts:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener contactos externos'
    });
  }
});

// GET - Obtener un contacto externo por ID
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await query(`
      SELECT
        ec.id,
        ec.nombre,
        ec.cargo,
        ec.telefono,
        ec.email,
        ec.notas,
        ec.activo,
        ec.created_at,
        ec.updated_at,
        ec.created_by,
        u.nombre as creado_por_nombre
      FROM external_contacts ec
      LEFT JOIN users u ON ec.created_by = u.id
      WHERE ec.id = $1
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Contacto no encontrado'
      });
    }

    res.json({
      success: true,
      contact: result.rows[0]
    });

  } catch (error) {
    console.error('Error fetching external contact:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener contacto externo'
    });
  }
});

// POST - Crear nuevo contacto externo
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { nombre, cargo, telefono, email, notas } = req.body;
    const created_by = req.user.id;

    if (!nombre || nombre.trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'El nombre es requerido'
      });
    }

    const result = await query(`
      INSERT INTO external_contacts (nombre, cargo, telefono, email, notas, created_by)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [nombre.trim(), cargo?.trim() || null, telefono?.trim() || null, email?.trim() || null, notas?.trim() || null, created_by]);

    res.status(201).json({
      success: true,
      contact: result.rows[0],
      message: 'Contacto creado exitosamente'
    });

  } catch (error) {
    console.error('Error creating external contact:', error);
    res.status(500).json({
      success: false,
      message: 'Error al crear contacto externo'
    });
  }
});

// PUT - Actualizar contacto externo
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { nombre, cargo, telefono, email, notas } = req.body;

    if (!nombre || nombre.trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'El nombre es requerido'
      });
    }

    const result = await query(`
      UPDATE external_contacts
      SET
        nombre = $1,
        cargo = $2,
        telefono = $3,
        email = $4,
        notas = $5,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $6
      RETURNING *
    `, [nombre.trim(), cargo?.trim() || null, telefono?.trim() || null, email?.trim() || null, notas?.trim() || null, id]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Contacto no encontrado'
      });
    }

    res.json({
      success: true,
      contact: result.rows[0],
      message: 'Contacto actualizado exitosamente'
    });

  } catch (error) {
    console.error('Error updating external contact:', error);
    res.status(500).json({
      success: false,
      message: 'Error al actualizar contacto externo'
    });
  }
});

// DELETE - Eliminar contacto externo (soft delete)
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    // Verificar si el contacto tiene asignaciones activas
    const assignmentsCheck = await query(`
      SELECT COUNT(*) as count
      FROM project_members
      WHERE external_contact_id = $1 AND activo = true
    `, [id]);

    if (parseInt(assignmentsCheck.rows[0].count) > 0) {
      return res.status(400).json({
        success: false,
        message: 'No se puede eliminar: el contacto tiene asignaciones activas en proyectos'
      });
    }

    const result = await query(`
      UPDATE external_contacts
      SET activo = false, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Contacto no encontrado'
      });
    }

    res.json({
      success: true,
      message: 'Contacto eliminado exitosamente'
    });

  } catch (error) {
    console.error('Error deleting external contact:', error);
    res.status(500).json({
      success: false,
      message: 'Error al eliminar contacto externo'
    });
  }
});

// PATCH - Restaurar contacto externo
router.patch('/:id/restaurar', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await query(`
      UPDATE external_contacts
      SET activo = true, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Contacto no encontrado'
      });
    }

    res.json({
      success: true,
      contact: result.rows[0],
      message: 'Contacto restaurado exitosamente'
    });

  } catch (error) {
    console.error('Error restoring external contact:', error);
    res.status(500).json({
      success: false,
      message: 'Error al restaurar contacto externo'
    });
  }
});

module.exports = router;
