import { Router, Request, Response } from 'express';
import { query } from '../database/config.js';
import { authenticateToken } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import type { UserRole } from '../types/auth.js';
import type { MemberRole } from '../types/models.js';

const router = Router();

interface ProjectMemberRow {
  id: number;
  project_id: number;
  user_id?: number;
  external_contact_id?: number;
  tipo_miembro: 'usuario' | 'externo';
  rol_proyecto: MemberRole;
  activo: boolean;
  created_at: Date;
  usuario_nombre?: string;
  usuario_email?: string;
  externo_nombre?: string;
  externo_cargo?: string;
  externo_telefono?: string;
  externo_email?: string;
  nombre_display: string;
}

interface UserRow {
  id: number;
  nombre: string;
  email: string;
  rol: UserRole;
}

interface ExternalContactRow {
  id: number;
  nombre: string;
  cargo?: string;
  telefono?: string;
  email?: string;
}

interface AddMemberBody {
  project_id: number;
  user_id: number;
  rol_proyecto?: MemberRole;
}

interface AddExternalMemberBody {
  project_id: number;
  external_contact_id: number;
  rol_proyecto?: MemberRole;
}

// GET - Obtener miembros de un proyecto (usuarios del sistema + contactos externos)
router.get('/project/:projectId', authenticateToken, asyncHandler(async (req: Request<{ projectId: string }>, res: Response): Promise<void> => {
  const { projectId } = req.params;

  const result = await query<ProjectMemberRow>(`
    SELECT
      pm.id,
      pm.project_id,
      pm.user_id,
      pm.external_contact_id,
      pm.tipo_miembro,
      pm.rol_proyecto,
      pm.activo,
      pm.created_at,
      u.nombre as usuario_nombre,
      u.email as usuario_email,
      ec.nombre as externo_nombre,
      ec.cargo as externo_cargo,
      ec.telefono as externo_telefono,
      ec.email as externo_email,
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
}));

// GET - Obtener todos los usuarios del sistema (para agregar miembros)
router.get('/users', authenticateToken, asyncHandler(async (_req: Request, res: Response): Promise<void> => {
  const result = await query<UserRow>(`
    SELECT id, nombre, email, rol
    FROM users
    WHERE activo = true AND (tipo_usuario = 'interno' OR tipo_usuario IS NULL)
    ORDER BY nombre
  `);

  res.json({
    success: true,
    users: result.rows
  });
}));

// GET - Obtener contactos externos activos (para agregar como miembros)
router.get('/external-contacts', authenticateToken, asyncHandler(async (_req: Request, res: Response): Promise<void> => {
  const result = await query<ExternalContactRow>(`
    SELECT id, nombre, cargo, telefono, email
    FROM external_contacts
    WHERE activo = true
    ORDER BY nombre
  `);

  res.json({
    success: true,
    contacts: result.rows
  });
}));

// POST - Agregar miembro a proyecto (usuario del sistema)
router.post('/', authenticateToken, asyncHandler(async (req: Request<object, object, AddMemberBody>, res: Response): Promise<void> => {
  const { project_id, user_id, rol_proyecto } = req.body;

  if (!project_id || !user_id) {
    res.status(400).json({
      success: false,
      message: 'project_id y user_id son requeridos'
    });
    return;
  }

  // Verificar si ya existe como miembro activo
  const existingCheck = await query<{ id: number }>(`
    SELECT id FROM project_members
    WHERE project_id = $1 AND user_id = $2 AND tipo_miembro = 'usuario' AND activo = true
  `, [project_id, user_id]);

  if (existingCheck.rows.length > 0) {
    res.status(400).json({
      success: false,
      message: 'El usuario ya es miembro de este proyecto'
    });
    return;
  }

  // Insertar o reactivar
  const result = await query<ProjectMemberRow>(`
    INSERT INTO project_members (project_id, user_id, tipo_miembro, rol_proyecto)
    VALUES ($1, $2, 'usuario', $3)
    ON CONFLICT ON CONSTRAINT project_members_pkey DO NOTHING
    RETURNING *
  `, [project_id, user_id, rol_proyecto || 'miembro']);

  // Si no se inserto, intentar reactivar
  if (result.rows.length === 0) {
    const updateResult = await query<ProjectMemberRow>(`
      UPDATE project_members
      SET activo = true, rol_proyecto = $3, updated_at = CURRENT_TIMESTAMP
      WHERE project_id = $1 AND user_id = $2 AND tipo_miembro = 'usuario'
      RETURNING *
    `, [project_id, user_id, rol_proyecto || 'miembro']);

    res.status(201).json({
      success: true,
      member: updateResult.rows[0],
      message: 'Miembro agregado exitosamente'
    });
    return;
  }

  res.status(201).json({
    success: true,
    member: result.rows[0],
    message: 'Miembro agregado exitosamente'
  });
}));

// POST - Agregar contacto externo como miembro del proyecto
router.post('/external', authenticateToken, asyncHandler(async (req: Request<object, object, AddExternalMemberBody>, res: Response): Promise<void> => {
  const { project_id, external_contact_id, rol_proyecto } = req.body;

  if (!project_id || !external_contact_id) {
    res.status(400).json({
      success: false,
      message: 'project_id y external_contact_id son requeridos'
    });
    return;
  }

  // Verificar si ya existe como miembro activo
  const existingCheck = await query<{ id: number }>(`
    SELECT id FROM project_members
    WHERE project_id = $1 AND external_contact_id = $2 AND tipo_miembro = 'externo' AND activo = true
  `, [project_id, external_contact_id]);

  if (existingCheck.rows.length > 0) {
    res.status(400).json({
      success: false,
      message: 'El contacto externo ya es miembro de este proyecto'
    });
    return;
  }

  // Insertar nuevo miembro externo
  const result = await query<ProjectMemberRow>(`
    INSERT INTO project_members (project_id, external_contact_id, tipo_miembro, rol_proyecto)
    VALUES ($1, $2, 'externo', $3)
    RETURNING *
  `, [project_id, external_contact_id, rol_proyecto || 'miembro']);

  // Obtener datos completos del contacto
  const memberData = await query<ProjectMemberRow>(`
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
}));

// PUT - Actualizar rol de un miembro
router.put('/:id', authenticateToken, asyncHandler(async (req: Request<{ id: string }, object, { rol_proyecto: MemberRole }>, res: Response): Promise<void> => {
  const { id } = req.params;
  const { rol_proyecto } = req.body;

  const result = await query<ProjectMemberRow>(`
    UPDATE project_members
    SET rol_proyecto = $1, updated_at = CURRENT_TIMESTAMP
    WHERE id = $2
    RETURNING *
  `, [rol_proyecto, id]);

  if (result.rows.length === 0) {
    res.status(404).json({
      success: false,
      message: 'Miembro no encontrado'
    });
    return;
  }

  res.json({
    success: true,
    member: result.rows[0],
    message: 'Rol actualizado'
  });
}));

// DELETE - Remover miembro de proyecto (soft delete)
router.delete('/:id', authenticateToken, asyncHandler(async (req: Request<{ id: string }>, res: Response): Promise<void> => {
  const { id } = req.params;

  const result = await query<ProjectMemberRow>(`
    UPDATE project_members
    SET activo = false, updated_at = CURRENT_TIMESTAMP
    WHERE id = $1
    RETURNING *
  `, [id]);

  if (result.rows.length === 0) {
    res.status(404).json({
      success: false,
      message: 'Miembro no encontrado'
    });
    return;
  }

  res.json({
    success: true,
    message: 'Miembro removido del proyecto'
  });
}));

export default router;
