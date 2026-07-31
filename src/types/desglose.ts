// src/types/desglose.ts
// Wire + DB types for the Desglose feature. Items travel parent-indexed by
// client tempIds so the tree round-trips; DB row <-> wire mapping lives in
// routes/desgloses.ts.

export interface DesgloseMeta {
  id: number;
  proyectoId: number;
  nombre: string;
  tipo: string; // 'oficial' (v1)
  itbmsTasa: number | null; // ITBMS rate % applied to the subtotal; null = sin ITBMS
  updatedAt: string; // optimistic-concurrency stamp (canonical to_char form)
}

export interface DesgloseItemWire {
  id: number;
  rowUid: string; // UUID estable de fila; sobrevive el DELETE+reinsert del guardado
  parentId: number | null;
  tipo: 'grupo' | 'item';
  item: string;
  descripcion: string;
  unidad: string | null;
  cantidad: number | null;
  precioUnitario: number | null;
  orden: number;
}

/** PUT body item: parent-indexed by tempId (any client-side number, unique per payload). */
export interface DesgloseItemInput {
  tempId: number;
  rowUid?: string; // UUID estable; el cliente lo reenvía para conservar identidad. Ausente = fila nueva (el server genera uno)
  parentTempId: number | null;
  tipo: 'grupo' | 'item';
  item: string;
  descripcion: string;
  unidad: string | null;
  cantidad: number | null;
  precioUnitario: number | null;
  orden: number;
}

export interface SaveDesgloseBody {
  baseUpdatedAt: string | null; // null ONLY when the project has no desglose yet
  nombre?: string;
  itbmsTasa?: number | null; // ITBMS rate %; null clears it
  items: DesgloseItemInput[];
}

// ---- desgloses de la sección Cuentas (tipo='cuentas', migración 142) ----

export interface DesgloseComentarioWire {
  id: number;
  autor: string;
  creadoAt: string; // ISO
  texto: string;
}

/** Fila de la lista de desgloses de Cuentas. `descripcion` es desgloses.nombre. */
export interface DesgloseCuentaWire {
  id: number;
  descripcion: string;
  /** 'oficial' = el desglose del proyecto (Información); no se borra desde Cuentas. */
  tipo: 'oficial' | 'cuentas';
  fecha: string | null; // YYYY-MM-DD
  copiadoDeId: number | null;
  comentarios: DesgloseComentarioWire[];
  /** Cuántas cuentas se armaron con este desglose (si > 0, no se puede borrar). */
  cuentasCount: number;
}

export interface CrearDesgloseCuentaBody {
  descripcion: string;
  fecha?: string | null; // YYYY-MM-DD
  /** Desglose a copiar (mismo proyecto); omitido/null = crear en blanco. */
  copiarDeId?: number | null;
}
