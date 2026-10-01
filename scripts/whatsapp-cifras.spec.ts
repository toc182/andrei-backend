// Toda cifra que el asistente dice al contestar una pregunta tiene que estar en
// lo que le devolvio el sistema. Puro, sin base.
// cd andrei-backend && npx tsx scripts/whatsapp-cifras.spec.ts
import { cifrasSinFuente, revisarRespuesta } from '../src/services/whatsapp/asistente.js';

let fallos = 0;
const exigir = (bien: boolean, que: string, visto?: unknown): void => {
  console.log(`${bien ? '  ok  ' : 'FALLA '} ${que}${bien || visto === undefined ? '' : ` → ${JSON.stringify(visto)}`}`);
  if (!bien) fallos += 1;
};
const igual = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// Lo que devolvio la consulta de la Torre Pendulo en la hoja de respuestas del
// 2026-10-01: tres filas, y el modelo dijo «8 dias» sumandolas.
const torre = JSON.stringify({
  columnas: ['area', 'dias', 'min', 'max'],
  filas: [
    ['Torre Pendulo', 3, '2026-09-28', '2026-09-30'],
    ['Area Interactiva, Torre Pendulo', 4, '2026-09-22', '2026-09-25'],
    ['Area Interactiva', 1, '2026-09-21', '2026-09-21'],
  ],
  cuantas_filas: 3,
});
const pregunta = '¿Cuántos días se trabajó en la Torre Péndulo en Playa Blanca?';

exigir(
  igual(cifrasSinFuente('8 días en Playa Blanca, del 21 al 30 de septiembre.', [pregunta, torre]), ['8']),
  'una suma hecha por el modelo (3 + 4 + 1 = 8) no está en lo que devolvió la base',
);
exigir(
  igual(cifrasSinFuente('7 días: 3 solo en la Torre y 4 junto con el Área Interactiva, del 22 al 30.', [pregunta, torre]), ['7']),
  'el total también tiene que salir de la consulta, no solo el desglose',
);
exigir(
  cifrasSinFuente('3 días, del 28 al 30 de septiembre de 2026.', [pregunta, torre]).length === 0,
  'lo que sí devolvió la base pasa, fechas incluidas',
);

// La Toyota Hilux de la segunda hoja de respuestas: en el JSON, «18,2» son dos
// numeros (18 horas, 2 dias), no uno.
const hilux = JSON.stringify({
  filas: [['Toyota Hilux Placa EQ2612', 'Consorcio Aguas de Santa Isabel', 18, 2, '2026-09-29', '2026-09-30']],
});
exigir(
  cifrasSinFuente('Trabajó 18 horas en 2 días: 29 y 30 de septiembre.', [hilux]).length === 0,
  'los números pegados con coma dentro del JSON se leen uno por uno',
  cifrasSinFuente('Trabajó 18 horas en 2 días: 29 y 30 de septiembre.', [hilux]),
);

const varilla = JSON.stringify({ filas: [['Varilla #4', 1550, 'unidades', '2026-09-24']] });
exigir(
  cifrasSinFuente('1,550 unidades de varilla #4 el 24 de septiembre.', [varilla]).length === 0 &&
    cifrasSinFuente('1.550 unidades.', [varilla]).length === 0 &&
    cifrasSinFuente('1550 unidades.', [varilla]).length === 0,
  'una cifra escrita con separador de miles es la misma',
);
const dinero = JSON.stringify({ total: 12345.67, cantidad: 3 });
exigir(cifrasSinFuente('3 solicitudes por B/. 12,345.67.', [dinero]).length === 0, 'los montos con B/. y comas');
const promedio = JSON.stringify({ filas: [[4.933333]] });
exigir(cifrasSinFuente('4.9 por día.', [promedio]).length === 0, 'un decimal de la base dicho redondeado vale');
exigir(igual(cifrasSinFuente('5 por día.', [promedio]), ['5']), 'pero un entero tiene que estar tal cual');
exigir(
  cifrasSinFuente('Del 16 al 30:\n1. RD-PBR-260916\n2. RD-PBR-260930', ['{"filas":[["RD-PBR-260916"],["RD-PBR-260930"],[16],[30]]}']).length === 0,
  'los números de una lista no son cifras',
);
exigir(
  cifrasSinFuente('Llegaron 27 codos de 45° de 12".', ['¿Cuántos codos de 45 de 12 pulgadas llegaron?', '{"filas":[[27]]}']).length === 0,
  'lo que dijo la persona en su pregunta se puede repetir',
);

// revisarRespuesta: cuando el turno leyo algo, se revisan las cifras y no el «anoté».
exigir(
  revisarRespuesta('27 codos, anotados en la unidad de la entrega.', false, '', ['{"filas":[[27]]}']) === null,
  'contestando una pregunta, «anotado» no es mentir que se anotó algo del reporte',
);
exigir(
  (revisarRespuesta('8 días.', false, '', [torre]) ?? '').includes('8'),
  'y una cifra sin fuente vuelve al modelo, diciéndole cuál',
);
exigir(
  revisarRespuesta('Anoté 3 calificados.', false, '', null) !== null,
  'llenando el reporte, decir «anoté» sin anotar sigue volviendo al modelo',
);

console.log(fallos === 0 ? '\nTodo bien' : `\n${fallos} fallo(s)`);
process.exit(fallos === 0 ? 0 : 1);
