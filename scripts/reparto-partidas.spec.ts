// Red de seguridad del reparto proporcional en el SERVIDOR.
// cd andrei-backend && npx tsx scripts/reparto-partidas.spec.ts
//
// Es la misma bateria que corre la pantalla en
// andrei-frontend/scripts/reparto-partidas.spec.ts, contra la copia del
// servidor. Si una pasa y la otra no, las dos copias se separaron.
import { repartirPorPeso, type ParteConPeso } from '../src/services/asistentePagos/reparto.js';

let passed = 0; let failed = 0;
function ok(cond: boolean, label: string) {
  if (cond) passed++; else { failed++; console.log(`FAIL  ${label}`); }
}

const p = (rowUid: string, peso: number | null): ParteConPeso => ({ rowUid, peso });
const suma = (l: { monto: number }[]) => Math.round(l.reduce((s, x) => s + x.monto, 0) * 100);

// ---- los dos ejemplos que puso Ivan ----
{
  // Diez lineas de 1$ y un extintor de 10$: 1$ a cada una.
  const diez = Array.from({ length: 10 }, (_, i) => p(`r${i}`, 1));
  const r = repartirPorPeso(diez, 10);
  ok(r.length === 10, 'ejemplo 1: le toca a las diez lineas');
  ok(r.every((x) => x.monto === 1), 'ejemplo 1: un dolar a cada una');
  ok(suma(r) === 1000, 'ejemplo 1: la suma da el monto del pago');

  // 2 lineas de 2$, 4 de 1$ y 4 de 0.5$ (total 10$), extintor de 1$:
  // 0.20, 0.10 y 0.05 respectivamente.
  const mezcla = [
    ...Array.from({ length: 2 }, (_, i) => p(`a${i}`, 2)),
    ...Array.from({ length: 4 }, (_, i) => p(`b${i}`, 1)),
    ...Array.from({ length: 4 }, (_, i) => p(`c${i}`, 0.5)),
  ];
  const m = repartirPorPeso(mezcla, 1);
  const por = new Map(m.map((x) => [x.rowUid, x.monto]));
  ok(por.get('a0') === 0.2 && por.get('a1') === 0.2, 'ejemplo 2: las de 2$ cargan 0.20');
  ok([0, 1, 2, 3].every((i) => por.get(`b${i}`) === 0.1), 'ejemplo 2: las de 1$ cargan 0.10');
  ok([0, 1, 2, 3].every((i) => por.get(`c${i}`) === 0.05), 'ejemplo 2: las de 0.5$ cargan 0.05');
  ok(suma(m) === 100, 'ejemplo 2: la suma da el monto del pago');
}

// ---- la suma SIEMPRE cierra, aunque los centavos no partan bien ----
{
  const tres = repartirPorPeso([p('a', 1), p('b', 1), p('c', 1)], 100);
  ok(suma(tres) === 10000, 'centavos: 100 entre tres cierra exacto');
  ok(tres.filter((x) => x.monto === 33.34).length === 1, 'centavos: el centavo que sobra cae en una sola');

  const migaja = repartirPorPeso(Array.from({ length: 10 }, (_, i) => p(`r${i}`, 1)), 0.01);
  ok(suma(migaja) === 1, 'centavos: un centavo entre diez sigue siendo un centavo');
  ok(migaja.length === 1, 'centavos: las que se quedan en cero no viajan como lineas');

  const feo = repartirPorPeso(
    [p('a', 1663.2), p('b', 2520), p('c', 6566), p('d', 1218)], 1837.77,
  );
  ok(suma(feo) === 183777, 'centavos: con pesos irregulares tambien cierra');
  ok(feo.every((x) => x.monto > 0), 'centavos: ninguna linea sale en cero');
}

// ---- las que no tienen peso no reciben nada ----
{
  const r = repartirPorPeso([p('a', 100), p('b', null), p('c', 0)], 50);
  ok(r.length === 1 && r[0].rowUid === 'a', 'sin peso: solo carga la que tiene');
  ok(r[0].monto === 50, 'sin peso: la unica con peso carga el pago entero');

  ok(repartirPorPeso([p('a', null), p('b', null)], 50).length === 0,
    'sin peso: si ninguna tiene, no se reparte nada');
  ok(repartirPorPeso([], 50).length === 0, 'sin peso: sin partidas no hay reparto');
  ok(repartirPorPeso([p('a', 100)], 0).length === 0, 'monto cero: no hay nada que repartir');
}

// ---- las tres reglas del asistente, sobre la misma funcion ----
{
  // Por lo presupuestado: el peso es el costo de cada partida.
  const presupuesto = repartirPorPeso([p('a', 45255), p('b', 560)], 1000);
  ok(suma(presupuesto) === 100000, 'regla presupuesto: cierra');
  const porUid = new Map(presupuesto.map((x) => [x.rowUid, x.monto]));
  ok((porUid.get('a') ?? 0) > (porUid.get('b') ?? 0),
    'regla presupuesto: la partida mas grande carga mas');

  // En partes iguales: el peso es 1 para todas.
  const iguales = repartirPorPeso([p('a', 1), p('b', 1), p('c', 1), p('d', 1)], 100);
  ok(iguales.every((x) => x.monto === 25), 'regla partes iguales: 25 a cada una');

  // Por porcentajes: el peso es el porcentaje.
  const pct = repartirPorPeso([p('a', 60), p('b', 40)], 1000.01);
  const porPct = new Map(pct.map((x) => [x.rowUid, x.monto]));
  ok(suma(pct) === 100001, 'regla porcentajes: cierra hasta con montos feos');
  ok(porPct.get('a') === 600.01 && porPct.get('b') === 400,
    'regla porcentajes: 60 y 40 del monto');
}

// ---- repartir dos veces lo mismo da lo mismo ----
{
  const partidas = [p('a', 3), p('b', 3), p('c', 3), p('d', 1)];
  const uno = JSON.stringify(repartirPorPeso(partidas, 77.77));
  const dos = JSON.stringify(repartirPorPeso(partidas, 77.77));
  ok(uno === dos, 'estable: el mismo reparto da el mismo resultado');
}

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
