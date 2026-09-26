// Prueba de humo: la leyenda de cada foto del reporte diario.
// npm run pruebas -- reporte-leyendas
//
// Lo pidio Ivan el 2026-09-15: «poder escribirle un texto a cada foto». Opcional;
// sale debajo de la foto en la pantalla y en el PDF, donde reemplaza al nombre
// del archivo; cambiarla despues de enviar es una correccion.
//
// Se exige:
// - La leyenda viaja con su foto; en blanco es sin leyenda; una demasiado larga
//   se rechaza antes de subir nada.
// - En el borrador, el reintento la corrige sin dejar linea en Correcciones, y
//   «seguir el reporte sin enviar» la trae de vuelta.
// - Despues de enviar, cambiarla deja la linea con el numero de la foto, junto
//   con lo demas de ese guardado; la leyenda de una foto que agrega la misma
//   correccion no se anota aparte; copias repetidas del guardado no la duplican.
// - Una leyenda larga en un guardado lo rechaza entero, sin tocar nada.
// - El PDF la lleva como pie, con el numero de cada foto, y con leyendas de tres
//   renglones siguen cabiendo cuatro fotos verticales por hoja.
import { API } from './pruebas/contexto.js';
import jwt from 'jsonwebtoken';
import sharp from 'sharp';
import {
  PDFDocument, PDFDict, PDFName, PDFRawStream, PDFRef, type PDFObject,
} from 'pdf-lib';
import { query, pool } from '../src/database/config.js';
import { generateReportePDF, pieDeFoto, type ReportePdfInput } from '../src/services/reportePdf.js';
import type { CambioLegible } from '../src/services/reporteCambios.js';
import { buildReportePdfInput } from '../src/routes/proyectoReportes.js';

const P = 1;
const FECHA = '2027-07-20';

// 150 caracteres de verdad, como los escribiria un ingeniero: el tope.
const LARGA = 'Armado de acero de refuerzo en la columna C-4 del eje B, con estribos #3 a cada 15 cm, revisado con el residente antes del vaciado de hoy en la tarde.';

const main = async () => {
  const u = await query<{ id: number; email: string; rol: string }>(
    "SELECT id, email, rol FROM users WHERE rol='admin' AND activo=true ORDER BY id LIMIT 1");
  const token = jwt.sign(
    { userId: u.rows[0].id, email: u.rows[0].email, rol: u.rows[0].rol },
    process.env.JWT_SECRET!, { expiresIn: '10m' });

  const conClave = (r: string, clave?: string) => (clave ? `${r}?correccion=${clave}` : r);
  const pedir = async (m: string, r: string, b?: unknown, clave?: string) => {
    const res = await fetch(`${API}${conClave(r, clave)}`, {
      method: m,
      headers: { Authorization: `Bearer ${token}`, ...(b ? { 'Content-Type': 'application/json' } : {}) },
      ...(b ? { body: JSON.stringify(b) } : {}),
    });
    return { estado: res.status, cuerpo: await res.json().catch(() => null) };
  };

  // Cada foto distinta: el PDF junta las imagenes iguales en una.
  let tono = 0;
  const unaFoto = async (ancho = 64, alto = 48) => {
    tono += 1;
    return sharp({
      create: {
        width: ancho, height: alto, channels: 3,
        background: { r: (tono * 37) % 256, g: (tono * 71) % 256, b: 40 },
      },
    }).jpeg().toBuffer();
  };

  // Como la sube la pantalla: una foto por peticion, la leyenda antes que el archivo.
  const subir = async (
    id: number,
    leyenda?: string,
    opciones: { clave?: string; ancho?: number; alto?: number } = {},
  ) => {
    const form = new FormData();
    if (leyenda !== undefined) form.append('leyenda', leyenda);
    const foto = await unaFoto(opciones.ancho, opciones.alto);
    form.append('fotos', new Blob([new Uint8Array(foto)], { type: 'image/jpeg' }), 'image.jpg');
    const res = await fetch(`${API}${conClave(`/proyecto-reportes/${P}/${id}/fotos`, opciones.clave)}`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form,
    });
    const cuerpo = await res.json().catch(() => null);
    const f = cuerpo?.data?.[0];
    return {
      estado: res.status,
      mensaje: cuerpo?.message as string | undefined,
      id: f?.id as number,
      leyenda: f?.leyenda as string | null,
      r2_key: f?.r2_key as string,
    };
  };

  let ok = 0; let fallo = 0;
  const c = (cond: boolean, etq: string) => {
    if (cond) ok += 1; else { fallo += 1; console.log('FALLA ', etq); }
  };

  const plano = (l: CambioLegible[] = []) =>
    l.map((k) => `${k.etiqueta}: ${k.renglones
      .map((r) => r.map((t) => (t.tipo === 'quitado' ? `[-${t.texto}]`
        : t.tipo === 'agregado' ? `[+${t.texto}]` : t.texto)).join(' '))
      .join(' / ')}`).join(' | ');

  type Foto = { id: number; leyenda: string | null };
  const detalle = async (id: number) => (await pedir('GET', `/proyecto-reportes/${P}/${id}`)).cuerpo?.data;
  const leyendas = async (id: number) =>
    (await query<Foto>(
      'SELECT id, leyenda FROM proyecto_reporte_fotos WHERE reporte_id = $1 ORDER BY orden, id',
      [id])).rows.map((f) => f.leyenda);
  const cuantasFotos = async (id: number) => (await leyendas(id)).length;

  const cuerpo = (extra: object = {}) => ({
    fecha: FECHA, clima: 'Soleado', que_se_hizo: 'Se arma el acero de las columnas.', ...extra,
  });

  // ---- 1. la leyenda viaja con su foto ----
  const creado = await pedir('POST', `/proyecto-reportes/${P}`, cuerpo());
  c(creado.estado === 201, 'crea el borrador');
  const id = creado.cuerpo.data.id as number;

  const f1 = await subir(id, '  Encofrado de vigas\n del eje B  ');
  c(f1.estado === 201, `sube la foto 1 con leyenda (dio ${f1.estado})`);
  c(f1.leyenda === 'Encofrado de vigas del eje B',
    `se guarda en un renglon y sin espacios de mas (quedo «${f1.leyenda}»)`);
  const f2 = await subir(id, '   ');
  c(f2.estado === 201 && f2.leyenda === null, 'una leyenda en blanco es sin leyenda');
  const f3 = await subir(id);
  c(f3.estado === 201 && f3.leyenda === null, 'una foto sin el campo, como la manda una pagina vieja, tambien');

  const larga = await subir(id, `${LARGA}x`);
  c(larga.estado === 400, `una leyenda de 151 caracteres se rechaza (dio ${larga.estado})`);
  c(/151 caracteres/.test(larga.mensaje ?? '') && /máximo es 150/.test(larga.mensaje ?? ''),
    `y el mensaje dice cuanto mide y cuanto cabe (dijo «${larga.mensaje}»)`);
  c(await cuantasFotos(id) === 3, 'y la foto no entra');
  const justa = await subir(id, LARGA);
  c(justa.estado === 201 && justa.leyenda === LARGA, `una de 150 exactos si entra (mide ${LARGA.length})`);

  // ---- 2. el borrador: el reintento la corrige sin dejar linea ----
  const reintento = await pedir('PUT', `/proyecto-reportes/${P}/${id}`, cuerpo({
    fotos: [
      { id: f1.id, leyenda: 'Encofrado de vigas del eje B' },
      { id: f2.id, leyenda: 'Tubería sanitaria de 4" en zanja' },
      { id: f3.id },
    ],
  }));
  c(reintento.estado === 200, 'el reintento sobre el borrador se guarda');
  c(JSON.stringify(await leyendas(id)) ===
      JSON.stringify(['Encofrado de vigas del eje B', 'Tubería sanitaria de 4" en zanja', null, LARGA]),
    `cambia solo la que cambio; la que viene sin leyenda no se toca (quedaron ${JSON.stringify(await leyendas(id))})`);

  const borrador = (await pedir('GET', `/proyecto-reportes/${P}/borrador`)).cuerpo?.data;
  c(borrador?.id === id, 'el reporte sin enviar se ofrece');
  c(JSON.stringify(borrador?.fotos?.map((f: Foto) => f.leyenda)) === JSON.stringify(await leyendas(id)),
    'y trae las fotos con sus leyendas');

  const emitido = await pedir('POST', `/proyecto-reportes/${P}/${id}/emitir`);
  c(emitido.estado === 200, 'se envia');
  const recien = await detalle(id);
  c(recien?.correcciones?.length === 0, 'recien enviado, Correcciones esta vacia pese a las leyendas del borrador');
  c(JSON.stringify(recien?.fotos?.map((f: Foto) => f.leyenda)) === JSON.stringify(await leyendas(id)),
    'la pantalla del reporte recibe las leyendas, en el orden de las fotos');

  // ---- 3. el PDF: el pie es la leyenda, con el numero de cada foto ----
  c(pieDeFoto(3, 'Acero') === '3. Acero' && pieDeFoto(4, null) === '4.',
    'el pie es «numero. leyenda», y solo el numero si no hay');
  const entrada = await buildReportePdfInput(id);
  c(JSON.stringify(entrada?.fotos.map((f) => f.leyenda)) === JSON.stringify(await leyendas(id)),
    'el PDF recibe las mismas leyendas que la pantalla');

  // ---- 4. corregir despues de enviar ----
  const K1 = 'leyendas-uno-0001';
  const C4 = 'Acero de columna C-4 listo para vaciado';
  const C5 = 'Acero de columna C-5 listo para vaciado';
  await pedir('PUT', `/proyecto-reportes/${P}/${id}`, cuerpo({ fotos: [{ id: f3.id, leyenda: C4 }] }), K1);
  const f5 = await subir(id, 'Losa', { clave: K1 });
  c(f5.estado === 201, 'la misma correccion agrega una foto con su leyenda');
  // Se corta la senal; el ingeniero corrige C-4 por C-5, retoca la leyenda de
  // la foto nueva y vuelve a darle a Guardar.
  const otraVez = await pedir('PUT', `/proyecto-reportes/${P}/${id}`, cuerpo({
    clima: 'Nublado',
    fotos: [
      { id: f1.id, leyenda: 'Encofrado de vigas del eje B' },
      { id: f3.id, leyenda: C5 },
      { id: f5.id, leyenda: 'Losa nivel 2' },
    ],
  }), K1);
  c(otraVez.estado === 200, 'el reintento de la correccion se guarda');
  const l1 = (await detalle(id))?.correcciones ?? [];
  c(l1.length === 1, `todo queda en UNA linea (hay ${l1.length})`);
  c(plano(l1[0]?.cambios) === 'Clima: [-Soleado] [+Nublado] | Leyenda de la foto 3: [+Acero de columna C-5 listo para vaciado] | Fotos: se agregó 1',
    `la foto 3 va con su numero y su leyenda final; la de la foto nueva no va aparte (dice «${plano(l1[0]?.cambios)}»)`);
  c((await leyendas(id))[4] === 'Losa nivel 2', 'pero la leyenda retocada de la foto nueva si se guarda');

  // Otra correccion, que llega repetida: la foto 3 pasa de C-5 a C-4 otra vez.
  const K2 = 'leyendas-dos-0002';
  const copias = await Promise.all(Array.from({ length: 4 }, () =>
    pedir('PUT', `/proyecto-reportes/${P}/${id}`, cuerpo({
      clima: 'Nublado', fotos: [{ id: f3.id, leyenda: C4 }],
    }), K2)));
  c(copias.every((x) => x.estado === 200), 'las copias simultaneas responden bien');
  const l2 = (await detalle(id))?.correcciones ?? [];
  c(l2.length === 2 && plano(l2[1]?.cambios) === 'Leyenda de la foto 3: Acero de columna [-C-5] [+C-4] listo para vaciado',
    `una linea mas, con solo la palabra que cambio (hay ${l2.length}; dice «${plano(l2[1]?.cambios)}»)`);

  // Borrarla y dejarla igual.
  const K3 = 'leyendas-tres-0003';
  await pedir('PUT', `/proyecto-reportes/${P}/${id}`, cuerpo({
    clima: 'Nublado', fotos: [{ id: f1.id, leyenda: '' }, { id: f3.id, leyenda: ` ${C4} ` }],
  }), K3);
  const l3 = (await detalle(id))?.correcciones ?? [];
  c(plano(l3[2]?.cambios) === 'Leyenda de la foto 1: [-Encofrado de vigas del eje B]',
    `borrar una se anota; la que llego con espacios de mas no (dice «${plano(l3[2]?.cambios)}»)`);
  c((await leyendas(id))[0] === null, 'y queda sin leyenda');

  // ---- 5. lo que no se acepta ----
  const antes = JSON.stringify(await leyendas(id));
  const mala = await pedir('PUT', `/proyecto-reportes/${P}/${id}`, cuerpo({
    clima: 'Lluvia parcial',
    fotos: [{ id: f2.id, leyenda: 'Cambio bueno' }, { id: f3.id, leyenda: `${LARGA}!` }],
  }), 'leyendas-mala-0004');
  c(mala.estado === 400 && /la foto 3/.test(mala.cuerpo?.message ?? ''),
    `una leyenda larga rechaza el guardado y dice de que foto es (dio ${mala.estado}: «${mala.cuerpo?.message}»)`);
  c(JSON.stringify(await leyendas(id)) === antes, 'sin tocar las demas leyendas');
  c((await detalle(id))?.clima === 'Nublado', 'ni el resto del guardado');
  const noTexto = await pedir('PUT', `/proyecto-reportes/${P}/${id}`, cuerpo({
    fotos: [{ id: f2.id, leyenda: 5 }],
  }));
  c(noTexto.estado === 400, `una leyenda que no es texto se rechaza (dio ${noTexto.estado})`);

  const ajeno = await pedir('POST', `/proyecto-reportes/${P}`, cuerpo());
  const idAjeno = ajeno.cuerpo.data.id as number;
  const fotoAjena = await subir(idAjeno, 'De otro reporte');
  await pedir('PUT', `/proyecto-reportes/${P}/${id}`, cuerpo({
    clima: 'Nublado', fotos: [{ id: fotoAjena.id, leyenda: 'Colada' }],
  }), 'leyendas-ajena-0005');
  c((await leyendas(idAjeno))[0] === 'De otro reporte', 'la foto de otro reporte no se toca');
  c(((await detalle(id))?.correcciones ?? []).length === 3, 'ni deja linea');

  // ---- 6. con la leyenda mas larga siguen cabiendo 4 verticales o 6 horizontales ----
  // La mas larga: 150 caracteres en mayusculas, tres renglones. Cada hoja que
  // es solo fotos lleva cuatro verticales o seis horizontales, y las leyendas
  // no mueven ninguna foto de hoja. Ojo: esto mide con la letra de la maquina
  // donde corre; el servidor usa DejaVu Sans, mas ancha (ver .shot en reportePdf).
  const MAYUSCULAS = LARGA.toUpperCase();
  const tanda = async (cuantas: number, ancho: number, alto: number) => {
    const lista: ReportePdfInput['fotos'] = [];
    for (let i = 0; i < cuantas; i += 1) {
      const v = await subir(idAjeno, MAYUSCULAS, { ancho, alto });
      lista.push({ r2_key: v.r2_key, nombre_archivo: 'image.jpg', tipo_mime: 'image/jpeg', leyenda: MAYUSCULAS });
    }
    return lista;
  };
  const verticales = await tanda(12, 600, 800);
  const horizontales = await tanda(18, 800, 600);
  const base: ReportePdfInput = {
    numero: 'PRUEBA-001', fechaLarga: 'Martes, 20 de julio de 2027', fechaCorta: '20 jul 2027',
    proyectoNombre: 'Prueba', autorNombre: 'Prueba', clima: 'Soleado',
    horasPerdidas: null, motivo: null, personalCalificado: 0, ayudantes: 0,
    equipo: [], personal: [], equipos: [], entregas: [], areas: [],
    trabajos: [], queSeHizo: 'Prueba', atrasos: null, novedades: null, correcciones: [],
    fotos: [],
  };
  const porHoja = async (pdf: Buffer) => {
    const doc = await PDFDocument.load(pdf);
    // Las imagenes que dibuja cada hoja, entrando en los grupos que Chrome arma.
    const imagenes = (recursos: PDFObject | undefined, vistas: Set<string>): number => {
      const dict = recursos instanceof PDFRef ? doc.context.lookup(recursos) : recursos;
      if (!(dict instanceof PDFDict)) return 0;
      const xobjetos = dict.lookup(PDFName.of('XObject'));
      if (!(xobjetos instanceof PDFDict)) return 0;
      let n = 0;
      for (const [, ref] of xobjetos.entries()) {
        const clave = String(ref);
        if (vistas.has(clave)) continue;
        vistas.add(clave);
        const obj = ref instanceof PDFRef ? doc.context.lookup(ref) : ref;
        if (!(obj instanceof PDFRawStream)) continue;
        const tipo = obj.dict.lookup(PDFName.of('Subtype'));
        if (tipo === PDFName.of('Image')) n += 1;
        else n += imagenes(obj.dict.get(PDFName.of('Resources')), vistas);
      }
      return n;
    };
    return doc.getPages().map((p) => imagenes(p.node.get(PDFName.of('Resources')), new Set()));
  };
  for (const [nombre, fotos, porPagina] of [
    ['verticales', verticales, 4], ['horizontales', horizontales, 6],
  ] as const) {
    const con = await porHoja(await generateReportePDF({ ...base, fotos }));
    const sin = await porHoja(await generateReportePDF({
      ...base, fotos: fotos.map((f) => ({ ...f, leyenda: null })),
    }));
    console.log(`${nombre} por hoja (la primera trae el logo): con leyendas ${con.join(' ')} · sin ${sin.join(' ')}`);
    // La primera hoja es la del texto, que aqui es corto: las fotos empiezan en la segunda.
    const deFotos = con.slice(1);
    c(deFotos.length > 0 && deFotos.every((n) => n === porPagina),
      `cada hoja de fotos lleva ${porPagina} ${nombre} con la leyenda mas larga (${con.join(' ')})`);
    c(JSON.stringify(con) === JSON.stringify(sin),
      `las leyendas no mueven ninguna foto ${nombre.slice(0, -1)} de hoja (con ${con.join(' ')}, sin ${sin.join(' ')})`);
  }

  console.log(`${ok} pasaron, ${fallo} fallaron`);
  await pool.end();
  process.exit(fallo ? 1 : 0);
};
main();
