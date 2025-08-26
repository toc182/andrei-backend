const express = require('express');
const router = express.Router();
const { query } = require('../database/config');
const { authenticateToken } = require('../middleware/auth');

// Obtener todos los clientes
router.get('/', authenticateToken, async (req, res) => {
  try {
    const result = await query(`
      SELECT * FROM clientes 
      WHERE activo = true 
      ORDER BY nombre ASC
    `);

    res.json({
      success: true,
      clientes: result.rows
    });

  } catch (error) {
    console.error('Error obteniendo clientes:', error);
    
    // If clientes table doesn't exist, return empty array
    if (error.message.includes('relation "clientes" does not exist')) {
      console.log('⚠️ Clientes table not found, returning empty list');
      return res.json({
        success: true,
        clientes: []
      });
    }

    res.status(500).json({
      success: false,
      message: 'Error interno del servidor'
    });
  }
});

// Obtener un cliente por ID
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await query(`
      SELECT * FROM clientes 
      WHERE id = $1 AND activo = true
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Cliente no encontrado'
      });
    }

    res.json({
      success: true,
      cliente: result.rows[0]
    });

  } catch (error) {
    console.error('Error obteniendo cliente:', error);
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor'
    });
  }
});

// Crear nuevo cliente
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { nombre, abreviatura, contacto, telefono, email, direccion } = req.body;

    // Validar campos requeridos
    if (!nombre) {
      return res.status(400).json({
        success: false,
        message: 'El nombre del cliente es requerido'
      });
    }

    // Verificar si ya existe un cliente con el mismo nombre
    const existingCliente = await query(`
      SELECT id FROM clientes 
      WHERE nombre = $1 AND activo = true
    `, [nombre]);

    if (existingCliente.rows.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Ya existe un cliente con ese nombre'
      });
    }

    // Verificar si la abreviatura ya existe (si se proporciona)
    if (abreviatura) {
      const existingAbrev = await query(`
        SELECT id FROM clientes 
        WHERE abreviatura = $1 AND activo = true
      `, [abreviatura]);

      if (existingAbrev.rows.length > 0) {
        return res.status(400).json({
          success: false,
          message: 'Ya existe un cliente con esa abreviatura'
        });
      }
    }

    // Crear el cliente
    const result = await query(`
      INSERT INTO clientes (nombre, abreviatura, contacto, telefono, email, direccion)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [nombre, abreviatura || null, contacto || null, telefono || null, email || null, direccion || null]);

    res.status(201).json({
      success: true,
      cliente: result.rows[0],
      message: 'Cliente creado exitosamente'
    });

  } catch (error) {
    console.error('Error creando cliente:', error);
    
    // Manejar errores de duplicados
    if (error.code === '23505') {
      if (error.detail && error.detail.includes('email')) {
        return res.status(400).json({
          success: false,
          message: 'Ya existe un cliente con ese email'
        });
      }
      if (error.detail && error.detail.includes('abreviatura')) {
        return res.status(400).json({
          success: false,
          message: 'Ya existe un cliente con esa abreviatura'
        });
      }
    }

    res.status(500).json({
      success: false,
      message: 'Error interno del servidor'
    });
  }
});

// Actualizar cliente
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { nombre, abreviatura, contacto, telefono, email, direccion } = req.body;

    // Validar campos requeridos
    if (!nombre) {
      return res.status(400).json({
        success: false,
        message: 'El nombre del cliente es requerido'
      });
    }

    // Verificar que el cliente existe
    const existingCliente = await query(`
      SELECT id FROM clientes 
      WHERE id = $1 AND activo = true
    `, [id]);

    if (existingCliente.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Cliente no encontrado'
      });
    }

    // Verificar si ya existe otro cliente con el mismo nombre
    const duplicateCliente = await query(`
      SELECT id FROM clientes 
      WHERE nombre = $1 AND id != $2 AND activo = true
    `, [nombre, id]);

    if (duplicateCliente.rows.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Ya existe otro cliente con ese nombre'
      });
    }

    // Verificar si ya existe otro cliente con la misma abreviatura (si se proporciona)
    if (abreviatura) {
      const duplicateAbrev = await query(`
        SELECT id FROM clientes 
        WHERE abreviatura = $1 AND id != $2 AND activo = true
      `, [abreviatura, id]);

      if (duplicateAbrev.rows.length > 0) {
        return res.status(400).json({
          success: false,
          message: 'Ya existe otro cliente con esa abreviatura'
        });
      }
    }

    // Actualizar el cliente
    const result = await query(`
      UPDATE clientes 
      SET nombre = $1, abreviatura = $2, contacto = $3, telefono = $4, email = $5, direccion = $6, updated_at = CURRENT_TIMESTAMP
      WHERE id = $7
      RETURNING *
    `, [nombre, abreviatura || null, contacto || null, telefono || null, email || null, direccion || null, id]);

    res.json({
      success: true,
      cliente: result.rows[0],
      message: 'Cliente actualizado exitosamente'
    });

  } catch (error) {
    console.error('Error actualizando cliente:', error);
    
    // Manejar errores de duplicados
    if (error.code === '23505') {
      if (error.detail && error.detail.includes('email')) {
        return res.status(400).json({
          success: false,
          message: 'Ya existe otro cliente con ese email'
        });
      }
      if (error.detail && error.detail.includes('abreviatura')) {
        return res.status(400).json({
          success: false,
          message: 'Ya existe otro cliente con esa abreviatura'
        });
      }
    }

    res.status(500).json({
      success: false,
      message: 'Error interno del servidor'
    });
  }
});

// Eliminar cliente (soft delete)
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    // Verificar que el cliente existe
    const existingCliente = await query(`
      SELECT id FROM clientes 
      WHERE id = $1 AND activo = true
    `, [id]);

    if (existingCliente.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Cliente no encontrado'
      });
    }

    // Verificar si el cliente tiene proyectos asociados
    const projectsCheck = await query(`
      SELECT id FROM proyectos 
      WHERE cliente_id = $1 AND activo = true
    `, [id]);

    if (projectsCheck.rows.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'No se puede eliminar el cliente porque tiene proyectos asociados'
      });
    }

    // Soft delete del cliente
    await query(`
      UPDATE clientes 
      SET activo = false, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
    `, [id]);

    res.json({
      success: true,
      message: 'Cliente eliminado exitosamente'
    });

  } catch (error) {
    console.error('Error eliminando cliente:', error);
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor'
    });
  }
});

// Obtener estadísticas de clientes
router.get('/stats/dashboard', authenticateToken, async (req, res) => {
  try {
    const stats = await query(`
      SELECT 
        COUNT(*) as total_clientes,
        COUNT(CASE WHEN created_at >= CURRENT_DATE - INTERVAL '30 days' THEN 1 END) as nuevos_mes,
        COUNT(CASE WHEN email IS NOT NULL AND email != '' THEN 1 END) as con_email,
        COUNT(CASE WHEN telefono IS NOT NULL AND telefono != '' THEN 1 END) as con_telefono,
        COUNT(CASE WHEN abreviatura IS NOT NULL AND abreviatura != '' THEN 1 END) as con_abreviatura
      FROM clientes 
      WHERE activo = true
    `);

    res.json({
      success: true,
      stats: stats.rows[0]
    });

  } catch (error) {
    console.error('Error obteniendo estadísticas de clientes:', error);
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor'
    });
  }
});

module.exports = router;