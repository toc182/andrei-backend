// Red de seguridad de la numeracion de reportes diarios.
// cd andrei-backend && npx tsx scripts/reporte-numero.spec.ts
//
// El numero sale impreso en el PDF que se manda por correo y es como la gente
// va a referirse a un reporte. Si se corre un digito o se repite, se nota
// tarde y en papel.
import { construirNumeroReporte } from '../src/services/reporteNumero.js';

let passed = 0; let failed = 0;
function ok(cond: boolean, label: string) {
  if (cond) passed++; else { failed++; console.log(`FAIL  ${label}`); }
}
function lanza(fn: () => unknown, label: string) {
  try { fn(); failed++; console.log(`FAIL  ${label} (no lanzo)`); }
  catch { passed++; }
}

// ---- el caso corriente ----
{
  ok(construirNumeroReporte('PB', '2026-09-08', 0) === 'RD-PB-260908',
     'primero del dia: RD-PB-260908');
  ok(construirNumeroReporte('ET', '2026-09-08', 0) === 'RD-ET-260908',
     'el prefijo es el del proyecto');
}

// ---- repetidos en la misma fecha ----
{
  ok(construirNumeroReporte('PB', '2026-09-08', 1) === 'RD-PB-260908-2',
     'el segundo del dia lleva -2');
  ok(construirNumeroReporte('PB', '2026-09-08', 2) === 'RD-PB-260908-3',
     'el tercero lleva -3');
  ok(construirNumeroReporte('PB', '2026-09-08', 9) === 'RD-PB-260908-10',
     'el decimo lleva -10, sin rellenar con ceros');

  // Todos distintos entre si: es lo unico que protege el indice unico.
  const diez = Array.from({ length: 10 }, (_, i) =>
    construirNumeroReporte('PB', '2026-09-08', i));
  ok(new Set(diez).size === 10, 'diez reportes del mismo dia dan diez numeros distintos');
}

// ---- relleno de mes y dia ----
{
  ok(construirNumeroReporte('PB', '2026-01-05', 0) === 'RD-PB-260105',
     'enero dia 5: 260105, con los ceros');
  ok(construirNumeroReporte('PB', '2026-12-31', 0) === 'RD-PB-261231',
     'ultimo dia del ano');
  ok(construirNumeroReporte('PB', '2030-03-09', 0) === 'RD-PB-300309',
     'ano 2030 da 30');
  ok(construirNumeroReporte('PB', '2028-02-29', 0) === 'RD-PB-280229',
     '2028 si es bisiesto: el 29 de febrero se numera');
}

// ---- el prefijo se normaliza ----
{
  ok(construirNumeroReporte('pb', '2026-09-08', 0) === 'RD-PB-260908',
     'prefijo en minusculas sube a mayusculas');
  ok(construirNumeroReporte('  PB  ', '2026-09-08', 0) === 'RD-PB-260908',
     'prefijo con espacios se recorta');
}

// ---- entradas que no deben pasar en silencio ----
{
  lanza(() => construirNumeroReporte('', '2026-09-08', 0),
        'proyecto sin prefijo configurado');
  lanza(() => construirNumeroReporte('   ', '2026-09-08', 0),
        'prefijo de puros espacios');
  lanza(() => construirNumeroReporte('PB', '08/09/2026', 0),
        'fecha en otro formato');
  lanza(() => construirNumeroReporte('PB', '2026-9-8', 0),
        'fecha sin ceros de relleno');
  lanza(() => construirNumeroReporte('PB', '2026-13-01', 0),
        'mes 13');
  lanza(() => construirNumeroReporte('PB', '2026-02-30', 0),
        '30 de febrero');
  lanza(() => construirNumeroReporte('PB', '2026-02-29', 0),
        '29 de febrero de un ano que no es bisiesto');
  lanza(() => construirNumeroReporte('PB', '2026-09-08', -1),
        'cantidad negativa de existentes');
  lanza(() => construirNumeroReporte('PB', '2026-09-08', 1.5),
        'cantidad no entera');
}

// El proyecto sin prefijo tiene que dar el error que la ruta sabe traducir a
// un mensaje entendible, no uno cualquiera.
{
  try {
    construirNumeroReporte('', '2026-09-08', 0);
  } catch (e) {
    ok((e as Error).message === 'PREFIJO_NO_CONFIGURADO',
       'el proyecto sin prefijo lanza PREFIJO_NO_CONFIGURADO');
  }
}

console.log(`\n${passed} pasaron, ${failed} fallaron`);
process.exit(failed === 0 ? 0 : 1);
