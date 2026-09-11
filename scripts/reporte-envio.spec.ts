// Red de seguridad de la espera entre reintentos del envío del reporte.
// cd andrei-backend && npx tsx scripts/reporte-envio.spec.ts
//
// Esta cuenta decide dos cosas que no se ven hasta que duelen: cuánto tarda un
// reporte en salir cuando el primer intento falla, y cuándo se deja de
// insistir para avisar a una persona. Si devolviera una fecha en el pasado, el
// cron reintentaría en bucle cada minuto; si no devolviera null nunca, no se
// avisaría jamás y volveríamos al 2026-09-10: un reporte sin enviar que nadie
// sabe que está sin enviar.
import {
  calcularProximoIntento,
  ESPERAS_MINUTOS,
  MAX_INTENTOS,
} from '../src/services/reporteEnvio.js';

let passed = 0; let failed = 0;
function ok(cond: boolean, label: string) {
  if (cond) passed++; else { failed++; console.log(`FAIL  ${label}`); }
}
function lanza(fn: () => unknown, label: string) {
  try { fn(); failed++; console.log(`FAIL  ${label} (no lanzo)`); }
  catch { passed++; }
}

const BASE = new Date('2026-09-11T10:00:00.000Z');
const minutosDesdeBase = (d: Date | null): number | null =>
  d === null ? null : Math.round((d.getTime() - BASE.getTime()) / 60_000);

// ---- la escalera completa ----
{
  ok(minutosDesdeBase(calcularProximoIntento(0, BASE)) === 1,
     'sin fallos previos, el primer reintento es al minuto');
  ok(minutosDesdeBase(calcularProximoIntento(1, BASE)) === 5,
     'tras 1 fallo, a los 5 minutos');
  ok(minutosDesdeBase(calcularProximoIntento(2, BASE)) === 15,
     'tras 2 fallos, a los 15 minutos');
  ok(minutosDesdeBase(calcularProximoIntento(3, BASE)) === 60,
     'tras 3 fallos, a la hora');
  ok(minutosDesdeBase(calcularProximoIntento(4, BASE)) === 180,
     'tras 4 fallos, a las tres horas');
}

// ---- rendirse ----
{
  ok(calcularProximoIntento(MAX_INTENTOS, BASE) === null,
     'alcanzado el tope se devuelve null: sale de la cola y se avisa');
  ok(calcularProximoIntento(MAX_INTENTOS + 3, BASE) === null,
     'pasado el tope sigue siendo null, no vuelve a empezar');
  ok(MAX_INTENTOS === ESPERAS_MINUTOS.length,
     'el tope de intentos es exactamente el largo de la escalera');
}

// ---- la escalera tiene que subir ----
{
  const suben = ESPERAS_MINUTOS.every(
    (m, i) => i === 0 || m > ESPERAS_MINUTOS[i - 1]);
  ok(suben, 'cada espera es mayor que la anterior');
  ok(ESPERAS_MINUTOS.every((m) => m > 0),
     'ninguna espera es cero: una espera de cero reintentaria en bucle');
}

// ---- siempre hacia adelante ----
{
  let todasFuturas = true;
  for (let i = 0; i < MAX_INTENTOS; i++) {
    const d = calcularProximoIntento(i, BASE);
    if (d === null || d.getTime() <= BASE.getTime()) todasFuturas = false;
  }
  ok(todasFuturas, 'ningun reintento cae en el pasado');

  // sin fecha base usa la de ahora
  const ahora = Date.now();
  const sinBase = calcularProximoIntento(0);
  ok(sinBase !== null && sinBase.getTime() > ahora,
     'sin fecha base cuenta desde ahora');
}

// ---- entradas imposibles ----
{
  lanza(() => calcularProximoIntento(-1, BASE), 'un numero negativo de intentos lanza');
  lanza(() => calcularProximoIntento(1.5, BASE), 'un numero con decimales lanza');
  lanza(() => calcularProximoIntento(NaN, BASE), 'NaN lanza');
}

// ---- no tocar la fecha que le dan ----
{
  const base = new Date('2026-09-11T10:00:00.000Z');
  const antes = base.getTime();
  calcularProximoIntento(2, base);
  ok(base.getTime() === antes, 'no modifica la fecha que recibe');
}

console.log(`\n${passed} pasaron, ${failed} fallaron`);
process.exit(failed === 0 ? 0 : 1);
