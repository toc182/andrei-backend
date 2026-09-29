// Las siglas de las empresas en las tablas de Personal y Equipo del reporte.
// cd andrei-backend && npx tsx scripts/siglas-empresas.spec.ts
//
// Salen impresas en el PDF que se manda por correo, con su clave debajo. Si
// dos empresas quedaran con las mismas, la tabla diría que los ayudantes de una
// son de la otra.
import { columnasEmpresas, siglaDe } from '../src/services/siglasEmpresas.js';

let passed = 0; let failed = 0;
function ok(cond: boolean, label: string) {
  if (cond) passed++; else { failed++; console.log(`FAIL  ${label}`); }
}

// ---- las siglas de un nombre ----
ok(siglaDe('Consorcio Aguas de Santa Isabel') === 'CON', 'las tres primeras letras');
ok(siglaDe('Hermanos Rodríguez, S.A.') === 'HER', 'en mayúsculas');
ok(siglaDe('RODSA') === 'ROD', 'un nombre en mayúsculas igual');
ok(siglaDe('A.B. Obras') === 'ABO', 'los puntos y espacios no cuentan como letras');
ok(siglaDe('Toc') === 'TOC', 'un nombre corto sale entero');
ok(siglaDe('Ñandú Obras') === 'ÑAN', 'la Ñ se queda');
ok(siglaDe('  ') === '?', 'sin nombre no revienta');

// ---- las columnas del reporte ----
{
  const cols = columnasEmpresas('Consorcio Playa Blanca', [
    { empresa_id: 8, empresa_nombre: 'Hermanos Rodríguez, S.A.' },
    { empresa_id: null, empresa_nombre: null },
    { empresa_id: 8, empresa_nombre: 'Hermanos Rodríguez, S.A.' },
    { empresa_id: 3, empresa_nombre: 'Electromecánica del Istmo' },
  ]);
  ok(cols.map((c) => c.sigla).join(',') === 'CON,HER,ELE',
    'el propio primero, luego las empresas en el orden de las filas, sin repetir');
  ok(cols[0].empresa_id === null && cols[0].nombre === 'Consorcio Playa Blanca',
    'el propio lleva el nombre que se le pasa');
}
{
  const cols = columnasEmpresas('Pinellas', [
    { empresa_id: 1, empresa_nombre: 'Hermanos Rodríguez, S.A.' },
    { empresa_id: 2, empresa_nombre: 'Hermes Ingeniería' },
    { empresa_id: 4, empresa_nombre: 'Herrería Real Santeña' },
  ]);
  ok(cols.map((c) => c.sigla).join(',') === 'HER,HER2,HER3',
    'siglas repetidas se distinguen con un número');
  ok(!cols.some((c) => c.empresa_id === null),
    'sin filas del propio, el propio no es columna');
}
ok(columnasEmpresas('Pinellas', []).length === 0, 'un reporte sin filas no tiene columnas');

console.log(`${passed} pasaron, ${failed} fallaron`);
process.exit(failed ? 1 : 0);
