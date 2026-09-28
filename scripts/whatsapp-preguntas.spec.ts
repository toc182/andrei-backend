// Las preguntas fijas del reporte por WhatsApp: cual toca y como se lee la
// respuesta cuando no hace falta el modelo. Puro, sin base.
// cd andrei-backend && npx tsx scripts/whatsapp-preguntas.spec.ts
import {
  resolverRespuesta,
  siguientePregunta,
  enMinuscula,
  type EstadoReporte,
} from '../src/services/whatsapp/preguntasFijas.js';
import type { DatosReporte, ListasProyecto } from '../src/services/whatsapp/datosReporte.js';

let fallos = 0;
const exigir = (bien: boolean, que: string, visto?: unknown): void => {
  console.log(`${bien ? '  ok  ' : 'FALLA '} ${que}${bien || visto === undefined ? '' : ` → ${JSON.stringify(visto)}`}`);
  if (!bien) fallos += 1;
};

// Las areas en el orden de la lista, con ids que NO son su posicion: asi se ve
// si alguien confunde una cosa con la otra.
const listas: ListasProyecto = {
  areas: [{ id: 30, nombre: 'Torre A' }, { id: 10, nombre: 'Piscina' }, { id: 20, nombre: 'Acceso' }],
  puestos: [{ id: 1, nombre: 'Calificados', empresa: null }],
  equipos: [{ id: 5, nombre: 'Retroexcavadora' }],
  categorias: [{ id: 7, nombre: 'Material' }],
};
const obras = [{ id: 44, nombre: 'Playa Blanca' }, { id: 12, nombre: 'Santa Isabel' }];
const estado = (datos: DatosReporte, extra: Partial<EstadoReporte> = {}): EstadoReporte => ({
  datos, listas, fotos: 0, obras, hoyEnPalabras: 'lunes 28 de septiembre', ...extra,
});
const grupo = (datos: DatosReporte, extra: Partial<EstadoReporte> = {}) =>
  siguientePregunta(estado(datos, extra))?.grupo;
const hecha = (d: DatosReporte, g: string): DatosReporte => ({
  ...d, veces: { ...(d.veces ?? {}), [g]: (d.veces?.[g] ?? 0) + 1 }, ultimaPregunta: g,
});

// ── el orden ─────────────────────────────────────────────────────────────
{
  const sinObra = siguientePregunta(estado({}, { listas: null }));
  exigir(sinObra?.grupo === 'obra' && sinObra.texto.includes('1. Playa Blanca'), 'sin obra, se pregunta la obra con la lista numerada');
  exigir(siguientePregunta(estado({}, { listas: null, obras: [] })) === null, 'sin obras donde reportar, no se pregunta nada');

  const f = siguientePregunta(estado({ fecha: '2026-09-28' }));
  exigir(f?.grupo === 'fecha' && f.texto === '¿El reporte es de hoy, lunes 28 de septiembre?' && f.botones?.length === 2, 'lo primero es la fecha, con los dos botones');

  let d: DatosReporte = { fecha: '2026-09-28', preguntadas: ['fecha'] };
  const orden: string[] = [];
  for (let i = 0; i < 20; i += 1) {
    const p = siguientePregunta(estado(d));
    if (!p) break;
    orden.push(p.grupo);
    if (p.grupo === 'final') break;
    // Contesta todo a la primera.
    if (p.grupo === 'clima') d = { ...d, clima: 'Soleado' };
    else if (p.grupo === 'horas') d = { ...d, horasPerdidas: 0 };
    else if (p.grupo === 'areas') d = { ...d, areas: [30, 20] };
    else if (p.grupo.startsWith('trabajo:')) {
      const id = Number(p.grupo.split(':')[1]);
      d = { ...d, trabajos: [...(d.trabajos ?? []), { areaId: id, texto: 'algo' }] };
    } else if (p.grupo === 'mal') d = { ...d, preguntadas: [...(d.preguntadas ?? []), 'atrasos', 'novedades'] };
    else if (p.grupo === 'gente') d = { ...d, personal: [{ puestoId: 1, cantidad: 2 }] };
    else if (p.grupo === 'maquinas') d = { ...d, equipos: [] };
    else if (p.grupo === 'llego') d = { ...d, entregas: [] };
    else if (p.grupo === 'fotos') d = { ...d, preguntadas: [...(d.preguntadas ?? []), 'fotos'] };
    d = hecha(d, p.grupo);
  }
  exigir(
    orden.join(',') === 'clima,horas,areas,trabajo:30,trabajo:20,mal,gente,maquinas,llego,fotos,final',
    'contestando todo, sale en el orden del papel y un area por vez, en el orden de la lista',
    orden,
  );
}

// ── lo que ya conto no se pregunta ──────────────────────────────────────
{
  const d: DatosReporte = {
    fecha: '2026-09-28', preguntadas: ['fecha'], clima: 'Nublado', horasPerdidas: 0,
    trabajos: [{ areaId: 30, texto: 'zapatas' }], areas: [30], personal: [],
  };
  exigir(grupo(d) === 'mal', 'lo contado fuera de orden (el trabajo, la gente) no se vuelve a preguntar', grupo(d));
}

// ── dos veces, y despues se sigue ───────────────────────────────────────
{
  const d: DatosReporte = { fecha: '2026-09-28', preguntadas: ['fecha'] };
  const una = siguientePregunta(estado(hecha(d, 'clima')));
  exigir(una?.grupo === 'clima' && una.texto.startsWith('Me falta el clima'), 'la segunda vez sale con otras palabras', una?.texto);
  exigir(grupo(hecha(hecha(d, 'clima'), 'clima')) === 'horas', 'a la tercera se sigue con lo que sigue');

  let todo: DatosReporte = hecha(hecha(d, 'clima'), 'clima');
  for (const g of ['horas', 'areas', 'mal', 'gente', 'maquinas', 'llego', 'trabajo']) todo = hecha(hecha(todo, g), g);
  todo = hecha(todo, 'fotos');
  const alFinal = siguientePregunta(estado(todo));
  exigir(alFinal?.grupo === 'clima' && alFinal.texto.startsWith('Antes del borrador me falta el clima'), 'el clima que falta se pide otra vez antes del borrador', alFinal?.texto);
  const sinTrabajo = siguientePregunta(estado({ ...hecha(todo, 'clima'), clima: 'Soleado' }));
  exigir(sinTrabajo?.grupo === 'trabajo' && sinTrabajo.texto.includes('me falta lo que se hizo'), 'y el trabajo que falta, tambien', sinTrabajo?.texto);
  const fin = siguientePregunta(estado({ ...hecha(hecha(todo, 'clima'), 'trabajo'), clima: 'Soleado' }));
  exigir(fin?.grupo === 'final' && fin.botones?.[0].titulo === 'Mandar borrador', 'y al final, el borrador con sus botones');
}

// ── sin areas en la obra ────────────────────────────────────────────────
{
  const d: DatosReporte = { fecha: '2026-09-28', preguntadas: ['fecha'], clima: 'Soleado', horasPerdidas: 0 };
  exigir(grupo(d, { listas: { ...listas, areas: [] } }) === 'trabajo', 'una obra sin areas pregunta el trabajo en general');
}

// ── la respuesta, cuando no hace falta el modelo ────────────────────────
const leer = (datos: DatosReporte, dicho: string, mensajes = 1) =>
  resolverRespuesta({ datos, dicho, mensajes, listas, obras, hoy: '2026-09-28', hoyEnPalabras: 'lunes 28 de septiembre' });
{
  const f: DatosReporte = { fecha: '2026-09-28', ultimaPregunta: 'fecha' };
  const si = leer(f, 'Sí');
  exigir(si.tipo === 'resuelta' && (si.datos.preguntadas ?? []).includes('fecha'), '«Sí» a la fecha la confirma sin el modelo');
  for (const otra of ['Otra fecha', 'No, es de ayer', 'el 25', 'fue el viernes', 'No']) {
    exigir(leer(f, otra).tipo === 'modelo', `«${otra}» lo lee el modelo`);
  }
  const otraCosa = leer(f, 'Hoy colocamos 6 zapatas');
  exigir(otraCosa.tipo === 'aviso' && (otraCosa.datos.preguntadas ?? []).includes('fecha'), 'si contesta otra cosa, queda la de hoy y el modelo lo dice');
  exigir(leer(f, 'No se perdieron horas').tipo === 'aviso', '«no se perdieron horas» no es «no» a la fecha');

  const clima = leer({ ultimaPregunta: 'clima' }, '3');
  exigir(clima.tipo === 'resuelta' && clima.datos.clima === 'Lluvia parcial', 'un numero del clima lo resuelve el sistema');
  exigir(leer({ ultimaPregunta: 'clima' }, '7').tipo === 'modelo', 'un numero que no esta en la lista lo lee el modelo');

  const areas = leer({ ultimaPregunta: 'areas' }, '1 y 3');
  exigir(areas.tipo === 'resuelta' && JSON.stringify(areas.datos.areas) === '[30,20]', 'los numeros de las areas son la POSICION en la lista, no el id', areas);
  exigir(leer({ ultimaPregunta: 'areas' }, '1, 4').tipo === 'modelo', 'un area fuera de la lista la lee el modelo');
  exigir(leer({ ultimaPregunta: 'areas' }, 'la 1 y el acceso').tipo === 'modelo', 'numeros con palabras los lee el modelo');

  const obra = leer({ ultimaPregunta: 'obra' }, '2');
  exigir(obra.tipo === 'resuelta' && obra.proyectoId === 12, 'el numero de la obra es su posicion: 2 = Santa Isabel (id 12)');

  const nada = leer({ ultimaPregunta: 'mal' }, 'Nada');
  exigir(nada.tipo === 'resuelta' && ['atrasos', 'novedades'].every((s) => (nada.datos.preguntadas ?? []).includes(s)), '«nada» a los atrasos deja la seccion dicha');
  const horas = leer({ ultimaPregunta: 'horas' }, 'no');
  exigir(horas.tipo === 'resuelta' && horas.datos.horasPerdidas === 0, '«no» a las horas perdidas es cero');
  exigir(leer({ ultimaPregunta: 'trabajo:30' }, 'nada').tipo === 'modelo', '«nada» al trabajo no se da por dicho: lo lee el modelo');
  exigir(leer({ ultimaPregunta: 'clima' }, '1', 2).tipo === 'modelo', 'dos mensajes no son «un numero»');
}

exigir(enMinuscula('¿Hubo atrasos?') === '¿hubo atrasos?', 'la pregunta se pone en minuscula detras de «Volviendo al reporte:»');

console.log(fallos === 0 ? '\nTodo bien' : `\n${fallos} fallo(s)`);
process.exit(fallos === 0 ? 0 : 1);
