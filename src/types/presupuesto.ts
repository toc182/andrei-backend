// src/types/presupuesto.ts
// Tipos de la Hoja de Presupuesto.
//
// Un proyecto tiene VARIOS presupuestos independientes (antes de la licitacion,
// despues de adjudicado, con los disenos listos). Uno lleva la estrella y es
// contra el que compara el control de costos.
//
// Primera manera de armarlos: a partir del desglose oficial del proyecto. Las
// filas se copian el dia que se arma —descripcion, unidad, cantidad y PRECIO— y
// lo unico que se escribe despues es el COSTO unitario de cada renglon.

/** Columna multiplicadora del calculo por partes. Solo la usa la pantalla por
 *  bloques, que quedo apartada; se conserva para las otras maneras de armar. */
export interface CalculoColumna {
  uid: string;
  nombre: string;
}

export type CalculoClase = 'mano_obra' | 'material' | 'equipo';

export interface CalculoLinea {
  uid: string;
  concepto: string;
  clase: CalculoClase | null;
  valores: Record<string, number | null>;
}

export interface RenglonCalculo {
  columnas: CalculoColumna[];
  lineas: CalculoLinea[];
}

/** Una fila de la lista de presupuestos del proyecto. */
export interface PresupuestoListaWire {
  id: number;
  nombre: string;
  origen: 'desglose' | 'cero';
  /** La estrella: el que usa el control de costos. */
  esPrincipal: boolean;
  creadoAt: string; // ISO
  /** Suma de los renglones. Se calculan al leer, nunca se guardan. */
  costo: number;
  precio: number;
  renglones: number;
}

/** El desglose oficial del proyecto, para saber si se puede armar a partir de
 *  el. null = el proyecto no tiene, y esa manera sale apagada. */
export interface DesgloseDisponibleWire {
  id: number;
  nombre: string;
  filas: number;
}

export interface PresupuestosProyectoWire {
  presupuestos: PresupuestoListaWire[];
  desglose: DesgloseDisponibleWire | null;
}

export interface PresupuestoMeta {
  id: number;
  proyectoId: number;
  nombre: string;
  origen: 'desglose' | 'cero';
  esPrincipal: boolean;
  /** De cual desglose salio; null cuando se armo de otra manera. */
  desgloseId: number | null;
  creadoAt: string;
  updatedAt: string; // sello de concurrencia optimista (forma canonica to_char)
}

export interface PresupuestoRenglonWire {
  id: number;
  rowUid: string;
  parentId: number | null;
  tipo: 'grupo' | 'item';
  codigo: string;
  descripcion: string;
  unidad: string | null;
  cantidad: number | null;
  /** Lo que se COBRA. Copiado del desglose; aqui no se edita. */
  precioUnitario: number | null;
  /** Lo que CUESTA. Lo unico que escribe el usuario. */
  costoUnitario: number | null;
  orden: number;
}

export interface PresupuestoDocWire {
  presupuesto: PresupuestoMeta;
  renglones: PresupuestoRenglonWire[];
}

export interface CrearPresupuestoBody {
  nombre: string;
  /** v1 solo acepta 'desglose'. */
  origen?: 'desglose';
}

/** El guardado de la hoja: solo viajan los costos. La estructura y los precios
 *  son del desglose y no se tocan desde aqui. */
export interface GuardarCostosBody {
  baseUpdatedAt: string;
  nombre?: string;
  costos: { id: number; costoUnitario: number | null }[];
}
