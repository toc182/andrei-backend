// Red de seguridad de las cinco herramientas del asistente.
// cd andrei-backend && npx tsx scripts/asistente-herramientas.spec.ts
//
// Sin base de datos y sin llamar a la inteligencia artificial: el contexto es
// de mentira y las herramientas son funciones puras sobre el. Esto es lo que
// decide y lo que calcula, asi que es lo que mas falta hace tener amarrado.
import { ejecutarHerramienta, MAX_PAGOS_POR_PROPUESTA } from '../src/services/asistentePagos/herramientas.js';
import { Borrador, huellaDePago } from '../src/services/asistentePagos/propuesta.js';
import type { ContextoProyecto } from '../src/services/asistentePagos/contexto.js';

let passed = 0; let failed = 0;
function ok(cond: boolean, label: string, extra?: unknown) {
  if (cond) passed++;
  else { failed++; console.log(`FAIL  ${label}`, extra !== undefined ? JSON.stringify(extra) : ''); }
}

const UID = {
  cajon: 'aaaaaaaa-0000-4000-8000-000000000001',
  cuneta: 'aaaaaaaa-0000-4000-8000-000000000002',
  zampeado: 'aaaaaaaa-0000-4000-8000-000000000003',
  sinCosto: 'aaaaaaaa-0000-4000-8000-000000000004',
  seccion: 'bbbbbbbb-0000-4000-8000-000000000001',
  fantasma: 'cccccccc-0000-4000-8000-000000000009',
};

function contexto(): ContextoProyecto {
  return {
    proyecto: { id: 21, nombre: 'ETESA' },
    desgloseId: 17,
    partidas: [
      { rowUid: UID.cajon, item: '1.11.4', descripcion: 'Construccion de Cajon Pluvial', presupuestado: 45255, seccionUid: UID.seccion },
      { rowUid: UID.cuneta, item: '1.11.1', descripcion: 'Cunetas pavimentadas', presupuestado: 560, seccionUid: UID.seccion },
      { rowUid: UID.zampeado, item: '1.12.4', descripcion: 'Zampeado con mortero', presupuestado: 1218, seccionUid: null },
      { rowUid: UID.sinCosto, item: '1.6.2', descripcion: 'Otros Permisos', presupuestado: null, seccionUid: null },
    ],
    secciones: [{ rowUid: UID.seccion, item: '1.11', descripcion: 'Canales o Cunetas', partidas: 2 }],
    categorias: [{ codigo: 'MAT', nombre: 'Materiales' }, { codigo: 'COM', nombre: 'Combustible' }],
    pagos: [
      { id: 99, numero: 'ET-D03', fecha: '2026-08-12', proveedor: 'Cemento Panamá, S.A.', monto: 5400, concepto: 'Concreto para el cajon', categoria: 'MAT · Materiales', partidas: [] },
      { id: 108, numero: 'ET-D12', fecha: '2026-08-18', proveedor: 'Cemento Panamá, S.A.', monto: 9800, concepto: null, categoria: 'MAT · Materiales', partidas: [{ rowUid: UID.cuneta, item: '1.11.1', descripcion: 'Cunetas pavimentadas', monto: 9800 }] },
      { id: 104, numero: 'ET-D08', fecha: '2026-08-28', proveedor: 'Combustibles Delta', monto: 1340, concepto: 'Diesel de la semana', categoria: 'COM · Combustible', partidas: [] },
      { id: 120, numero: 'ET-D24', fecha: '2026-09-01', proveedor: 'Planilla quincenal', monto: 5400, concepto: null, categoria: null, partidas: [{ rowUid: UID.fantasma, item: null, descripcion: null, monto: 5400 }] },
    ],
  };
}

const correr = (nombre: string, input: unknown, ctx = contexto(), b = new Borrador()) => ({
  r: ejecutarHerramienta(nombre, input, ctx, b), b, ctx,
});

// ---- buscar_pagos ----
{
  const { r } = correr('buscar_pagos', { texto: 'cemento' });
  const c = r.contenido as { total: number; pagos: { id: number }[] };
  ok(r.ok && c.total === 2, 'buscar: encuentra los dos de Cemento', c);

  // Sin tildes tambien: "panama" contra "Panamá".
  ok((correr('buscar_pagos', { texto: 'panama' }).r.contenido as { total: number }).total === 2,
    'buscar: no le estorban las tildes');

  ok((correr('buscar_pagos', { texto: 'diesel' }).r.contenido as { total: number }).total === 1,
    'buscar: tambien mira el concepto');

  const pend = correr('buscar_pagos', { sin_partida: true }).r.contenido as { total: number };
  ok(pend.total === 3, 'buscar: sin partida cuenta tambien el de la partida borrada', pend);

  const conP = correr('buscar_pagos', { con_partida: true }).r.contenido as { total: number };
  ok(conP.total === 1, 'buscar: con partida solo cuenta las vivas', conP);

  const cat = correr('buscar_pagos', { categoria_codigo: 'COM' }).r.contenido as { total: number };
  ok(cat.total === 1, 'buscar: filtra por categoria', cat);

  const rango = correr('buscar_pagos', { desde: '2026-08-18', hasta: '2026-08-28' }).r.contenido as { total: number };
  ok(rango.total === 2, 'buscar: filtra por fechas', rango);

  const corto = correr('buscar_pagos', { limite: 1 }).r.contenido as { hay_mas: boolean; mostrados: number };
  ok(corto.hay_mas === true && corto.mostrados === 1, 'buscar: avisa cuando la lista se queda corta', corto);
}

// ---- buscar_partidas ----
{
  const { r } = correr('buscar_partidas', { texto: 'cajon' });
  ok(r.ok && (r.contenido as { total: number }).total === 1, 'partidas: encuentra por descripcion');

  ok((correr('buscar_partidas', { texto: '1.11' }).r.contenido as { total: number }).total === 2,
    'partidas: encuentra por numero de item');

  ok((correr('buscar_partidas', { seccion_uid: UID.seccion }).r.contenido as { total: number }).total === 2,
    'partidas: filtra por seccion');
}

// ---- proponer_asignacion ----
{
  const { r, b } = correr('proponer_asignacion', { solicitudIds: [99], rowUid: UID.cajon, motivo: 'concreto' });
  ok(r.ok, 'asignar: propone', r.contenido);
  const cambios = b.cambios();
  ok(cambios.length === 1 && cambios[0].despues.length === 1, 'asignar: una sola linea');
  ok(cambios[0].despues[0].monto === 5400, 'asignar: le echa el pago entero', cambios[0].despues[0]);
  ok(cambios[0].antes.length === 0, 'asignar: el antes es como estaba');
  ok(cambios[0].regla === 'una_partida', 'asignar: deja dicha la regla');

  const ajena = correr('proponer_asignacion', { solicitudIds: [99], rowUid: UID.fantasma, motivo: 'x' });
  ok(!ajena.r.ok, 'asignar: rechaza una partida que no existe', ajena.r.contenido);
  ok(ajena.b.tamano === 0, 'asignar: el borrador queda intacto tras el rechazo');

  const otroProyecto = correr('proponer_asignacion', { solicitudIds: [7777], rowUid: UID.cajon, motivo: 'x' });
  ok(!otroProyecto.r.ok, 'asignar: rechaza un pago que no es de este proyecto');

  const vacio = correr('proponer_asignacion', { solicitudIds: [], rowUid: UID.cajon, motivo: 'x' });
  ok(!vacio.r.ok, 'asignar: rechaza la lista vacia de pagos');

  const muchos = correr('proponer_asignacion', {
    solicitudIds: Array.from({ length: MAX_PAGOS_POR_PROPUESTA + 1 }, (_, i) => i + 1),
    rowUid: UID.cajon, motivo: 'x',
  });
  ok(!muchos.r.ok, 'asignar: rechaza demasiados pagos de una vez');
}

// ---- proponer_reparto ----
{
  const iguales = correr('proponer_reparto', {
    solicitudIds: [99], regla: 'partes_iguales',
    partidas: [{ rowUid: UID.cajon }, { rowUid: UID.cuneta }], motivo: 'mitad y mitad',
  });
  const c = iguales.b.cambios()[0];
  ok(iguales.r.ok && c.despues.length === 2, 'reparto: parte en dos');
  ok(c.despues.every((l) => l.monto === 2700), 'reparto: mitad y mitad exacta', c.despues);

  const prop = correr('proponer_reparto', {
    solicitudIds: [99], regla: 'proporcional_presupuesto',
    partidas: [{ rowUid: UID.cajon }, { rowUid: UID.cuneta }], motivo: 'segun presupuesto',
  });
  const cp = prop.b.cambios()[0];
  ok(Math.round(cp.despues.reduce((s, l) => s + l.monto, 0) * 100) === 540000,
    'reparto: por presupuesto cierra al centavo', cp.despues);
  ok((cp.despues.find((l) => l.rowUid === UID.cajon)?.monto ?? 0)
    > (cp.despues.find((l) => l.rowUid === UID.cuneta)?.monto ?? 0),
    'reparto: la partida mas grande carga mas');

  const pct = correr('proponer_reparto', {
    solicitudIds: [99], regla: 'porcentajes',
    partidas: [{ rowUid: UID.cajon, porcentaje: 60 }, { rowUid: UID.cuneta, porcentaje: 40 }], motivo: 'x',
  });
  const cpct = pct.b.cambios()[0];
  ok(cpct.despues.find((l) => l.rowUid === UID.cajon)?.monto === 3240, 'reparto: el 60% del pago', cpct.despues);

  const malPct = correr('proponer_reparto', {
    solicitudIds: [99], regla: 'porcentajes',
    partidas: [{ rowUid: UID.cajon, porcentaje: 60 }, { rowUid: UID.cuneta, porcentaje: 39 }], motivo: 'x',
  });
  ok(!malPct.r.ok, 'reparto: rechaza porcentajes que no suman cien');

  // Una partida en cero NO esta prohibida: recibe gasto y queda pasada.
  const soloSinCosto = correr('proponer_reparto', {
    solicitudIds: [99], regla: 'proporcional_presupuesto',
    partidas: [{ rowUid: UID.sinCosto }], motivo: 'x',
  });
  ok(soloSinCosto.r.ok, 'sin costo: una partida en cero si puede recibir el gasto', soloSinCosto.r.contenido);
  ok(soloSinCosto.b.cambios()[0].despues[0].monto === 5400,
    'sin costo: le entra el pago entero', soloSinCosto.b.cambios()[0].despues);
  ok((soloSinCosto.r.contenido as { regla_aplicada: string }).regla_aplicada === 'partes_iguales',
    'sin costo: se cambia a partes iguales');
  ok(typeof (soloSinCosto.r.contenido as { aviso?: string }).aviso === 'string',
    'sin costo: y avisa para que se lo diga al usuario');

  // Una con costo y otra sin: entran las dos, en partes iguales.
  const mezcla = correr('proponer_reparto', {
    solicitudIds: [99], regla: 'proporcional_presupuesto',
    partidas: [{ rowUid: UID.cajon }, { rowUid: UID.sinCosto }], motivo: 'x',
  });
  const cm = mezcla.b.cambios()[0];
  ok(cm.despues.length === 2, 'sin costo: ninguna queda fuera', cm.despues);
  ok(cm.despues.every((l) => l.monto === 2700), 'sin costo: y va en partes iguales', cm.despues);
  ok(cm.regla === 'partes_iguales', 'sin costo: el cambio queda marcado como partes iguales');

  // Lo mismo en un reparto grande: una sola en cero arrastra a todo el grupo a
  // partes iguales, antes que dejarla fuera.
  const general = correr('proponer_reparto', {
    solicitudIds: [99], regla: 'proporcional_presupuesto',
    partidas: [{ rowUid: UID.cajon }, { rowUid: UID.cuneta }, { rowUid: UID.sinCosto }], motivo: 'x',
  });
  const cg = general.b.cambios()[0];
  ok(cg.despues.length === 3, 'reparto grande: las tres entran', cg.despues);
  ok(cg.regla === 'partes_iguales', 'reparto grande: una en cero lo pasa a partes iguales');
  ok(Math.round(cg.despues.reduce((s, l) => s + l.monto, 0) * 100) === 540000,
    'reparto grande: y sigue cuadrando al centavo', cg.despues);
  ok(typeof (general.r.contenido as { aviso?: string }).aviso === 'string',
    'reparto grande: avisa del cambio de regla', general.r.contenido);

  // Con todas costeadas, la proporcion manda como siempre.
  const todasConCosto = correr('proponer_reparto', {
    solicitudIds: [99], regla: 'proporcional_presupuesto',
    partidas: [{ rowUid: UID.cajon }, { rowUid: UID.cuneta }], motivo: 'x',
  });
  ok(todasConCosto.b.cambios()[0].regla === 'proporcional_presupuesto',
    'sin costo: si todas tienen costo, no se cambia nada');

  const repetida = correr('proponer_reparto', {
    solicitudIds: [99], regla: 'partes_iguales',
    partidas: [{ rowUid: UID.cajon }, { rowUid: UID.cajon }], motivo: 'x',
  });
  ok(!repetida.r.ok, 'reparto: rechaza la partida repetida');

  const reglaMala = correr('proponer_reparto', {
    solicitudIds: [99], regla: 'a_ojo', partidas: [{ rowUid: UID.cajon }], motivo: 'x',
  });
  ok(!reglaMala.r.ok, 'reparto: rechaza una regla inventada');

  // Cada pago cuadra con SU monto, no con el del primero.
  const dos = correr('proponer_reparto', {
    solicitudIds: [99, 104], regla: 'partes_iguales',
    partidas: [{ rowUid: UID.cajon }, { rowUid: UID.cuneta }], motivo: 'x',
  });
  const porPago = new Map(dos.b.cambios().map((x) => [x.solicitudId, x]));
  ok(Math.round((porPago.get(99)?.despues.reduce((s, l) => s + l.monto, 0) ?? 0) * 100) === 540000,
    'reparto: el primero cuadra con lo suyo');
  ok(Math.round((porPago.get(104)?.despues.reduce((s, l) => s + l.monto, 0) ?? 0) * 100) === 134000,
    'reparto: y el segundo con lo suyo');
}

// ---- proponer_sin_partida ----
{
  const { r, b } = correr('proponer_sin_partida', { solicitudIds: [108], motivo: 'no era de ahi' });
  const c = b.cambios()[0];
  ok(r.ok && c.despues.length === 0, 'sin partida: lo deja vacio');
  ok(c.antes.length === 1, 'sin partida: guarda lo que tenia');
}

// ---- el borrador ----
{
  const b = new Borrador();
  const ctx = contexto();
  ejecutarHerramienta('proponer_asignacion', { solicitudIds: [99], rowUid: UID.cajon, motivo: 'a' }, ctx, b);
  ejecutarHerramienta('proponer_asignacion', { solicitudIds: [99], rowUid: UID.cuneta, motivo: 'b' }, ctx, b);
  ok(b.cambios().length === 1, 'borrador: proponer dos veces el mismo pago deja uno');
  ok(b.cambios()[0].despues[0].rowUid === UID.cuneta, 'borrador: manda la ultima');

  // Dejar un pago como ya estaba no es un cambio.
  const b2 = new Borrador();
  ejecutarHerramienta('proponer_asignacion', { solicitudIds: [108], rowUid: UID.cuneta, motivo: 'igual' }, ctx, b2);
  ok(b2.tamano === 1, 'borrador: lo cuenta como tocado');
  ok(b2.cambios().length === 0, 'borrador: pero no lo lista como cambio, porque no cambia nada');
  ok(b2.propuesta('x') === null, 'borrador: sin cambios de verdad no hay propuesta');
}

// ---- la huella ----
{
  const a = huellaDePago(99, 540000, [{ rowUid: UID.cajon, monto: 2700 }, { rowUid: UID.cuneta, monto: 2700 }]);
  const alReves = huellaDePago(99, 540000, [{ rowUid: UID.cuneta, monto: 2700 }, { rowUid: UID.cajon, monto: 2700 }]);
  ok(a === alReves, 'huella: el orden de las lineas no la cambia');

  const unCentavo = huellaDePago(99, 540000, [{ rowUid: UID.cajon, monto: 2700.01 }, { rowUid: UID.cuneta, monto: 2700 }]);
  ok(a !== unCentavo, 'huella: un centavo de diferencia la cambia');

  const otroMonto = huellaDePago(99, 540001, [{ rowUid: UID.cajon, monto: 2700 }, { rowUid: UID.cuneta, monto: 2700 }]);
  ok(a !== otroMonto, 'huella: cambiar el monto del pago la cambia');

  ok(huellaDePago(99, 540000, []) !== huellaDePago(100, 540000, []), 'huella: distinta por pago');
}

// ---- una herramienta que no existe ----
{
  const { r } = correr('borrar_todo', {});
  ok(!r.ok, 'no existe: se rechaza lo que no esta en la lista');
}

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
