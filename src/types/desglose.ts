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
