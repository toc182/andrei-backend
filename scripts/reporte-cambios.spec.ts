// Red de seguridad del rastro de correcciones de los reportes diarios.
// cd andrei-backend && npx tsx scripts/reporte-cambios.spec.ts
//
// Se decidio que toda correccion quede registrada con quien, que y cuando.
// Lo que sale de aqui se imprime en el PDF, asi que dos fallas cuestan caro:
// no registrar un cambio real, y registrar ruido hasta que el rastro deje de
// leerse.
import {
  diffCampos, describirCambios, parseHoras,
} from '../src/services/reporteCambios.js';

let passed = 0; let failed = 0;
function ok(cond: boolean, label: string) {
  if (cond) passed++; else { failed++; console.log(`FAIL  ${label}`); }
}
const campos = (o: object) => Object.keys(o).sort().join(',');

// ---- el caso que conto Ivan: se corrigen las horas y se agrega el motivo ----
{
  const c = diffCampos(
    { horas_perdidas: null, motivo: null },
    { horas_perdidas: 1.5, motivo: 'Aguacero de 2:10 a 3:40 pm' },
  );
  ok(campos(c) === 'horas_perdidas,motivo', 'registra los dos campos que se movieron');
  ok(c.horas_perdidas.antes === 0, 'las horas en blanco se muestran como 0, que es lo que significan');
  ok(c.horas_perdidas.despues === 1.5, 'y el valor nuevo');
  ok(c.horas_perdidas.label === 'Horas perdidas', 'con el nombre que usa la gente, no el de la columna');
  ok(describirCambios(c).includes('Horas perdidas de 0 a 1.5'), 'la linea se lee como en el PDF');
  ok(describirCambios(c).includes('se agregó Motivo'), 'lo que antes no estaba se describe como agregado');
}

// ---- lo que NO debe ensuciar el rastro ----
{
  ok(campos(diffCampos({ que_se_hizo: 'Vaciado de losa' }, { que_se_hizo: 'Vaciado de losa' })) === '',
     'guardar sin cambiar nada no deja rastro');
  ok(campos(diffCampos({ motivo: null }, { motivo: '' })) === '',
     'vacio y ausente son lo mismo: no es un cambio');
  ok(campos(diffCampos({ motivo: 'Lluvia' }, { motivo: '  Lluvia  ' })) === '',
     'espacios de sobra no son un cambio');
  ok(campos(diffCampos({ horas_perdidas: null }, { horas_perdidas: 0 })) === '',
     'en blanco y 0 son lo mismo: no es un cambio');
  ok(campos(diffCampos({ horas_perdidas: 2 }, { horas_perdidas: '2' })) === '',
     'el 2 que llega como texto desde el formulario no es un cambio');
  ok(campos(diffCampos({ equipo: ['Mixer', 'Bomba'] }, { equipo: ['Bomba', 'Mixer'] })) === '',
     'reordenar el equipo sin agregar ni quitar no es una correccion');
  ok(campos(diffCampos({ areas: [3, 1] }, { areas: [1, 3] })) === '',
     'lo mismo con las areas');
}

// ---- un guardado parcial no inventa cambios ----
{
  const c = diffCampos(
    { clima: 'Soleado', que_se_hizo: 'Vaciado', motivo: 'Lluvia' },
    { clima: 'Nublado' },
  );
  ok(campos(c) === 'clima', 'solo cambia lo que el guardado menciona');
  ok(!('motivo' in c), 'un campo que no viene no se reporta como borrado');
  ok(!('que_se_hizo' in c), 'ni el otro');
}
{
  const c = diffCampos({ motivo: 'Lluvia' }, { motivo: undefined, clima: 'Nublado' });
  ok(campos(c) === 'clima', 'undefined cuenta como "no lo estoy tocando"');
}

// ---- cambios reales en listas ----
{
  const c = diffCampos({ equipo: ['Mixer'] }, { equipo: ['Mixer', 'Bomba'] });
  ok(campos(c) === 'equipo', 'agregar equipo si es un cambio');
  ok(c.equipo.antes === 'Mixer' && c.equipo.despues === 'Bomba, Mixer',
     'se muestran como lista legible, no como corchetes');

  const vacia = diffCampos({ equipo: ['Mixer'] }, { equipo: [] });
  ok(vacia.equipo.despues === null, 'quedarse sin equipo se muestra como ausencia');
  ok(describirCambios(vacia).includes('se quitó Equipo utilizado'),
     'y se describe como quitado');
}

// ---- la fecha llega de dos formas distintas ----
{
  ok(campos(diffCampos({ fecha: new Date('2026-09-08T00:00:00Z') }, { fecha: '2026-09-08' })) === '',
     'la Date de la base y el texto del formulario son la misma fecha');
  const c = diffCampos({ fecha: '2026-09-08' }, { fecha: '2026-09-07' });
  ok(c.fecha.antes === '2026-09-08' && c.fecha.despues === '2026-09-07',
     'corregir la fecha si queda registrado');
}

// ---- los campos que no existen se ignoran ----
{
  ok(campos(diffCampos({ numero: 'RD-PB-260908' }, { numero: 'OTRO', id: 99 })) === '',
     'campos que no son del reporte no entran al rastro');
}

// ---- parseHoras ----
{
  ok(parseHoras('') === null, 'cadena vacia es null');
  ok(parseHoras(null) === null, 'null es null');
  ok(parseHoras(undefined) === null, 'undefined es null');
  ok(parseHoras('1.5') === 1.5, 'texto numerico se convierte');
  ok(parseHoras(0) === 0, 'el cero explicito se conserva');
  ok(parseHoras('abc') === null, 'basura no se convierte en NaN silencioso');
}

console.log(`\n${passed} pasaron, ${failed} fallaron`);
process.exit(failed === 0 ? 0 : 1);
