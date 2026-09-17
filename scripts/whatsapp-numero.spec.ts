// Como queda un numero de WhatsApp escrito a mano. Cuenta pura, sin base ni
// servidor: npx tsx scripts/whatsapp-numero.spec.ts
//
// Importa porque un numero mal guardado no falla: simplemente no coincide nunca
// con lo que manda Meta, y esa persona se queda sin asistente sin que nadie
// sepa por que.

import { normalizarWhatsapp } from '../src/services/whatsapp/numero.js';

let fallos = 0;
const exigir = (bien: boolean, que: string): void => {
  console.log(`${bien ? '  ok  ' : 'FALLA '} ${que}`);
  if (!bien) fallos += 1;
};

const bueno = (entrada: unknown, esperado: string | null, que: string): void => {
  const r = normalizarWhatsapp(entrada);
  exigir(r.ok && r.numero === esperado, que);
};

const malo = (entrada: unknown, que: string): void => {
  exigir(!normalizarWhatsapp(entrada).ok, que);
};

bueno('66199092', '50766199092', 'ocho digitos son de Panama y se les pone el 507');
bueno('6619-9092', '50766199092', 'los guiones no cuentan');
bueno('6619 9092', '50766199092', 'los espacios tampoco');
bueno('+507 6619 9092', '50766199092', 'el mas y el codigo escrito a mano dan lo mismo');
bueno('50766199092', '50766199092', 'lo que ya viene como Meta se queda igual');
bueno('+1 (305) 555-0142', '13055550142', 'un numero de otro pais se respeta tal cual');
bueno('', null, 'vacio es «sin WhatsApp», no un error');
bueno('   ', null, 'solo espacios, igual');
bueno(null, null, 'nulo es «sin WhatsApp»');
bueno(undefined, null, 'no mandar el campo es «sin WhatsApp»');

malo('66-19', 'un numero demasiado corto no pasa');
malo('507661990921234567', 'uno demasiado largo tampoco');
malo('no tengo', 'un texto sin digitos no pasa');
malo(66199092, 'un numero que no viene como texto no pasa');

console.log(fallos === 0 ? '\nTodo bien' : `\n${fallos} fallo(s)`);
process.exit(fallos === 0 ? 0 : 1);
