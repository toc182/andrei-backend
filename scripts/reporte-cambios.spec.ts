// Red de seguridad del rastro de correcciones de los reportes diarios.
// cd andrei-backend && npx tsx scripts/reporte-cambios.spec.ts
//
// Se decidio que toda correccion quede registrada con quien, que y cuando.
// Lo que sale de aqui se imprime en el PDF, asi que dos fallas cuestan caro:
// no registrar un cambio real, y registrar ruido hasta que el rastro deje de
// leerse.
import {
  diffCampos, diffFilas, parseHoras, fusionarCambios, sumarACorreccion,
  legibleCorreccion, cambiosDeLeyendas, leyendasCambiadas, normLeyenda,
  type Cambio, type CambioLegible, type FilaComparable, type FotoCorregida,
} from '../src/services/reporteCambios.js';

let passed = 0; let failed = 0;
function ok(cond: boolean, label: string) {
  if (cond) passed++; else { failed++; console.log(`FAIL  ${label}`); }
}
const campos = (o: object) => Object.keys(o).sort().join(',');

// Una correccion como texto plano, para poder compararla: [-quitado] [+agregado],
// «…» donde se recorta, (nota), « / » entre renglones y « | » entre campos.
const plano = (l: CambioLegible[]) =>
  l.map((k) => `${k.etiqueta}: ${k.renglones
    .map((r) => r.map((t) => {
      switch (t.tipo) {
        case 'quitado': return `[-${t.texto}]`;
        case 'agregado': return `[+${t.texto}]`;
        case 'nota': return `(${t.texto})`;
        default: return t.texto;
      }
    }).join(' '))
    .join(' / ')}`).join(' | ');

const leer = (
  cambios: Record<string, Cambio>,
  fotos: { agregadas?: FotoCorregida[]; quitadas?: FotoCorregida[] } = {},
) => plano(legibleCorreccion({
  cambios,
  fotos_agregadas: fotos.agregadas ?? [],
  fotos_quitadas: fotos.quitadas ?? [],
}));

// Los dos textos de verdad de la correccion de Cesar en RD-PBR-260915
// (audit_log 2093, produccion): agrego un renglon al final.
const CESAR_ANTES = [
  '-Se inicia con la conformación de estribos de pedestales.',
  '-Se termina corte de barras verticales en L de pedestales.',
  '-Se desencofran las calzas de concreto para levantar las parrillas.',
  '-Se inicia con el armado de caras de formaleta de plywood de pedestales.',
  '- Continuamos con el carte de barras para iniciar armado de estribos de vigas sismicas.',
  '-Coordinamos en sitio con el Ing. Juan Ramón  las excavaciones de las zapataz de los pedestales.',
  '-El Ing. Juan Ramón confirma que mañana entrara una segunda retroexcavadora.',
  '-Oficina confirma llegada de tuberias al proyecto el 16 de septiembre de 2026.',
  '-Continuamos con el plan de vaciar 13 zapataz el día viernes a primera hora.',
  '-Me comunique con el plomero Rafael para que entre el día lunes 21 de septiembre de 2026 a la obra.',
].join('\n');
const CESAR_DESPUES = `${CESAR_ANTES}\n-Se arma completo el acero de refuerzo del primer pedestal.`;
const trabajo = (antes: string | null, despues: string | null) =>
  ({ que_se_hizo: { label: 'Trabajo ejecutado', antes, despues } });

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
  ok(leer(c) === 'Horas perdidas: [-0] [+1.5] | Motivo: [+Aguacero de 2:10 a 3:40 pm]',
     `lo de antes tachado, lo nuevo subrayado, y lo que no estaba solo subrayado (salio «${leer(c)}»)`);
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
  ok(campos(diffCampos({ areas: ['Torre', 'Losa'] }, { areas: ['Losa', 'Torre'] })) === '',
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
  ok(leer(vacia) === 'Equipo utilizado: [-Mixer]', 'y sale solo tachado');

  const areas = diffCampos({ areas: ['Losa'] }, { areas: ['Torre', 'Losa'] });
  ok(leer(areas) === 'Áreas: [-Losa] [+Losa, Torre]', `las areas se leen por nombre (salio «${leer(areas)}»)`);
}

// ---- la fecha llega de dos formas distintas ----
{
  ok(campos(diffCampos({ fecha: new Date('2026-09-08T00:00:00Z') }, { fecha: '2026-09-08' })) === '',
     'la Date de la base y el texto del formulario son la misma fecha');
  const c = diffCampos({ fecha: '2026-09-08' }, { fecha: '2026-09-07' });
  ok(c.fecha.antes === '2026-09-08' && c.fecha.despues === '2026-09-07',
     'corregir la fecha si queda registrado');
  ok(leer(c) === 'Fecha: [-8 sep 2026] [+7 sep 2026]', 'y se lee como fecha, no como 2026-09-08');
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

// ---- filas: Personal y Equipo, donde una fila ausente vale cero ----
{
  const antes: FilaComparable[] = [
    { clave: 'puesto:1', label: 'Calificados', valor: 14 },
    { clave: 'puesto:2', label: 'Ayudantes', valor: 9 },
  ];
  const despues: FilaComparable[] = [
    { clave: 'puesto:1', label: 'Calificados', valor: 14 },
    { clave: 'puesto:2', label: 'Ayudantes', valor: 5 },
  ];
  const c = diffFilas(antes, despues);
  ok(campos(c) === 'puesto:2', 'solo la fila que cambio entra al rastro');
  ok(c['puesto:2'].antes === 9 && c['puesto:2'].despues === 5, 'guarda de 9 a 5');
  ok(leer(c) === 'Ayudantes: [-9] [+5]', 'se lee con el 9 tachado y el 5 subrayado');
}

{
  // Una fila que no estaba significa cero, no "se agrego": es la regla
  // acordada de que la casilla vacia es cero.
  const c = diffFilas([], [{ clave: 'puesto:3', label: 'Timekeeper', valor: 1 }]);
  ok(leer(c) === 'Timekeeper: [-0] [+1]', 'una fila nueva se lee desde cero');
}

{
  const c = diffFilas([{ clave: 'puesto:3', label: 'Timekeeper', valor: 1 }], []);
  ok(leer(c) === 'Timekeeper: [-1] [+0]', 'una fila que desaparece cae a cero');
}

{
  const iguales: FilaComparable[] = [
    { clave: 'equipo:1', label: 'Retroexcavadora', valor: '1 u · 6 h' },
  ];
  ok(campos(diffFilas(iguales, iguales)) === '', 'un guardado que no movio nada no deja linea');
}

{
  // El mismo puesto en dos bloques son dos filas distintas: la clave lleva el
  // id, no el nombre. Sin esto, cambiar los ayudantes de un subcontratista
  // pisaria a los propios en el rastro.
  const c = diffFilas(
    [
      { clave: 'puesto:2', label: 'Ayudantes', valor: 9 },
      { clave: 'puesto:7', label: 'Aceros del Caribe · Ayudantes', valor: 2 },
    ],
    [
      { clave: 'puesto:2', label: 'Ayudantes', valor: 9 },
      { clave: 'puesto:7', label: 'Aceros del Caribe · Ayudantes', valor: 4 },
    ],
  );
  ok(campos(c) === 'puesto:7', 'dos bloques con el mismo puesto no se confunden');
  ok(leer(c) === 'Aceros del Caribe · Ayudantes: [-2] [+4]', 'el nombre dice de que empresa es');
}

// ---- filas: Entregas, donde no hay cero posible ----
{
  const c = diffFilas([], [{ clave: 'entrega:varilla #5', label: 'Varilla #5', valor: '2 ton' }], null);
  ok(leer(c) === 'Entregas: [+Varilla #5 · 2 ton]', 'una entrega nueva se agrega entera, no sube de cero');
}

{
  const c = diffFilas([{ clave: 'entrega:varilla #5', label: 'Varilla #5', valor: '2 ton' }], [], null);
  ok(leer(c) === 'Entregas: [-Varilla #5 · 2 ton]', 'una entrega borrada sale tachada entera');
}

{
  const c = diffFilas([], [{ clave: 'entrega:arena', label: 'Arena', valor: '—' }], null);
  ok(leer(c) === 'Entregas: [+Arena]', 'una entrega sin cantidad no arrastra el guion');
}

{
  const c = diffFilas(
    [{ clave: 'entrega:varilla #5', label: 'Varilla #5', valor: '2 ton' }],
    [{ clave: 'entrega:varilla #5', label: 'Varilla #5', valor: '3 ton' }],
    null,
  );
  ok(leer(c) === 'Entregas: Varilla #5 [-2 ton] [+3 ton]', 'una entrega corregida marca solo la cantidad');
}

// ---- textos largos: solo lo que cambio ----
{
  const l = leer(trabajo(CESAR_ANTES, CESAR_DESPUES));
  ok(l === 'Trabajo ejecutado: [+-Se arma completo el acero de refuerzo del primer pedestal.]',
     `la correccion real de Cesar muestra solo el renglon que agrego (salio «${l}»)`);
}

{
  const despues = CESAR_ANTES.replace('vaciar 13 zapataz', 'vaciar 12 zapataz');
  const l = leer(trabajo(CESAR_ANTES, despues));
  ok(l === 'Trabajo ejecutado: -Continuamos con el plan de vaciar [-13] [+12] zapataz el día viernes a primera hora.',
     `un numero cambiado dentro de un renglon marca solo el numero (salio «${l}»)`);
}

{
  const despues = CESAR_ANTES.replace(
    '-El Ing. Juan Ramón confirma que mañana entrara una segunda retroexcavadora.\n', '');
  const l = leer(trabajo(CESAR_ANTES, despues));
  ok(l === 'Trabajo ejecutado: [--El Ing. Juan Ramón confirma que mañana entrara una segunda retroexcavadora.]',
     `un renglon borrado sale tachado entero (salio «${l}»)`);
}

{
  const antes = 'Desde temprano se esperaba el equipo pesado para excavar las zapatas del eje B, ' +
    'pero la retroexcavadora llegó a las 10:00 am y no se pudo empezar hasta después del almuerzo por falta de operador.';
  const despues = antes.replace('10:00', '11:30');
  const l = leer({ atrasos: { label: 'Atrasos o impedimentos', antes, despues } });
  ok(l === 'Atrasos o impedimentos: … pero la retroexcavadora llegó a las [-10:00] [+11:30] am y no se pudo empezar …',
     `en un parrafo sin saltos se ven unas palabras a cada lado (salio «${l}»)`);

  const dos = antes.replace('10:00', '11:30').replace('almuerzo', 'mediodía');
  const l2 = leer({ atrasos: { label: 'Atrasos o impedimentos', antes, despues: dos } });
  ok(l2 === 'Atrasos o impedimentos: … pero la retroexcavadora llegó a las [-10:00] [+11:30] am y no se pudo empezar hasta después del [-almuerzo] [+mediodía] por falta de operador.',
     `dos cambios cercanos comparten las palabras de en medio (salio «${l2}»)`);

  const lejos = `${antes} Se reprograma todo para el sábado temprano con el operador de la otra obra que ya confirmó.`;
  const lejosDespues = lejos.replace('10:00', '11:30').replace('sábado', 'domingo');
  const l3 = leer({ atrasos: { label: 'Atrasos o impedimentos', antes: lejos, despues: lejosDespues } });
  ok(l3 === 'Atrasos o impedimentos: … pero la retroexcavadora llegó a las [-10:00] [+11:30] am y no se pudo empezar … operador. Se reprograma todo para el [-sábado] [+domingo] temprano con el operador de la …',
     `dos cambios lejanos se separan con «…» en medio (salio «${l3}»)`);
}

{
  // Visto en la pantalla de verdad el 2026-09-16: un numero corregido en un
  // parrafo y una actividad nueva debajo, en el mismo guardado. El parrafo
  // salia entero tachado y reescrito.
  const antes = 'Vaciado de losa de piso en el área de chorros, 42 m³ de concreto de 4000 psi. ' +
    'Se continuó el armado de acero en el nivel 2 de la torre péndulo, quedando listos los ejes 3 al 7.';
  const despues = `${antes.replace('42 m³', '45 m³')}\n-Se desencofra la losa del nivel 1.`;
  const l = leer(trabajo(antes, despues));
  ok(l === 'Trabajo ejecutado: … piso en el área de chorros, [-42] [+45] m³ de concreto de 4000 psi. … / [+-Se desencofra la losa del nivel 1.]',
     `un renglon editado y uno nuevo en el mismo guardado: el editado marca solo el numero (salio «${l}»)`);

  const conQuitado = leer(trabajo(`-Uno.\n${antes}`, despues));
  ok(conQuitado === 'Trabajo ejecutado: [--Uno.] / … piso en el área de chorros, [-42] [+45] m³ de concreto de 4000 psi. … / [+-Se desencofra la losa del nivel 1.]',
     `y si ademas se borro un renglon, ese sale tachado aparte (salio «${conQuitado}»)`);
}

{
  const l = leer({ novedades: {
    label: 'Novedades del día',
    antes: '-Visita del inspector a las 9 am.',
    despues: '-Visita del inspector de ETESA a las 10 am; aprueba el acero de 4 pedestales.',
  } });
  ok(l === 'Novedades del día: [--Visita del inspector a las 9 am.] / [+-Visita del inspector de ETESA a las 10 am; aprueba el acero de 4 pedestales.]',
     `un renglon muy cambiado sale entero, el viejo tachado y el nuevo subrayado (salio «${l}»)`);
}

{
  const l = leer({ atrasos: { label: 'Atrasos o impedimentos', antes: null, despues: '-Falta cemento.\n-Llovió.' } });
  ok(l === 'Atrasos o impedimentos: [+-Falta cemento.] / [+-Llovió.]', 'un texto que antes no estaba sale subrayado');
}

{
  const nuevos = ['-Uno.', '-Dos.', '-Tres.', '-Cuatro.', '-Cinco.'].join('\n');
  const l = leer({ novedades: { label: 'Novedades del día', antes: '-Base.', despues: `-Base.\n${nuevos}` } });
  ok(l === 'Novedades del día: [+-Uno.] / [+-Dos.] / [+-Tres.] / (y 2 cambios más en este texto)',
     `de un texto muy cambiado se ven los 3 primeros cambios y cuantos faltan (salio «${l}»)`);
  const l1 = leer({ novedades: { label: 'Novedades del día', antes: '-Base.', despues: `-Base.\n${['-Uno.', '-Dos.', '-Tres.', '-Cuatro.'].join('\n')}` } });
  ok(l1.endsWith('(y 1 cambio más en este texto)'), 'en singular cuando falta uno');
}

{
  ok(leer(trabajo('-Coordinamos con el Ing.  Juan', '-Coordinamos con el Ing. Juan')) === '',
     'un espacio doble quitado no es un cambio que se muestre');
  ok(leer(trabajo('-Uno.\n-Dos.', '-Uno.\n\n-Dos.\n')) === '',
     'un renglon en blanco de mas tampoco');
}

// ---- la linea entera de una correccion: campos y fotos juntos ----
{
  const foto = (id: number) => ({ id, nombre: 'image.jpg' });

  ok(leer({}) === '', 'una correccion que no movio nada queda vacia, y asi no se muestra');
  ok(leer({}, { agregadas: [foto(1)] }) === 'Fotos: se agregó 1', 'una foto agregada, en singular');
  ok(leer({}, { agregadas: [foto(1), foto(2)] }) === 'Fotos: se agregaron 2', 'varias, en plural');
  ok(leer({}, { quitadas: [foto(3)] }) === 'Fotos: se quitó 1', 'una foto quitada');
  ok(leer({}, { quitadas: [foto(3), foto(4)] }) === 'Fotos: se quitaron 2', 'varias quitadas');
  ok(!leer({}, { agregadas: [foto(1)] }).includes('image.jpg'), 'las fotos se cuentan, no se nombran');

  // El orden es el del formulario, aunque los cambios lleguen en otro: los de
  // un reintento se agregan al final del objeto.
  const todo = leer(
    {
      ...diffFilas([{ clave: 'puesto:2', label: 'Ayudantes', valor: 9 }],
        [{ clave: 'puesto:2', label: 'Ayudantes', valor: 5 }]),
      ...trabajo(CESAR_ANTES, CESAR_DESPUES),
      ...diffCampos({ clima: 'Soleado' }, { clima: 'Nublado' }),
    },
    { agregadas: [foto(1), foto(2)], quitadas: [foto(3)] },
  );
  ok(todo === 'Clima: [-Soleado] [+Nublado] | Trabajo ejecutado: [+-Se arma completo el acero de refuerzo del primer pedestal.] | Ayudantes: [-9] [+5] | Fotos: se agregaron 2 / se quitó 1',
     `los campos en el orden del formulario, despues las filas y al final las fotos (salio «${todo}»)`);
}

// ---- varios guardados de la MISMA correccion (el reintento tras un corte) ----
{
  const primero = diffCampos({ clima: 'Soleado', motivo: null }, { clima: 'Nublado' });
  const segundo = diffCampos({ clima: 'Nublado', motivo: null }, { clima: 'Lluvia parcial', motivo: 'Aguacero' });
  const junto = fusionarCambios(primero, segundo);
  ok(campos(junto) === 'clima,motivo', 'se juntan los campos de los dos guardados');
  ok(junto.clima.antes === 'Soleado' && junto.clima.despues === 'Lluvia parcial',
     'de cada campo queda el antes del primero y el despues del ultimo');

  const vuelta = fusionarCambios(primero, diffCampos({ clima: 'Nublado' }, { clima: 'Soleado' }));
  ok(campos(vuelta) === '', 'un campo que volvio a como estaba ya no es un cambio');

  const horas = fusionarCambios(
    diffCampos({ horas_perdidas: null }, { horas_perdidas: 2 }),
    diffCampos({ horas_perdidas: 2 }, { horas_perdidas: '0' }),
  );
  ok(campos(horas) === '', 'lo mismo con un numero que vuelve a cero');

  ok(campos(fusionarCambios(primero, {})) === 'clima',
     'un guardado sin cambios no borra lo que ya estaba');
}

{
  const foto = (id: number) => ({ id, nombre: 'image.jpg' });
  const vacia = { cambios: {}, fotos_agregadas: [], fotos_quitadas: [] };

  const dos = sumarACorreccion(
    sumarACorreccion(vacia, { fotosAgregadas: [foto(1)] }),
    { fotosAgregadas: [foto(2)] },
  );
  ok(dos.fotos_agregadas.length === 2, 'las fotos subidas de una en una se suman en la misma linea');

  const sinUna = sumarACorreccion(dos, { fotosQuitadas: [foto(2)] });
  ok(sinUna.fotos_agregadas.length === 1 && sinUna.fotos_quitadas.length === 0,
     'quitar una foto que se agrego en la misma correccion la descuenta, no la anota como quitada');

  const vieja = sumarACorreccion(dos, { fotosQuitadas: [foto(9)] });
  ok(vieja.fotos_quitadas.length === 1 && vieja.fotos_agregadas.length === 2,
     'quitar una foto que ya estaba en el reporte si se anota como quitada');

  const nada = sumarACorreccion(sumarACorreccion(vacia, { fotosAgregadas: [foto(5)] }),
    { fotosQuitadas: [foto(5)] });
  ok(legibleCorreccion(nada).length === 0, 'agregar y quitar la misma foto no deja nada que mostrar');
}

// ---- leyendas de las fotos ----
{
  const C4 = 'Acero de columna C-4 listo para vaciado';
  const C5 = 'Acero de columna C-5 listo para vaciado';
  // Tres fotos, en el orden del reporte: de ahi sale «la foto 3».
  const fotos = [
    { id: 11, leyenda: 'Encofrado de vigas del eje B' },
    { id: 12, leyenda: null },
    { id: 13, leyenda: C4 },
  ];
  const leyendas = (despues: { id: number; leyenda?: string | null }[]) =>
    cambiosDeLeyendas(leyendasCambiadas(fotos, despues));

  ok(normLeyenda('  Acero\nde   columna  ') === 'Acero de columna',
     'una leyenda se guarda en un renglon y sin espacios de mas');
  ok(normLeyenda('   ') === null && normLeyenda(null) === null && normLeyenda(undefined) === null,
     'en blanco es sin leyenda');

  const c5 = leyendas([{ id: 13, leyenda: C5 }]);
  ok(campos(c5) === 'leyenda:13' && c5['leyenda:13'].label === 'Leyenda de la foto 3',
     'se nombra por su numero en el reporte, no por su id');
  ok(leer(c5) === 'Leyenda de la foto 3: Acero de columna [-C-4] [+C-5] listo para vaciado',
     `se marca solo la palabra que cambio (salio «${leer(c5)}»)`);

  ok(leer(leyendas([{ id: 12, leyenda: 'Losa' }])) === 'Leyenda de la foto 2: [+Losa]',
     'escribir una donde no habia');
  ok(leer(leyendas([{ id: 11, leyenda: '' }])) === 'Leyenda de la foto 1: [-Encofrado de vigas del eje B]',
     'borrarla');
  ok(campos(leyendas([
    { id: 11, leyenda: ' Encofrado  de vigas del eje B ' },
    { id: 12, leyenda: '' },
    { id: 13, leyenda: C4 },
  ])) === '', 'mandar las mismas, con espacios de mas o en blanco donde no habia, no es un cambio');
  ok(campos(leyendas([{ id: 12 }, { id: 13, leyenda: undefined }])) === '',
     'una foto que viene sin leyenda no se esta tocando');
  ok(campos(leyendas([{ id: 99, leyenda: 'Ajena' }])) === '',
     'una foto que no es de este reporte no cuenta');

  const conCampos = leer({
    ...leyendas([{ id: 13, leyenda: C5 }]),
    ...diffCampos({ clima: 'Soleado' }, { clima: 'Nublado' }),
  }, { agregadas: [{ id: 20, nombre: 'image.jpg' }] });
  ok(conCampos === 'Clima: [-Soleado] [+Nublado] | Leyenda de la foto 3: Acero de columna [-C-4] [+C-5] listo para vaciado | Fotos: se agregó 1',
     `las leyendas van despues de los campos y antes de las fotos (salio «${conCampos}»)`);

  // El reintento: la foto 4 subio con su leyenda en esta misma correccion, el
  // ingeniero la retoco y el siguiente guardado la manda como cambio.
  const vacia = { cambios: {}, fotos_agregadas: [], fotos_quitadas: [] };
  const conNueva = sumarACorreccion(
    sumarACorreccion(vacia, { fotosAgregadas: [{ id: 14, nombre: 'image.jpg' }] }),
    { cambios: {
      'leyenda:14': { label: 'Leyenda de la foto 4', antes: 'Losa', despues: 'Losa nivel 2' },
      ...leyendas([{ id: 13, leyenda: C5 }]),
    } },
  );
  ok(campos(conNueva.cambios) === 'leyenda:13',
     'la leyenda de una foto que agrego esta misma correccion no se anota aparte; la de una vieja si');
  const yQuitada = sumarACorreccion(conNueva, {
    cambios: { 'leyenda:14': { label: 'Leyenda de la foto 4', antes: 'Losa nivel 2', despues: 'Losa' } },
    fotosQuitadas: [{ id: 14, nombre: 'image.jpg' }],
  });
  ok(campos(yQuitada.cambios) === 'leyenda:13' && yQuitada.fotos_agregadas.length === 0,
     'ni la de una foto que se agrego y se quito dentro de la misma correccion');
}

console.log(`\n${passed} pasaron, ${failed} fallaron`);
process.exit(failed === 0 ? 0 : 1);
