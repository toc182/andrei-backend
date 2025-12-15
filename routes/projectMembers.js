const express = require('express');
const router = express.Router();
const { query } = require('../database/config');
const { authenticateToken } = require('../middleware/auth');

// GET - Obtener miembros de un proyecto (usuarios del sistema + contactos externos)
router.get('/project/:projectId', authenticateToken, async (req, res) => {
  try {
    const { projectId } = req.params;

    const result = await query(`
      SELECT
        pm.id,
        pm.project_id,
        pm.user_id,
        pm.external_contact_id,
        pm.tipo_miembro,
        pm.rol_proyecto,
        pm.activo,
        pm.created_at,
        -- Datos del usuario (si es tipo usuario)
        u.nombre as usuario_nombre,
        u.email as usuario_email,
        -- Datos del contacto externo (si es tipo externo)
        ec.nombre as externo_nombre,
        ec.cargo as externo_cargo,
        ec.telefono as externo_telefono,
        ec.email as externo_email,
        -- Campo unificado para mostrar nombre
        COALESCE(u.nombre, ec.nombre) as nombre_display
      FROM project_members pm
      LEFT JOIN users u ON pm.user_id = u.id AND pm.tipo_miembro = 'usuario'
      LEFT JOIN external_contacts ec ON pm.external_contact_id = ec.id AND pm.tipo_miembro = 'externo'
      WHERE pm.project_id = $1 AND pm.activo = true
      ORDER BY COALESCE(u.nombre, ec.nombre)
    `, [projectId]);

    res.json({
      success: true,
      members: result.rows
    });

  } catch (error) {
    console.error('Error fetching project members:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener miembros del proyecto'
    });
  }
});

// GET - Obtener todos los usuarios del sistema (para agregar miembros)
router.get('/users', authenticateToken, async (req, res) => {
  try {
    const result = await query(`
      SELECT id, nombre, email, rol
      FROM users
      WHERE activo = true
      ORDER BY nombre
    `);

    res.json({
      success: true,
      users: result.rows
    });

  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener usuarios'
    });
  }
});

// GET - Obtener contactos externos activos (para agregar como miembros)
router.get('/external-contacts', authenticateToken, async (req, res) => {
  try {
    const result = await query(`
      SELECT id, nombre, cargo, telefono, email
      FROM external_contacts
      WHERE activo = true
      ORDER BY nombre
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

// POST - Agregar miembro a proyecto (usuario del sistema)
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { project_id, user_id, rol_proyecto } = req.body;

    if (!project_id || !user_id) {
      return res.status(400).json({
        success: false,
        message: 'project_id y user_id son requeridos'
      });
    }

    // Verificar si ya existe como miembro activo
    const existingCheck = await query(`
      SELECT id FROM project_members
      WHERE project_id = $1 AND user_id = $2 AND tipo_miembro = 'usuario' AND activo = true
    `, [project_id, user_id]);

    if (existingCheck.rows.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'El usuario ya es miembro de este proyecto'
      });
    }

    // Insertar o reactivar
    const result = await query(`
      INSERT INTO project_members (project_id, user_id, tipo_miembro, rol_proyecto)
      VALUES ($1, $2, 'usuario', $3)
      ON CONFLICT ON CONSTRAINT project_members_pkey DO NOTHING
      RETURNING *
    `, [project_id, user_id, rol_proyecto || 'miembro']);

    // Si no se inserto, intentar reactivar
    if (result.rows.length === 0) {
      const updateResult = await query(`
        UPDATE project_members
        SET activo = true, rol_proyecto = $3, updated_at = CURRENT_TIMESTAMP
        WHERE project_id = $1 AND user_id = $2 AND tipo_miembro = 'usuario'
        RETURNING *
      `, [project_id, user_id, rol_proyecto || 'miembro']);

      return res.status(201).json({
        success: true,
        member: updateResult.rows[0],
        message: 'Miembro agregado exitosamente'
      });
    }

    res.status(201).json({
      success: true,
      member: result.rows[0],
      message: 'Miembro agregado exitosamente'
    });

  } catch (error) {
    console.error('Error adding project member:', error);
    res.status(500).json({
      success: false,
      message: 'Error al agregar miembro'
    });
  }
});

// POST - Agregar contacto externo como miembro del proyecto
router.post('/external', authenticateToken, async (req, res) => {
  try {
    const { project_id, external_contact_id, rol_proyecto } = req.body;

    if (!project_id || !external_contact_id) {
      return res.status(400).json({
        success: false,
        message: 'project_id y external_contact_id son requeridos'
      });
    }

    // Verificar si ya existe como miembro activo
    const existingCheck = await query(`
      SELECT id FROM project_members
      WHERE project_id = $1 AND external_contact_id = $2 AND tipo_miembro = 'externo' AND activo = true
    `, [project_id, external_contact_id]);

    if (existingCheck.rows.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'El contacto externo ya es miembro de este proyecto'
      });
    }

    // Insertar nuevo miembro externo
    const result = await query(`
      INSERT INTO project_members (project_id, external_contact_id, tipo_miembro, rol_proyecto)
      VALUES ($1, $2, 'externo', $3)
      RETURNING *
    `, [project_id, external_contact_id, rol_proyecto || 'miembro']);

    // Obtener datos completos del contacto
    const memberData = await query(`
      SELECT
        pm.id,
        pm.project_id,
        pm.external_contact_id,
        pm.tipo_miembro,
        pm.rol_proyecto,
        pm.activo,
        ec.nombre as externo_nombre,
        ec.cargo as externo_cargo,
        ec.telefono as externo_telefono,
        ec.email as externo_email,
        ec.nombre as nombre_display
      FROM project_members pm
      JOIN external_contacts ec ON pm.external_contact_id = ec.id
      WHERE pm.id = $1
    `, [result.rows[0].id]);

    res.status(201).json({
      success: true,
      member: memberData.rows[0],
      message: 'Contacto externo agregado como miembro'
    });

  } catch (error) {
    console.error('Error adding external member:', error);
    res.status(500).json({
      success: false,
      message: 'Error al agregar contacto externo como miembro'
    });
  }
});

// PUT - Actualizar rol de un miembro
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { rol_proyecto } = req.body;

    const result = await query(`
      UPDATE project_members
      SET rol_proyecto = $1, updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
      RETURNING *
    `, [rol_proyecto, id]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Miembro no encontrado'
      });
    }

    res.json({
      success: true,
      member: result.rows[0],
      message: 'Rol actualizado'
    });

  } catch (error) {
    console.error('Error updating project member:', error);
    res.status(500).json({
      success: false,
      message: 'Error al actualizar miembro'
    });
  }
});

// DELETE - Remover miembro de proyecto (soft delete)
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await query(`
      UPDATE project_members
      SET activo = false, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Miembro no encontrado'
      });
    }

    res.json({
      success: true,
      message: 'Miembro removido del proyecto'
    });

  } catch (error) {
    console.error('Error removing project member:', error);
    res.status(500).json({
      success: false,
      message: 'Error al remover miembro'
    });
  }
});

module.exports = router;
