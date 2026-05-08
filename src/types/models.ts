import { UserRole } from './auth.js';

// ==================== USER ====================
export interface User {
  id: number;
  nombre: string;
  nombre_display?: string;
  email: string;
  password: string;
  rol: UserRole;
  activo: boolean;
  created_at: Date;
  updated_at: Date;
}

export type UserWithoutPassword = Omit<User, 'password'>;
export type CreateUserDTO = Pick<User, 'nombre' | 'email' | 'password'> & {
  rol?: UserRole;
};
export type UpdateUserDTO = Partial<
  Omit<User, 'id' | 'created_at' | 'updated_at'>
>;

// ==================== CLIENT ====================
export type ClientType = 'privado' | 'gobierno';

export interface Client {
  id: number;
  nombre: string;
  abreviatura?: string;
  contacto?: string;
  telefono?: string;
  email?: string;
  direccion?: string;
  tipo: ClientType;
  activo: boolean;
  created_at: Date;
  updated_at: Date;
}

export type CreateClientDTO = Omit<
  Client,
  'id' | 'activo' | 'created_at' | 'updated_at'
>;
export type UpdateClientDTO = Partial<CreateClientDTO>;

// ==================== PROJECT ====================
export type ProjectStatus =
  | 'planificacion'
  | 'en_curso'
  | 'pausado'
  | 'completado'
  | 'cancelado';
export type ProjectCurrency = 'USD' | 'PAB';
export type ProjectContractType = 'publico' | 'privado';

export interface Project {
  id: number;
  nombre: string;
  nombre_corto?: string;
  cliente_id?: number;
  cliente_nombre?: string;
  fecha_inicio?: string;
  fecha_fin_estimada?: string;
  estado: ProjectStatus;
  contratista?: string;
  ingeniero_residente?: string;
  codigo_proyecto?: string;
  contrato?: string;
  acto_publico?: string;
  tipo_contrato: ProjectContractType;
  monto_contrato_original?: number;
  presupuesto_base?: number;
  itbms?: number;
  monto_total?: number;
  datos_adicionales?: Record<string, unknown>;
  tiene_presupuesto: boolean;
  moneda_proyecto: ProjectCurrency;
  activo: boolean;
  created_at: Date;
  updated_at: Date;
}

export type CreateProjectDTO = Omit<
  Project,
  'id' | 'activo' | 'created_at' | 'updated_at' | 'cliente_nombre'
>;
export type UpdateProjectDTO = Partial<CreateProjectDTO>;

// ==================== EQUIPMENT ====================
export type EquipmentStatus =
  | 'operativo'
  | 'en_reparacion'
  | 'fuera_de_servicio'
  | 'en_mantenimiento';
export type EquipmentOwner = 'Pinellas' | 'COCP';

export interface Equipment {
  id: number;
  codigo: string;
  descripcion: string;
  marca?: string;
  modelo?: string;
  ano?: number;
  motor?: string;
  chasis?: string;
  costo?: number;
  valor_actual?: number;
  rata_mes?: number;
  proyecto?: string;
  responsable?: string;
  estado: EquipmentStatus;
  observaciones?: string;
  propietario: EquipmentOwner;
  activo: boolean;
  created_at: Date;
  updated_at: Date;
}

export type CreateEquipmentDTO = Omit<
  Equipment,
  'id' | 'activo' | 'created_at' | 'updated_at'
>;
export type UpdateEquipmentDTO = Partial<CreateEquipmentDTO>;

// ==================== EXPENSE ====================
export type ExpenseType = 'real' | 'presupuestado';

export interface ExpenseCategory {
  id: number;
  codigo: string;
  nombre: string;
  color?: string;
  orden: number;
  activo: boolean;
}

export interface ProjectExpense {
  id: number;
  proyecto_id: number;
  categoria_id?: number;
  proyecto_categoria_id?: number;
  descripcion: string;
  monto: number;
  fecha: Date;
  tipo: ExpenseType;
  creado_por: number;
  created_at: Date;
  updated_at: Date;
}

export type CreateExpenseDTO = Omit<
  ProjectExpense,
  'id' | 'created_at' | 'updated_at'
>;

// ==================== REQUISICION ====================
export type RequisicionStatus =
  | 'pendiente'
  | 'en_cotizacion'
  | 'por_aprobar'
  | 'aprobada'
  | 'pagada'
  | 'rechazada';

export interface Requisicion {
  id: number;
  project_id: number;
  numero: string;
  fecha: Date;
  proveedor?: string;
  descripcion?: string;
  subtotal: number;
  itbms: number;
  monto_total: number;
  estado: RequisicionStatus;
  solicitante_id?: number;
  created_by: number;
  archivada: boolean;
  fecha_archivado?: Date;
  archivado_por?: number;
  created_at: Date;
  updated_at: Date;
}

export interface RequisicionItem {
  id: number;
  requisicion_id: number;
  descripcion: string;
  cantidad: number;
  unidad: string;
  precio_unitario: number;
  subtotal: number;
  orden: number;
}

export type CreateRequisicionDTO = Omit<
  Requisicion,
  | 'id'
  | 'archivada'
  | 'fecha_archivado'
  | 'archivado_por'
  | 'created_at'
  | 'updated_at'
>;

// ==================== PROJECT MEMBERS ====================
export type MemberType = 'usuario' | 'externo';
export type MemberRole = 'gerente' | 'ingeniero' | 'supervisor' | 'miembro';

export interface ProjectMember {
  id: number;
  proyecto_id: number;
  user_id?: number;
  contacto_externo_id?: number;
  tipo_miembro: MemberType;
  rol_proyecto: MemberRole;
  activo: boolean;
  created_at: Date;
}

export interface ExternalContact {
  id: number;
  nombre: string;
  cargo?: string;
  telefono?: string;
  email?: string;
  notas?: string;
  activo: boolean;
  created_at: Date;
  updated_at: Date;
}

// ==================== PROJECT TODOS ====================
export type TodoStatus = 'pendiente' | 'completado';
export type TodoPriority = 'baja' | 'media' | 'alta';

export interface ProjectTodoCategory {
  id: number;
  proyecto_id: number;
  nombre: string;
  color?: string;
  orden: number;
  activo: boolean;
  created_at: Date;
}

export interface ProjectTodo {
  id: number;
  proyecto_id: number;
  categoria_id?: number;
  titulo: string;
  descripcion?: string;
  estado: TodoStatus;
  prioridad: TodoPriority;
  fecha_vencimiento?: Date;
  asignado_a?: number;
  creado_por: number;
  completado_at?: Date;
  completado_por?: number;
  created_at: Date;
  updated_at: Date;
}

export interface ProjectTodoComment {
  id: number;
  tarea_id: number;
  contenido: string;
  creado_por: number;
  created_at: Date;
}

// ==================== PROJECT BITACORA ====================
export interface ProjectLogEntry {
  id: number;
  proyecto_id: number;
  titulo: string;
  contenido: string;
  creado_por: number;
  created_at: Date;
  updated_at: Date;
}

export interface ProjectLogComment {
  id: number;
  bitacora_id: number;
  contenido: string;
  creado_por: number;
  created_at: Date;
}

export interface ProjectLogAttachment {
  id: number;
  bitacora_id?: number;
  comentario_id?: number;
  nombre_archivo: string;
  ruta_archivo: string;
  tipo_mime: string;
  tamano: number;
  created_at: Date;
}

// ==================== LICITACIONES Y OPORTUNIDADES ====================
export type LicitacionStatus =
  | 'activa'
  | 'adjudicada'
  | 'perdida'
  | 'cancelada'
  | 'vencida';
export type OportunidadStatus =
  | 'identificada'
  | 'en_seguimiento'
  | 'propuesta_enviada'
  | 'ganada'
  | 'perdida'
  | 'descartada';

export interface Licitacion {
  id: number;
  nombre: string;
  entidad: string;
  numero_licitacion?: string;
  fecha_publicacion?: Date;
  fecha_cierre?: Date;
  monto_estimado?: number;
  estado: LicitacionStatus;
  descripcion?: string;
  notas?: string;
  created_at: Date;
  updated_at: Date;
}

export interface Oportunidad {
  id: number;
  nombre: string;
  cliente_potencial?: string;
  contacto?: string;
  monto_estimado?: number;
  probabilidad?: number;
  estado: OportunidadStatus;
  descripcion?: string;
  notas?: string;
  fecha_seguimiento?: Date;
  created_at: Date;
  updated_at: Date;
}

// ==================== ADENDAS ====================
export type AdendaType = 'tiempo' | 'monto' | 'alcance' | 'otro';

export interface Adenda {
  id: number;
  project_id: number;
  numero: number;
  tipo: AdendaType;
  descripcion: string;
  monto_adicional?: number;
  dias_adicionales?: number;
  fecha_aprobacion?: string;
  created_at: Date;
  updated_at: Date;
}

// ==================== ASIGNACIONES ====================
export interface AsignacionEquipo {
  id: number;
  equipo_id: number;
  project_id?: number;
  fecha_inicio: Date;
  fecha_fin?: Date;
  responsable?: string;
  notas?: string;
  activo: boolean;
  created_at: Date;
}

export interface RegistroUsoEquipo {
  id: number;
  equipo_id: number;
  project_id?: number;
  fecha: Date;
  horas: number;
  descripcion?: string;
  created_by: number;
  created_at: Date;
}
