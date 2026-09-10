// src/types/presupuesto.ts
// Tipos de la Hoja de Presupuesto.
//
// Un proyecto tiene VARIOS presupuestos independientes (antes de la licitacion,
// despues de adjudicado, con los disenos listos). Uno lleva la estrella y es
// contra el que compara el control de costos.
//
// Dos maneras de armarlos:
//   'desglose' — a partir del desglose oficial del proyecto. Las filas se copian
//                el dia que se arma —descripcion, unidad, cantidad y PRECIO— y
//                lo unico que se escribe despues es el COSTO unitario.
//   'cero'     — nace vacio y los renglones se escriben en la hoja. No hay
//                precio, porque no hay desglose de donde sacarlo: la hoja dice
//                lo que la obra CUESTA y nada mas. Es la unica manera para un
//                proyecto que todavia no tiene desglose cargado.

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
  /** 'desglose' copia los renglones del desglose oficial del proyecto;
   *  'cero' nace vacio y los renglones se escriben en la hoja. */
  origen?: 'desglose' | 'cero';
}

/** El guardado de la hoja armada DESDE EL DESGLOSE: solo viajan los costos. La
 *  estructura y los precios son del desglose y no se tocan desde aqui. */
export interface GuardarCostosBody {
  baseUpdatedAt: string;
  nombre?: string;
  costos: { id: number; costoUnitario: number | null }[];
}

/** Una fila de la hoja armada DESDE CERO. Misma forma que el desglose, de donde
 *  sale el patron: las filas viajan planas y en orden de outline, y el padre se
 *  nombra por tempId —no por id— porque una fila recien agregada todavia no
 *  tiene id en la base.
 *
 *  `orden` no viaja: sale de la posicion en el arreglo, que es la invariante
 *  que se valida. */
export interface PresupuestoRenglonInput {
  tempId: number;
  /** UUID estable; el cliente lo reenvia para conservar identidad a traves del
   *  borra-y-reinserta. Ausente = fila nueva y la genera la base. */
  rowUid?: string;
  parentTempId: number | null;
  tipo: 'grupo' | 'item';
  codigo: string;
  descripcion: string;
  unidad: string | null;
  cantidad: number | null;
  costoUnitario: number | null;
}

/** El guardado de la hoja armada desde cero: viaja la hoja ENTERA y reemplaza
 *  lo que habia. Solo lo admiten los presupuestos con origen 'cero'; los que
 *  salieron de un desglose tienen la estructura bloqueada. */
export interface GuardarHojaBody {
  baseUpdatedAt: string;
  nombre?: string;
  renglones: PresupuestoRenglonInput[];
}
