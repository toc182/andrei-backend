// Red de seguridad de lo que se le cuenta a la IA del reporte semanal.
// cd andrei-backend && npx tsx scripts/reporte-semanal-ia.spec.ts
//
// No llama a la IA: comprueba el texto que se le manda. Vale la pena porque un
// dato que no viaja es un dato que el modelo no puede escribir —y porque un
// campo vacío no debe ocupar una línea en blanco, que es como se enseña a un
// modelo a rellenar huecos.
import { diariosComoTexto } from '../src/services/reporteSemanalIA.js';

let passed = 0; let failed = 0;
function ok(cond: boolean, label: string) {
  if (cond) passed++; else { failed++; console.log(`FAIL  ${label}`); }
}

const lleno = {
  fecha: '2026-09-07',
  numero: 'RD-PB-260907',
  clima: 'Lluvia parcial',
  horas_perdidas: 3,
  motivo: 'Lluvia de 1 a 4 pm',
  areas: ['Bloque B', 'Bloque A'],
  que_se_hizo: 'Colado de la losa del nivel 3',
  atrasos: 'La planta no despachó a tiempo',
  novedades: 'Visita del inspector',
  personal: [
    { puesto: 'Carpinteros', empresa: null, cantidad: 6 },
    { puesto: 'Plomeros', empresa: 'Plomería Istmo', cantidad: 2 },
  ],
  equipos: [{ nombre: 'Grúa torre', horas: 9 }],
  entregas: [{ descripcion: 'Bloques de 6"', cantidad: 2400, unidad: 'u' }],
};

const vacio = {
  fecha: '2026-09-08',
  numero: 'RD-PB-260908',
  clima: 'Soleado',
  horas_perdidas: 0,
  motivo: null,
  areas: [],
  que_se_hizo: 'Encofrado de columnas',
  atrasos: null,
  novedades: null,
  personal: [],
  equipos: [],
  entregas: [],
};

// ---- lo que viaja ----
{
  const t = diariosComoTexto([lleno]);
  ok(t.includes('## 2026-09-07 (RD-PB-260907)'), 'cada día se encabeza con su fecha y su número');
  ok(t.includes('Clima: Lluvia parcial'), 'va el clima');
  ok(t.includes('Horas perdidas: 3 — Lluvia de 1 a 4 pm'), 'las horas perdidas van con su motivo');
  ok(t.includes('Áreas: Bloque B, Bloque A'), 'van las áreas');
  ok(t.includes('Trabajo ejecutado: Colado de la losa del nivel 3'), 'va lo que se hizo');
  ok(t.includes('Atrasos o impedimentos: La planta no despachó a tiempo'), 'van los atrasos');
  ok(t.includes('Novedades: Visita del inspector'), 'van las novedades');
  ok(t.includes('6 Carpinteros') && t.includes('2 Plomeros (Plomería Istmo)'),
     'el personal va con su puesto y su empresa');
  ok(t.includes('Grúa torre 9 h'), 'el equipo va con sus horas');
  ok(t.includes('Bloques de 6" — 2400 u'), 'las entregas van con su cantidad');
}

// ---- lo que NO viaja ----
{
  const t = diariosComoTexto([vacio]);
  ok(!t.includes('Horas perdidas'), 'un día sin horas perdidas no menciona horas perdidas');
  ok(!t.includes('Áreas'), 'sin áreas no hay línea de áreas');
  ok(!t.includes('Atrasos'), 'sin atrasos no hay línea de atrasos');
  ok(!t.includes('Novedades'), 'sin novedades no hay línea de novedades');
  ok(!t.includes('Personal') && !t.includes('Equipo') && !t.includes('Entregas'),
     'las secciones sin filas no dejan etiqueta vacía');
  ok(!t.includes('\n\n'), 'y no quedan renglones en blanco dentro de un día');
}

// ---- varios días ----
{
  const t = diariosComoTexto([lleno, vacio]);
  ok(t.indexOf('2026-09-07') < t.indexOf('2026-09-08'), 'los días van en el orden que llegan');
  ok(t.split('## ').length === 3, 'un bloque por día');
  ok(t.includes('\n\n## 2026-09-08'), 'separados por un renglón en blanco');
}

// ---- una entrega sin cantidad ----
{
  const t = diariosComoTexto([{
    ...vacio,
    entregas: [{ descripcion: 'Andamios', cantidad: null, unidad: null }],
  }]);
  ok(t.includes('Entregas: Andamios') && !t.includes('Andamios —'),
     'una entrega sin cantidad no arrastra un guion suelto');
}

console.log(`\n${passed} pasaron, ${failed} fallaron`);
process.exit(failed === 0 ? 0 : 1);
