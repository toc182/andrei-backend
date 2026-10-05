import { Router, Request, Response } from 'express';
import { body, validationResult, param } from 'express-validator';
import { query, pool } from '../database/config.js';
import { authenticateToken, checkPermission } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { registrarAudit } from '../services/auditLog.js';

const router = Router();

type TipoUso = 'propio' | 'alquiler';
type TipoCobro = 'hora' | 'dia' | 'semana' | 'mes' | 'costo_fijo';

interface AsignacionRow {
  id: number;
  equipo_id: number;
  cliente_id: number;
  proyecto_id: number;
  responsable_id?: number;
  fecha_inicio: Date;
  fecha_fin?: Date;
  tipo_uso: TipoUso;
  tipo_cobro?: TipoCobro;
  tarifa?: number;
  incluye_operador?: boolean;
  costo_operador?: number;
  incluye_combustible?: boolean;
  costo_combustible?: number;
  ajuste_monto?: number;
  motivo_ajuste?: string;
  observaciones?: string;
  equipo_codigo?: string;
  equipo_descripcion?: string;
  cliente_nombre?: string;
  cliente_abreviatura?: string;
  proyecto_nombre?: string;
  created_at: Date;
  updated_at: Date;
}

interface CreateAsignacionBody {
  equipo_id: number;
  cliente_id: number;
  proyecto_id: number;
  responsable_id?: number;
  fecha_inicio: string;
  fecha_fin?: string;
  tipo_uso: TipoUso;
  tipo_cobro?: TipoCobro;
  tarifa?: number | string;
  incluye_operador?: boolean;
  costo_operador?: number | string;
  incluye_combustible?: boolean;
  costo_combustible?: number | string;
  observaciones?: string;
}

interface UpdateAsignacionBody extends Partial<CreateAsignacionBody> {
  ajuste_monto?: number | string;
  motivo_ajuste?: string;
}

/** Lo unico que PUT /:id puede escribir. `estado` no: ninguna pantalla lo manda. */
const CAMPOS_EDITABLES: readonly (keyof UpdateAsignacionBody)[] = [
  'equipo_id',
  'cliente_id',
  'proyecto_id',
  'responsable_id',
  'fecha_inicio',
  'fecha_fin',
  'tipo_uso',
  'tipo_cobro',
  'tarifa',
  'incluye_operador',
  'costo_operador',
  'incluye_combustible',
  'costo_combustible',
  'ajuste_monto',
  'motivo_ajuste',
  'observaciones',
];

/** Columnas donde '' quiere decir "sin valor". */
const VACIO_ES_NULL = new Set<string>([
  'responsable_id',
  'tipo_cobro',
  'fecha_fin',
  'tarifa',
  'costo_operador',
  'costo_combustible',
  'ajuste_monto',
]);

/** Lo que se anota en asignaciones_historial cuando cambia. */
const CAMPOS_HISTORIAL: readonly string[] = [
  'cliente_id',
  'proyecto_id',
  'responsable_id',
  'fecha_inicio',
  'fecha_fin',
  'tipo_uso',
  'tipo_cobro',
  'tarifa',
  'incluye_operador',
  'costo_operador',
  'incluye_combustible',
  'costo_combustible',
  'ajuste_monto',
  'motivo_ajuste',
  'observaciones',
];

// Obtener todas las asignaciones
router.get(
  '/',
  authenticateToken,
  checkPermission('equipos_asignacion'),
  asyncHandler(
    async (_req: Request, res: Response): Promise<void> => {
      const result = await query<AsignacionRow>(`
    SELECT
      a.*,
      e.codigo as equipo_codigo,
      e.descripcion as equipo_descripcion,
      c.nombre as cliente_nombre,
      c.abreviatura as cliente_abreviatura,
      p.nombre_corto as proyecto_nombre
    FROM asignaciones_equipos a
    LEFT JOIN equipos e ON a.equipo_id = e.id
    LEFT JOIN clientes c ON a.cliente_id = c.id
    LEFT JOIN proyectos p ON a.proyecto_id = p.id
    ORDER BY a.created_at DESC
  `);

      res.json({
        success: true,
        data: result.rows,
      });
    },
    {
      tableNotExistsDefault: { data: [] },
    },
  ),
);

// Crear nueva asignación
router.post(
  '/',
  [
    body('equipo_id').isInt().withMessage('ID de equipo requerido'),
    body('cliente_id').isInt().withMessage('ID de cliente requerido'),
    body('proyecto_id').isInt().withMessage('ID de proyecto requerido'),
    body('responsable_id')
      .optional({ nullable: true, checkFalsy: true })
      .isInt()
      .withMessage('ID de responsable inválido'),
    body('fecha_inicio').isISO8601().withMessage('Fecha de inicio requerida'),
    body('tipo_uso')
      .isIn(['propio', 'alquiler'])
      .withMessage('Tipo de uso inválido'),
  ],
  authenticateToken,
  checkPermission('equipos_asignacion'),
  asyncHandler(
    async (
      req: Request<object, object, CreateAsignacionBody>,
      res: Response,
    ): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({
          success: false,
          message: 'Datos inválidos',
          errors: errors.array(),
        });
        return;
      }

      const {
        equipo_id,
        cliente_id,
        proyecto_id,
        responsable_id,
        fecha_inicio,
        fecha_fin,
        tipo_uso,
        tipo_cobro,
        tarifa,
        incluye_operador,
        costo_operador,
        incluye_combustible,
        costo_combustible,
        observaciones,
      } = req.body;

      // Convertir strings vacíos a null para campos numéricos y fechas
      const cleanedData = {
        equipo_id,
        cliente_id,
        proyecto_id,
        responsable_id: responsable_id || null,
        fecha_inicio: fecha_inicio || null,
        fecha_fin: fecha_fin === '' ? null : fecha_fin,
        tipo_uso,
        tipo_cobro: tipo_cobro || null,
        tarifa: tarifa === '' ? null : tarifa,
        incluye_operador,
        costo_operador: costo_operador === '' ? null : costo_operador,
        incluye_combustible,
        costo_combustible: costo_combustible === '' ? null : costo_combustible,
        observaciones: observaciones || null,
      };

      const result = await query<AsignacionRow>(
        `
    INSERT INTO asignaciones_equipos (
      equipo_id, cliente_id, proyecto_id, responsable_id,
      fecha_inicio, tipo_uso, tipo_cobro, tarifa,
      incluye_operador, costo_operador, incluye_combustible, costo_combustible,
      observaciones, created_at, updated_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW(), NOW()
    ) RETURNING *
  `,
        [
          cleanedData.equipo_id,
          cleanedData.cliente_id,
          cleanedData.proyecto_id,
          cleanedData.responsable_id,
          cleanedData.fecha_inicio,
          cleanedData.tipo_uso,
          cleanedData.tipo_cobro,
          cleanedData.tarifa,
          cleanedData.incluye_operador,
          cleanedData.costo_operador,
          cleanedData.incluye_combustible,
          cleanedData.costo_combustible,
          cleanedData.observaciones,
        ],
      );

      await registrarAudit(
        req.user!.id,
        'crear',
        'asignacion_equipo',
        result.rows[0].id,
        {
          equipo_id,
          proyecto_id,
          tipo_uso,
        },
      );

      res.json({
        success: true,
        message: 'Asignación creada exitosamente',
        data: result.rows[0],
      });
    },
  ),
);

// Actualizar asignación
router.put(
  '/:id',
  [
    param('id').isInt().withMessage('ID debe ser un número'),
    body('equipo_id').optional().isInt().withMessage('ID de equipo inválido'),
    body('cliente_id').optional().isInt().withMessage('ID de cliente inválido'),
    body('proyecto_id')
      .optional()
      .isInt()
      .withMessage('ID de proyecto inválido'),
  ],
  authenticateToken,
  checkPermission('equipos_editar_asignacion'),
  asyncHandler(
    async (
      req: Request<{ id: string }, object, UpdateAsignacionBody>,
      res: Response,
    ): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({
          success: false,
          message: 'Datos inválidos',
          errors: errors.array(),
        });
        return;
      }

      const { id } = req.params;
      const userId = req.user!.id;

      // Solo las columnas de la lista: los nombres de lo que llega en el cuerpo
      // nunca se escriben en el SQL. Antes el SET se armaba con las llaves del
      // cuerpo, y una llave inventada era SQL ajeno corriendo en la base.
      const datos: Record<string, unknown> = {};
      for (const campo of CAMPOS_EDITABLES) {
        if (!Object.prototype.hasOwnProperty.call(req.body, campo)) continue;
        const valor = (req.body as Record<string, unknown>)[campo];
        // La pantalla manda '' por "sin valor" (sin responsable, sin tipo de
        // cobro en una de uso propio...). En una columna de numero, fecha o con
        // CHECK, '' revienta; se guarda null, igual que al crear.
        datos[campo] = valor === '' && VACIO_ES_NULL.has(campo) ? null : valor;
      }

      if (Object.keys(datos).length === 0) {
        res.status(400).json({
          success: false,
          message: 'No se proporcionaron campos para actualizar',
        });
        return;
      }

      // La comprobacion, el historial, el cambio y el registro van juntos: si
      // algo falla no queda historial de un cambio que nunca se guardo.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const previousData = await client.query<AsignacionRow>(
          'SELECT * FROM asignaciones_equipos WHERE id = $1 FOR UPDATE',
          [id],
        );

        if (previousData.rows.length === 0) {
          await client.query('ROLLBACK');
          res.status(404).json({
            success: false,
            message: 'Asignación no encontrada',
          });
          return;
        }

        const oldData = previousData.rows[0];

        // Con registros de uso, el tipo de cobro ya no cambia: ni a otro ni a
        // ninguno.
        if (
          'tipo_cobro' in datos &&
          (datos.tipo_cobro ?? null) !== (oldData.tipo_cobro ?? null)
        ) {
          const registrosUso = await client.query<{ count: string }>(
            'SELECT COUNT(*) as count FROM registro_uso_equipos WHERE asignacion_id = $1',
            [id],
          );
          if (parseInt(registrosUso.rows[0].count) > 0) {
            await client.query('ROLLBACK');
            res.status(400).json({
              success: false,
              message:
                'No se puede cambiar el tipo de cobro porque ya existen registros de uso para esta asignación',
            });
            return;
          }
        }

        // Historial: solo lo que de verdad cambia. Se compara ya limpio, para
        // que un '' contra un null no cuente como cambio.
        for (const campo of CAMPOS_HISTORIAL) {
          if (!(campo in datos)) continue;
          const valorAnterior = oldData[campo as keyof AsignacionRow] ?? null;
          const valorNuevo = datos[campo] ?? null;
          if (String(valorAnterior) !== String(valorNuevo)) {
            await client.query(
              `INSERT INTO asignaciones_historial (
                 asignacion_id, campo_modificado, valor_anterior, valor_nuevo, usuario_id
               ) VALUES ($1, $2, $3, $4, $5)`,
              [id, campo, valorAnterior, valorNuevo, userId],
            );
          }
        }

        const campos = Object.keys(datos);
        const sets = campos.map((campo, i) => `${campo} = $${i + 2}`);
        const result = await client.query<AsignacionRow>(
          `UPDATE asignaciones_equipos
              SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP
            WHERE id = $1
        RETURNING *`,
          [id, ...campos.map((campo) => datos[campo])],
        );

        await registrarAudit(
          userId,
          'editar',
          'asignacion_equipo',
          parseInt(id),
          {
            equipo_id: oldData.equipo_id,
            proyecto_id: oldData.proyecto_id,
            campos,
          },
          client,
        );

        await client.query('COMMIT');

        res.json({
          success: true,
          message: 'Asignación actualizada exitosamente',
          data: result.rows[0],
        });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
  ),
);

// Eliminar asignación
router.delete(
  '/:id',
  [param('id').isInt().withMessage('ID debe ser un número')],
  authenticateToken,
  checkPermission('equipos_asignacion'),
  asyncHandler(
    async (req: Request<{ id: string }>, res: Response): Promise<void> => {
      const { id } = req.params;

      const asigData = await query<{ equipo_id: number; proyecto_id: number }>(
        'SELECT equipo_id, proyecto_id FROM asignaciones_equipos WHERE id = $1',
        [id],
      );

      const result = await query(
        'DELETE FROM asignaciones_equipos WHERE id = $1',
        [id],
      );

      if (result.rowCount === 0) {
        res.status(404).json({
          success: false,
          message: 'Asignación no encontrada',
        });
        return;
      }

      await registrarAudit(
        req.user!.id,
        'eliminar',
        'asignacion_equipo',
        parseInt(id),
        {
          equipo_id: asigData.rows[0]?.equipo_id,
          proyecto_id: asigData.rows[0]?.proyecto_id,
        },
      );

      res.json({
        success: true,
        message: 'Asignación eliminada exitosamente',
      });
    },
  ),
);

export default router;
