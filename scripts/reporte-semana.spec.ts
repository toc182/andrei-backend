// Red de seguridad de las semanas de los reportes semanales.
// cd andrei-backend && npx tsx scripts/reporte-semana.spec.ts
//
// El numero de semana sale impreso en el papel y decide a que reporte
// pertenece cada dia. Los casos que se equivocan solos son los de fin de ano:
// la semana que reparte diciembre y enero, y los anos de 53 semanas.
import {
  construirNumeroSemanal,
  diasDeLaSemana,
  domingoDe,
  lunesDe,
  semanaIso,
} from '../src/services/reporteSemana.js';

let passed = 0; let failed = 0;
function ok(cond: boolean, label: string) {
  if (cond) passed++; else { failed++; console.log(`FAIL  ${label}`); }
}
function lanza(fn: () => unknown, label: string) {
  try { fn(); failed++; console.log(`FAIL  ${label} (no lanzo)`); }
  catch { passed++; }
}

// ---- de cualquier dia a su lunes y su domingo ----
{
  ok(lunesDe('2026-09-09') === '2026-09-07', 'el miercoles 9 pertenece al lunes 7');
  ok(lunesDe('2026-09-07') === '2026-09-07', 'el lunes es su propio lunes');
  ok(lunesDe('2026-09-13') === '2026-09-07', 'el domingo 13 cierra la semana del 7');
  ok(domingoDe('2026-09-09') === '2026-09-13', 'la semana del 7 termina el 13');
  ok(lunesDe('2026-09-14') === '2026-09-14', 'el lunes 14 ya es otra semana');

  // Cambio de mes dentro de la misma semana.
  ok(lunesDe('2026-09-02') === '2026-08-31', 'el 2 de septiembre cuelga del 31 de agosto');
  ok(domingoDe('2026-08-31') === '2026-09-06', 'esa semana termina el 6 de septiembre');
}

// ---- los siete dias ----
{
  const dias = diasDeLaSemana('2026-09-09');
  ok(dias.length === 7, 'la semana tiene siete dias');
  ok(dias[0] === '2026-09-07' && dias[6] === '2026-09-13', 'van de lunes a domingo');
  ok(diasDeLaSemana('2026-12-31')[0] === '2026-12-28',
     'la semana del 31 de diciembre de 2026 empieza el 28');
}

// ---- el numero ISO ----
{
  ok(semanaIso('2026-09-09').semana === 37, 'el 9 de septiembre de 2026 es la semana 37');
  ok(semanaIso('2026-09-09').anio === 2026, 'y es del ano 2026');
  ok(semanaIso('2026-09-07').semana === 37, 'su lunes da la misma semana');
  ok(semanaIso('2026-09-13').semana === 37, 'su domingo tambien');
  ok(semanaIso('2026-09-14').semana === 38, 'el lunes siguiente ya es la 38');
  ok(semanaIso('2026-01-01').semana === 1, 'el 1 de enero de 2026 es la semana 1');

  // El ano de la semana NO es siempre el del lunes.
  ok(semanaIso('2025-12-29').anio === 2026 && semanaIso('2025-12-29').semana === 1,
     'el 29 de diciembre de 2025 es la semana 1 de 2026');
  ok(semanaIso('2027-01-01').anio === 2026 && semanaIso('2027-01-01').semana === 53,
     'el 1 de enero de 2027 todavia es la semana 53 de 2026');

  // 2026 es de 53 semanas; 2025, de 52.
  ok(semanaIso('2026-12-28').semana === 53, '2026 llega a la semana 53');
  ok(semanaIso('2025-12-22').semana === 52 && semanaIso('2025-12-29').semana === 1,
     '2025 se queda en 52 semanas');

  // Un ano bisiesto que empieza en jueves tambien llega a 53.
  ok(semanaIso('2032-12-27').semana === 53, '2032 llega a la semana 53');
}

// ---- el numero del reporte ----
{
  ok(construirNumeroSemanal('PB', '2026-09-09') === 'RS-PB-260907',
     'el numero lleva la fecha del lunes, no la del dia que se pide');
  ok(construirNumeroSemanal('PB', '2026-09-07') === 'RS-PB-260907',
     'desde el lunes da lo mismo');
  ok(construirNumeroSemanal('et', '2026-09-13') === 'RS-ET-260907',
     'el prefijo sube a mayusculas');

  // Dos semanas seguidas no pueden dar el mismo numero.
  ok(construirNumeroSemanal('PB', '2026-09-14') === 'RS-PB-260914',
     'la semana siguiente lleva su propio lunes');
}

// ---- lo que no existe ----
{
  lanza(() => lunesDe('2026-13-01'), 'mes 13');
  lanza(() => lunesDe('2026-02-30'), '30 de febrero');
  lanza(() => lunesDe('08/09/2026'), 'fecha con otra forma');
  lanza(() => semanaIso(''), 'fecha vacia');
  lanza(() => construirNumeroSemanal('', '2026-09-07'), 'proyecto sin prefijo');
}

// El proyecto sin prefijo tiene que dar el error que la ruta sabe traducir.
{
  try {
    construirNumeroSemanal('', '2026-09-07');
  } catch (e) {
    ok((e as Error).message === 'PREFIJO_NO_CONFIGURADO',
       'el proyecto sin prefijo lanza PREFIJO_NO_CONFIGURADO');
  }
}

console.log(`\n${passed} pasaron, ${failed} fallaron`);
process.exit(failed === 0 ? 0 : 1);
