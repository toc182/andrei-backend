// src/services/asistentePagos/reparto.ts
// Repartir un gasto entre varias partidas, en proporcion a un peso.
//
// GEMELO DE andrei-frontend/src/lib/repartoPartidas.ts. Los dos hacen lo mismo
// y corren la misma bateria de pruebas. Estan duplicados a proposito: la
// pantalla lo necesita al instante para el boton de "Todo el proyecto" —una
// vuelta al servidor ahi seria una espera donde hoy no hay ninguna— y el
// servidor lo necesita como autoridad, porque es quien decide la plata que
// entra a la base. Si tocas uno, toca el otro y corre las dos pruebas.
//
// El PESO es lo que le da su parte a cada partida. Segun la regla que pida el
// usuario, el peso es distinto:
//
//   por lo presupuestado -> el costo presupuestado de la partida
//   en partes iguales    -> 1 para todas
//   por porcentajes      -> el porcentaje que se dijo
//
// Una partida sin peso no recibe nada: sin presupuesto no hay con que calcular
// su parte, y darle un pedazo igual seria inventarselo.
//
// Los centavos se reparten por el metodo del resto mayor: cada partida se lleva
// su parte entera y los que sobran van a las que quedaron con la fraccion mas
// alta. Asi la suma da EXACTAMENTE el monto del pago, que es lo que exige el
// guardado para dejarlo entrar.

export interface ParteConPeso {
  rowUid: string;
  peso: number | null;
}

export interface LineaReparto {
  rowUid: string;
  monto: number;
}

/** Reparte `monto` entre `partes` en proporcion a su peso.
 *  Devuelve [] si ninguna tiene peso: no hay como repartir. */
export function repartirPorPeso(partes: ParteConPeso[], monto: number): LineaReparto[] {
  const conPeso = partes.filter(
    (p): p is ParteConPeso & { peso: number } => p.peso != null && p.peso > 0,
  );
  const pesoTotal = conPeso.reduce((s, p) => s + p.peso, 0);
  const centavosTotal = Math.round(monto * 100);
  if (conPeso.length === 0 || pesoTotal <= 0 || centavosTotal <= 0) return [];

  const crudos = conPeso.map((p, i) => {
    const exacto = (centavosTotal * p.peso) / pesoTotal;
    const entero = Math.floor(exacto);
    return { i, rowUid: p.rowUid, entero, resto: exacto - entero };
  });

  let repartidos = crudos.reduce((s, c) => s + c.entero, 0);
  // Los centavos que sobran, a los restos mas altos. A igual resto manda el
  // orden del desglose, para que repartir dos veces lo mismo de lo mismo.
  const porResto = [...crudos].sort((a, b) => (b.resto - a.resto) || (a.i - b.i));
  for (let k = 0; repartidos < centavosTotal; k++, repartidos++) {
    porResto[k % porResto.length].entero++;
  }

  return crudos
    .filter((c) => c.entero > 0)
    .map((c) => ({ rowUid: c.rowUid, monto: c.entero / 100 }));
}
