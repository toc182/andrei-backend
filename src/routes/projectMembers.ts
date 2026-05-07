import { Router, Request, Response } from 'express';
import { query } from '../database/config.js';
import { authenticateToken } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import type { UserRole } from '../types/auth.js';
import type { MemberRole } from '../types/models.js';

const router = Router();

interface ProjectMemberRow {
  id: number;
  proyecto_id: number;
  user_id?: number;
  contacto_externo_id?: number;
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
  tipo_usuario: string | null;
}

interface ExternalContactRow {
  id: number;
  nombre: string;
  cargo?: string;
  telefono?: string;
  email?: string;
}

interface AddMemberBody {
  proyecto_id: number;
  user_id: number;
  rol_proyecto?: MemberRole;
}

interface AddExternalMemberBody {
  proyecto_id: number;
  contacto_externo_id: number;
  rol_proyecto?: MemberRole;
}

// GET - Obtener miembros de un proyecto (usuarios del sistema + contactos externos)
router.get(
  '/project/:projectId',
  authenticateToken,
  asyncHandler(
    async (
      req: Request<{ projectId: string }>,
      res: Response,
    ): Promise<void> => {
      const { projectId } = req.params;

      const result = await query<ProjectMemberRow>(
        `
    SELECT
      pm.id,
      pm.proyecto_id,
      pm.user_id,
      pm.contacto_externo_id,
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
      COALESCE(u.nombre, ec.nombre) as nombre_display,
      u.tipo_usuario
    FROM proyecto_miembros pm
    LEFT JOIN users u ON pm.user_id = u.id AND pm.tipo_miembro = 'usuario'
    LEFT JOIN contactos_externos ec ON pm.contacto_externo_id = ec.id AND pm.tipo_miembro = 'externo'
    WHERE pm.proyecto_id = $1 AND pm.activo = true
    ORDER BY COALESCE(u.nombre, ec.nombre)
  `,
        [projectId],
      );

      res.json({
        success: true,
        members: result.rows,
      });
    },
  ),
);

// GET - Obtener todos los usuarios del sistema (para agregar miembros)
router.get(
  '/users',
  authenticateToken,
  asyncHandler(async (_req: Request, res: Response): Promise<void> => {
    const result = await query<UserRow>(`
    SELECT id, nombre, email, rol, tipo_usuario
    FROM users
    WHERE activo = true
    ORDER BY nombre
  `);

    res.json({
      success: true,
      users: result.rows,
    });
  }),
);

// GET - Obtener contactos externos activos (para agregar como miembros)
router.get(
  '/external-contacts',
  authenticateToken,
  asyncHandler(async (_req: Request, res: Response): Promise<void> => {
    const result = await query<ExternalContactRow>(`
    SELECT id, nombre, cargo, telefono, email
    FROM contactos_externos
    WHERE activo = true
    ORDER BY nombre
  `);

    res.json({
      success: true,
      contacts: result.rows,
    });
  }),
);

// POST - Agregar miembro a proyecto (usuario del sistema)
router.post(
  '/',
  authenticateToken,
  asyncHandler(
    async (
      req: Request<object, object, AddMemberBody>,
      res: Response,
    ): Promise<void> => {
      const { proyecto_id, user_id, rol_proyecto } = req.body;

      if (!proyecto_id || !user_id) {
        res.status(400).json({
          success: false,
          message: 'proyecto_id y user_id son requeridos',
        });
        return;
      }

      // Buscar fila existente (activa o inactiva) para este usuario y proyecto
      const existing = await query<{ id: number; activo: boolean }>(
        `
    SELECT id, activo FROM proyecto_miembros
    WHERE proyecto_id = $1 AND user_id = $2 AND tipo_miembro = 'usuario'
  `,
        [proyecto_id, user_id],
      );

      if (existing.rows.length > 0 && existing.rows[0].activo) {
        res.status(400).json({
          success: false,
          message: 'El usuario ya es miembro de este proyecto',
        });
        return;
      }

      let memberRow: ProjectMemberRow;
      if (existing.rows.length > 0) {
        // Reactivar miembro previamente removido
        const updateResult = await query<ProjectMemberRow>(
          `
      UPDATE proyecto_miembros
      SET activo = true, rol_proyecto = $3, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND proyecto_id = $2
      RETURNING *
    `,
          [existing.rows[0].id, proyecto_id, rol_proyecto || 'miembro'],
        );
        memberRow = updateResult.rows[0];
      } else {
        // Insertar nuevo miembro
        const insertResult = await query<ProjectMemberRow>(
          `
      INSERT INTO proyecto_miembros (proyecto_id, user_id, tipo_miembro, rol_proyecto)
      VALUES ($1, $2, 'usuario', $3)
      RETURNING *
    `,
          [proyecto_id, user_id, rol_proyecto || 'miembro'],
        );
        memberRow = insertResult.rows[0];
      }

      res.status(201).json({
        success: true,
        member: memberRow,
        message: 'Miembro agregado exitosamente',
      });
    },
  ),
);

// POST - Agregar contacto externo como miembro del proyecto
router.post(
  '/external',
  authenticateToken,
  asyncHandler(
    async (
      req: Request<object, object, AddExternalMemberBody>,
      res: Response,
    ): Promise<void> => {
      const { proyecto_id, contacto_externo_id, rol_proyecto } = req.body;

      if (!proyecto_id || !contacto_externo_id) {
        res.status(400).json({
          success: false,
          message: 'proyecto_id y contacto_externo_id son requeridos',
        });
        return;
      }

      // Buscar fila existente (activa o inactiva) para este contacto externo y proyecto
      const existing = await query<{ id: number; activo: boolean }>(
        `
    SELECT id, activo FROM proyecto_miembros
    WHERE proyecto_id = $1 AND contacto_externo_id = $2 AND tipo_miembro = 'externo'
  `,
        [proyecto_id, contacto_externo_id],
      );

      if (existing.rows.length > 0 && existing.rows[0].activo) {
        res.status(400).json({
          success: false,
          message: 'El contacto externo ya es miembro de este proyecto',
        });
        return;
      }

      let result: { rows: ProjectMemberRow[] };
      if (existing.rows.length > 0) {
        // Reactivar contacto externo previamente removido
        result = await query<ProjectMemberRow>(
          `
      UPDATE proyecto_miembros
      SET activo = true, rol_proyecto = $2, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *
    `,
          [existing.rows[0].id, rol_proyecto || 'miembro'],
        );
      } else {
        // Insertar nuevo miembro externo
        result = await query<ProjectMemberRow>(
          `
      INSERT INTO proyecto_miembros (proyecto_id, contacto_externo_id, tipo_miembro, rol_proyecto)
      VALUES ($1, $2, 'externo', $3)
      RETURNING *
    `,
          [proyecto_id, contacto_externo_id, rol_proyecto || 'miembro'],
        );
      }

      // Obtener datos completos del contacto
      const memberData = await query<ProjectMemberRow>(
        `
    SELECT
      pm.id,
      pm.proyecto_id,
      pm.contacto_externo_id,
      pm.tipo_miembro,
      pm.rol_proyecto,
      pm.activo,
      ec.nombre as externo_nombre,
      ec.cargo as externo_cargo,
      ec.telefono as externo_telefono,
      ec.email as externo_email,
      ec.nombre as nombre_display
    FROM proyecto_miembros pm
    JOIN contactos_externos ec ON pm.contacto_externo_id = ec.id
    WHERE pm.id = $1
  `,
        [result.rows[0].id],
      );

      res.status(201).json({
        success: true,
        member: memberData.rows[0],
        message: 'Contacto externo agregado como miembro',
      });
    },
  ),
);

// PUT - Actualizar rol de un miembro
router.put(
  '/:id',
  authenticateToken,
  asyncHandler(
    async (
      req: Request<{ id: string }, object, { rol_proyecto: MemberRole }>,
      res: Response,
    ): Promise<void> => {
      const { id } = req.params;
      const { rol_proyecto } = req.body;

      const result = await query<ProjectMemberRow>(
        `
    UPDATE proyecto_miembros
    SET rol_proyecto = $1, updated_at = CURRENT_TIMESTAMP
    WHERE id = $2
    RETURNING *
  `,
        [rol_proyecto, id],
      );

      if (result.rows.length === 0) {
        res.status(404).json({
          success: false,
          message: 'Miembro no encontrado',
        });
        return;
      }

      res.json({
        success: true,
        member: result.rows[0],
        message: 'Rol actualizado',
      });
    },
  ),
);

// DELETE - Remover miembro de proyecto (soft delete)
router.delete(
  '/:id',
  authenticateToken,
  asyncHandler(
    async (req: Request<{ id: string }>, res: Response): Promise<void> => {
      const { id } = req.params;

      const result = await query<ProjectMemberRow>(
        `
    UPDATE proyecto_miembros
    SET activo = false, updated_at = CURRENT_TIMESTAMP
    WHERE id = $1
    RETURNING *
  `,
        [id],
      );

      if (result.rows.length === 0) {
        res.status(404).json({
          success: false,
          message: 'Miembro no encontrado',
        });
        return;
      }

      res.json({
        success: true,
        message: 'Miembro removido del proyecto',
      });
    },
  ),
);

export default router;
