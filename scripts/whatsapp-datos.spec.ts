// Lo que el asistente puede y no puede anotar del reporte. Cuenta pura, sin
// base ni servidor: npx tsx scripts/whatsapp-datos.spec.ts
//
// Aqui esta la defensa de verdad contra lo que el modelo se invente: da igual
// lo que diga, si el area o el puesto no son de ese proyecto, no entra.

import {
  fusionar,
  faltantes,
  obligatoriasQueFaltan,
  resumen,
  type DatosReporte,
  type ListasProyecto,
} from '../src/services/whatsapp/datosReporte.js';
import { comoMensajes } from '../src/services/whatsapp/asistente.js';

let fallos = 0;
const exigir = (bien: boolean, que: string): void => {
  console.log(`${bien ? '  ok  ' : 'FALLA '} ${que}`);
  if (!bien) fallos += 1;
};

const LISTAS: ListasProyecto = {
  areas: [
    { id: 10, nombre: 'Torre A' },
    { id: 11, nombre: 'Lobby' },
  ],
  puestos: [
    { id: 20, nombre: 'Albañil', empresa: null },
    { id: 21, nombre: 'Ayudante', empresa: 'Subcontrato' },
  ],
  equipos: [{ id: 30, nombre: 'Retroexcavadora' }],
  categorias: [{ id: 40, nombre: 'Material' }],
};

const anotar = (datos: DatosReporte, parche: Record<string, unknown>) =>
  fusionar(datos, parche, LISTAS);

// ── lo que entra ────────────────────────────────────────────────────────────
const r1 = anotar({}, { clima: 'Lluvia parcial', horas_perdidas: 2, motivo: 'Lluvia' });
exigir(r1.ok && r1.datos.clima === 'Lluvia parcial' && r1.datos.horasPerdidas === 2,
  'el clima y las horas perdidas se anotan');

const r2 = anotar(r1.ok ? r1.datos : {}, { que_se_hizo: 'Vaciado de losa' });
exigir(r2.ok && r2.datos.clima === 'Lluvia parcial' && r2.datos.queSeHizo === 'Vaciado de losa',
  'anotar algo nuevo no borra lo anotado antes');

const r3 = anotar({}, { areas: [10, 11, 10] });
exigir(r3.ok && JSON.stringify(r3.datos.areas) === '[10,11]', 'las areas repetidas se juntan');

const r4 = anotar({}, {
  personal: [{ puesto_id: 20, cantidad: 3 }, { puesto_id: 21, cantidad: 12 }],
  equipos: [{ equipo_id: 30, unidades: 1, horas: 6 }],
  entregas: [{ categoria_id: 40, descripcion: 'Cemento', cantidad: 40, unidad: 'sacos' }],
});
exigir(
  r4.ok && r4.datos.personal?.length === 2 && r4.datos.equipos?.[0].horas === 6 &&
    r4.datos.entregas?.[0].descripcion === 'Cemento',
  'personal, equipo y entregas se anotan con sus numeros',
);

// ── lo que NO entra ─────────────────────────────────────────────────────────
exigir(!anotar({}, { clima: 'Lloviznando' }).ok, 'un clima que no esta en la lista se rechaza');
exigir(!anotar({}, { fecha: '17/09/2026' }).ok, 'una fecha con otro formato se rechaza');
exigir(!anotar({}, { horas_perdidas: 30 }).ok, 'mas de 24 horas perdidas se rechaza');
exigir(!anotar({}, { areas: [99] }).ok, 'un area de otro proyecto se rechaza');
exigir(!anotar({}, { personal: [{ puesto_id: 99, cantidad: 1 }] }).ok,
  'un puesto de otro proyecto se rechaza');
exigir(!anotar({}, { equipos: [{ equipo_id: 99, horas: 3 }] }).ok,
  'un equipo de otro proyecto se rechaza');
exigir(!anotar({}, { entregas: [{ categoria_id: 99, descripcion: 'Arena' }] }).ok,
  'una categoria de otro proyecto se rechaza');
exigir(!anotar({}, { que_se_hizo: '   ' }).ok, 'el trabajo ejecutado no puede ir en blanco');
exigir(!anotar({}, { equipos: [{ equipo_id: 30, horas: 25 }] }).ok,
  'mas de 24 horas de una maquina se rechaza');

const malo = anotar({ clima: 'Soleado' }, { areas: [99] });
exigir(!malo.ok, 'y cuando algo se rechaza, se rechaza esa anotacion entera');

// ── que falta por preguntar ─────────────────────────────────────────────────
const vacio = faltantes({}, 0).map((s) => String(s.clave));
exigir(vacio.includes('clima') && vacio.includes('fotos'),
  'de un reporte vacio falta todo, fotos incluidas');

const conClima = faltantes({ clima: 'Soleado' }, 0).map((s) => String(s.clave));
exigir(!conClima.includes('clima'), 'lo contestado deja de faltar');

const preguntado = faltantes({ preguntadas: ['novedades'] }, 0).map((s) => String(s.clave));
exigir(!preguntado.includes('novedades'),
  'lo que se pregunto y no hubo nada tampoco vuelve a faltar');

exigir(faltantes({}, 2).every((s) => String(s.clave) !== 'fotos'),
  'con fotos mandadas, las fotos dejan de faltar');

const pendientes = obligatoriasQueFaltan({ clima: 'Soleado' }).map((s) => String(s.clave));
exigir(
  pendientes.includes('fecha') && pendientes.includes('queSeHizo') &&
    !pendientes.includes('novedades'),
  'sin fecha ni trabajo ejecutado el reporte no se puede guardar; las novedades si pueden faltar',
);

// ── el resumen que lee la persona ───────────────────────────────────────────
const texto = resumen(
  {
    clima: 'Lluvia parcial',
    horasPerdidas: 2,
    motivo: 'Lluvia de 2 a 4',
    areas: [10],
    queSeHizo: 'Vaciado de losa',
    personal: [{ puestoId: 20, cantidad: 3 }, { puestoId: 21, cantidad: 0 }],
    equipos: [{ equipoId: 30, unidades: 1, horas: 6 }],
    entregas: [{ categoriaId: 40, descripcion: 'Cemento', cantidad: 40, unidad: 'sacos', notas: null }],
  },
  LISTAS,
  3,
);
exigir(texto.includes('Torre A') && texto.includes('3 Albañil') && texto.includes('Retroexcavadora 6 h'),
  'el resumen dice los nombres, no los numeros de la base');
exigir(!texto.includes('0 Ayudante'), 'y no nombra los puestos con cero personas');
exigir(texto.includes('Fotos: 3'), 'y dice cuantas fotos hay');


// ── la conversacion como la ve el modelo ────────────────────────────────────
// Lo que rompio la primera prueba de verdad (2026-09-18): Ivan escribio
// mientras el asistente le contestaba lo anterior, la respuesta quedo despues
// de su mensaje, y la API rechaza una conversacion que no termina en la
// persona.
const hist = (
  xs: [dir: 'entrante' | 'saliente', texto: string, tipo?: string][],
): { id: number; direccion: 'entrante' | 'saliente'; texto: string; tipo: string; r2Key: null }[] =>
  xs.map(([direccion, texto, tipo], i) => ({
    id: i + 1,
    direccion,
    texto,
    tipo: tipo ?? 'text',
    r2Key: null,
  }));

const normal = comoMensajes(hist([
  ['entrante', 'hola'],
  ['saliente', '¿qué se hizo hoy?'],
  ['entrante', 'vaciamos la losa'],
]));
exigir(
  normal.mensajes.length === 3 && normal.mensajes[2].role === 'user' && normal.colgando.length === 0,
  'una conversacion normal pasa entera y acaba en la persona',
);

const cruzada = comoMensajes(hist([
  ['entrante', 'hola'],
  ['entrante', 'vaciamos la losa'],
  ['saliente', '¿y el equipo?'],
]));
exigir(
  cruzada.mensajes.at(-1)?.role === 'user',
  'si la ultima es nuestra, la conversacion sigue acabando en la persona',
);
exigir(
  cruzada.colgando.join('') === '¿y el equipo?',
  'y lo que le mandamos sin contestar no se pierde: se cuenta aparte',
);

const fotos = comoMensajes(hist([
  ['entrante', 'hola'],
  ['entrante', '', 'image'],
  ['entrante', 'la losa', 'image'],
]));
exigir(
  typeof fotos.mensajes.at(-1)?.content === 'string' &&
    String(fotos.mensajes.at(-1)?.content).includes('[foto recibida'),
  'las fotos llegan como fotos, con o sin pie',
);

const soloNuestro = comoMensajes(hist([['saliente', 'hola, soy el asistente']]));
exigir(
  soloNuestro.mensajes.length === 0,
  'si solo hay mensajes nuestros, no hay nada que contestar',
);
const cierre = fallos === 0 ? String.fromCharCode(10) + "Todo bien" : String.fromCharCode(10) + fallos + " fallo(s)";
console.log(cierre);
process.exit(fallos === 0 ? 0 : 1);
