// Prueba de humo: la seccion Correcciones del reporte diario.
// npm run pruebas -- reporte-correcciones
//
// Nace del 2026-09-16. El reporte RD-PBR-260915 salio con once lineas «Cambio
// registrado» —una por cada foto que subio al enviarlo— y una sola correccion
// de verdad. Lo que pidio Ivan: «la seccion de correcciones debe quedar en
// blanco, y solamente se debe llenar cuando hay un cambio despues de haber
// enviado el reporte».
//
// Se exige:
// - Todo lo que pasa antes de enviar —fotos subidas de una en una, el borrador
//   guardado otra vez, una foto quitada— deja la seccion vacia.
// - Despues de enviar, un «Guardar cambios» deja UNA linea con el texto y las
//   fotos juntos, aunque las fotos suban de una en una, aunque se corte la
//   senal y se reintente, y aunque la misma peticion llegue repetida.
// - Un guardado que no cambia nada, o que deja todo como estaba, no se ve.
// - La version archivada del PDF sale al final, ya con las fotos de esa
//   correccion; si el aviso final no llega, la archiva el cron de la madrugada.
// - Una pagina abierta desde antes de este cambio (sin clave) sigue pudiendo
//   corregir: cada peticion anota su propia linea.
// - El PDF lee la misma lista que la pantalla, con la hora de Panama.
// - La migracion 166 pasa a la lista solo las correcciones viejas de verdad.
// - audit_log sigue anotandolo todo, como antes.
import { API } from './pruebas/contexto.js';
import { readFileSync } from 'fs';
import path from 'path';
import { isDeepStrictEqual } from 'util';
import jwt from 'jsonwebtoken';
import sharp from 'sharp';
import { query, pool } from '../src/database/config.js';
import { downloadFile } from '../src/services/storage.js';
import { generateReportePDF } from '../src/services/reportePdf.js';
import type { CambioLegible } from '../src/services/reporteCambios.js';
import {
  buildReportePdfInput,
  archivarCorreccionesPendientes,
} from '../src/routes/proyectoReportes.js';

const P = 1;
const FECHA = '2027-06-15';

const main = async () => {
  const u = await query<{ id: number; email: string; rol: string }>(
    "SELECT id, email, rol FROM users WHERE rol='admin' AND activo=true ORDER BY id LIMIT 1");
  const token = jwt.sign(
    { userId: u.rows[0].id, email: u.rows[0].email, rol: u.rows[0].rol },
    process.env.JWT_SECRET!, { expiresIn: '10m' });

  const conClave = (r: string, clave?: string) =>
    clave ? `${r}${r.includes('?') ? '&' : '?'}correccion=${clave}` : r;

  const pedir = async (m: string, r: string, b?: unknown, clave?: string) => {
    const res = await fetch(`${API}${conClave(r, clave)}`, {
      method: m,
      headers: { Authorization: `Bearer ${token}`, ...(b ? { 'Content-Type': 'application/json' } : {}) },
      ...(b ? { body: JSON.stringify(b) } : {}),
    });
    return { estado: res.status, cuerpo: await res.json().catch(() => null) };
  };

  // Cada foto distinta de las demas: el PDF junta las imagenes iguales en una,
  // y entonces contarlas no probaria nada.
  let tono = 0;
  const unaFoto = async () => {
    tono += 1;
    return sharp({
      create: { width: 64, height: 48, channels: 3, background: { r: (tono * 37) % 256, g: 90, b: 40 } },
    }).jpeg().toBuffer();
  };

  // Una foto por peticion, como la sube la pantalla.
  const subir = async (id: number, clave?: string) => {
    const form = new FormData();
    form.append('fotos', new Blob([new Uint8Array(await unaFoto())], { type: 'image/jpeg' }), 'image.jpg');
    const res = await fetch(`${API}${conClave(`/proyecto-reportes/${P}/${id}/fotos`, clave)}`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form,
    });
    const cuerpo = await res.json().catch(() => null);
    return { estado: res.status, fotoId: cuerpo?.data?.[0]?.id as number };
  };

  let ok = 0; let fallo = 0;
  const c = (cond: boolean, etq: string) => {
    if (cond) ok += 1; else { fallo += 1; console.log('FALLA ', etq); }
  };

  // Una linea como texto plano: [-quitado] [+agregado], « / » entre renglones
  // y « | » entre campos.
  const plano = (l: CambioLegible[] = []) =>
    l.map((k) => `${k.etiqueta}: ${k.renglones
      .map((r) => r.map((t) => (t.tipo === 'quitado' ? `[-${t.texto}]`
        : t.tipo === 'agregado' ? `[+${t.texto}]` : t.texto)).join(' '))
      .join(' / ')}`).join(' | ');

  type Linea = { id: number; created_at: string; usuario_nombre: string; cambios: CambioLegible[] };
  const correcciones = async (id: number): Promise<Linea[]> =>
    (await pedir('GET', `/proyecto-reportes/${P}/${id}`)).cuerpo?.data?.correcciones ?? [];
  const editarEnAudit = async (id: number) =>
    Number((await query<{ n: string }>(
      `SELECT count(*) n FROM audit_log
        WHERE entidad = 'reporte_diario' AND entidad_id = $1 AND accion = 'editar'`,
      [id])).rows[0].n);
  const fila = async (id: number, clave: string) =>
    (await query<{ id: number; pdf_version: number | null }>(
      'SELECT id, pdf_version FROM proyecto_reporte_correcciones WHERE reporte_id = $1 AND clave = $2',
      [id, clave])).rows[0];
  const versiones = async (id: number) =>
    Number((await query<{ n: string }>(
      'SELECT count(*) n FROM proyecto_reporte_pdfs WHERE reporte_id = $1', [id])).rows[0].n);

  const imagenes = (pdf: Buffer) => (pdf.toString('latin1').match(/\/Subtype\s*\/Image/g) ?? []).length;
  const imagenesAhora = async (id: number) =>
    imagenes(await generateReportePDF((await buildReportePdfInput(id))!));
  const imagenesArchivadas = async (id: number, version: number) => {
    const r = await query<{ r2_key: string }>(
      'SELECT r2_key FROM proyecto_reporte_pdfs WHERE reporte_id = $1 AND version = $2',
      [id, version]);
    return imagenes(await downloadFile(r.rows[0].r2_key));
  };
  const esperar = async (cond: () => Promise<boolean>, ms = 30_000) => {
    const hasta = Date.now() + ms;
    while (Date.now() < hasta) {
      if (await cond()) return true;
      await new Promise((r) => setTimeout(r, 300));
    }
    return false;
  };

  const cuerpo = (texto: string, clima = 'Soleado') => ({
    fecha: FECHA, clima, que_se_hizo: texto,
    horas_perdidas: null, motivo: null, atrasos: null, novedades: null,
  });
  const TEXTO = 'Se arma el acero del pedestal.';

  // ---- 1. antes de enviar: nada cuenta ----
  const creado = await pedir('POST', `/proyecto-reportes/${P}`, cuerpo('Primer texto.'));
  c(creado.estado === 201, 'crea el borrador');
  const id = creado.cuerpo.data.id as number;

  const originales: number[] = [];
  for (let i = 0; i < 3; i += 1) {
    const s = await subir(id);
    c(s.estado === 201, `sube una foto al borrador (dio ${s.estado})`);
    originales.push(s.fotoId);
  }

  // El camino del reintento: el borrador se vuelve a guardar, y cambiado.
  const reguardado = await pedir('PUT', `/proyecto-reportes/${P}/${id}`, cuerpo(TEXTO));
  c(reguardado.estado === 200, 'el borrador se vuelve a guardar');
  const quitadaAntes = await pedir('DELETE', `/proyecto-reportes/${P}/${id}/fotos/${originales.pop()}`);
  c(quitadaAntes.estado === 200, 'se quita una foto del borrador');

  const emitido = await pedir('POST', `/proyecto-reportes/${P}/${id}/emitir`);
  c(emitido.estado === 200, 'se envia');

  c((await correcciones(id)).length === 0, 'recien enviado, la seccion Correcciones esta vacia');
  c((await buildReportePdfInput(id))?.correcciones.length === 0, 'y el PDF tampoco trae correcciones');
  c(await editarEnAudit(id) === 5,
    `audit_log sigue anotando las 3 fotos, el reguardado y la foto quitada (anoto ${await editarEnAudit(id)})`);

  // ---- 2. un «Guardar cambios» con texto y fotos, como lo hace la pantalla ----
  const K1 = 'clave-uno-0001';

  const igual = await pedir('PUT', `/proyecto-reportes/${P}/${id}`, cuerpo(TEXTO), K1);
  c(igual.estado === 200 && (await correcciones(id)).length === 0,
    'guardar sin cambiar nada no deja linea');

  const TEXTO2 = `${TEXTO}\n-Se arma completo el primer pedestal.`;
  const guardado = await pedir('PUT', `/proyecto-reportes/${P}/${id}`, cuerpo(TEXTO2), K1);
  c(guardado.estado === 200, 'el texto corregido se guarda');
  c((await fila(id, K1))?.pdf_version === null,
    'y NO se archiva todavia: faltan las fotos de este guardado');
  const antesDeFotos = await imagenesAhora(id);

  const x = await subir(id, K1);
  const y = await subir(id, K1);
  c(x.estado === 201 && y.estado === 201, 'suben dos fotos, de una en una');
  const l1 = await correcciones(id);
  c(l1.length === 1, `texto y fotos quedan en UNA linea (hay ${l1.length})`);
  c(plano(l1[0]?.cambios) ===
      'Trabajo ejecutado: [+-Se arma completo el primer pedestal.] | Fotos: se agregaron 2',
    `la linea dice las dos cosas, y del texto solo el renglon nuevo (dice «${plano(l1[0]?.cambios)}»)`);

  // Se corta la senal. El ingeniero cambia el clima, quita la segunda foto que
  // alcanzo a subir y le da otra vez a Guardar: sigue siendo el mismo guardado.
  const reintento = await pedir('PUT', `/proyecto-reportes/${P}/${id}`, cuerpo(TEXTO2, 'Nublado'), K1);
  c(reintento.estado === 200, 'el reintento se guarda');
  const quitaY = await pedir('DELETE', `/proyecto-reportes/${P}/${id}/fotos/${y.fotoId}`, undefined, K1);
  c(quitaY.estado === 200, 'y quita la foto que habia subido');
  const l2 = await correcciones(id);
  c(l2.length === 1, `el reintento no abre otra linea (hay ${l2.length})`);
  c(plano(l2[0]?.cambios) ===
      'Clima: [-Soleado] [+Nublado] | Trabajo ejecutado: [+-Se arma completo el primer pedestal.] | Fotos: se agregó 1',
    `suma el clima, y la foto que se subio y se quito en el mismo guardado no cuenta (dice «${plano(l2[0]?.cambios)}»)`);

  const terminado = await pedir('POST', `/proyecto-reportes/${P}/${id}/correcciones/terminar`);
  c(terminado.estado === 200, 'el aviso final responde bien');
  const archivo = await esperar(async () => (await fila(id, K1))?.pdf_version !== null);
  c(archivo, 'el aviso final archiva la version del PDF');
  const version = (await fila(id, K1))?.pdf_version ?? 0;
  const enArchivo = archivo ? await imagenesArchivadas(id, version) : -1;
  c(enArchivo === antesDeFotos + 1,
    `la version archivada ya trae la foto nueva (${antesDeFotos} imagenes antes de las fotos, ${enArchivo} archivadas)`);

  const hay = await versiones(id);
  await pedir('POST', `/proyecto-reportes/${P}/${id}/correcciones/terminar`);
  await new Promise((r) => setTimeout(r, 1500));
  c(await versiones(id) === hay, 'un aviso final repetido no archiva otra version');

  // ---- 3. otro guardado: quita una foto vieja, llega repetido, y se corta ----
  const K2 = 'clave-dos-0002';
  const TEXTO3 = `${TEXTO2}\n-Se vacia el pedestal.`;
  const dobles = await Promise.all(Array.from({ length: 4 }, () =>
    pedir('PUT', `/proyecto-reportes/${P}/${id}`, cuerpo(TEXTO3, 'Nublado'), K2)));
  c(dobles.every((d) => d.estado === 200), 'las copias simultaneas del guardado responden bien');
  const quitaVieja = await pedir('DELETE', `/proyecto-reportes/${P}/${id}/fotos/${originales[0]}`, undefined, K2);
  c(quitaVieja.estado === 200, 'se quita una foto que el reporte ya tenia al enviarse');
  const otraVez = await pedir('DELETE', `/proyecto-reportes/${P}/${id}/fotos/${originales[0]}`, undefined, K2);
  c(otraVez.estado === 404, `quitarla otra vez da 404 (dio ${otraVez.estado})`);
  const l3 = await correcciones(id);
  c(l3.length === 2, `el segundo guardado es UNA linea mas, aunque llego repetido (hay ${l3.length})`);
  c(plano(l3[1]?.cambios) === 'Trabajo ejecutado: [+-Se vacia el pedestal.] | Fotos: se quitó 1',
    `y dice que se quito la foto (dice «${plano(l3[1]?.cambios)}»)`);

  // Nunca llega el aviso final. De madrugada, el cron la archiva.
  c(await archivarCorreccionesPendientes() === 0,
    'el cron no archiva una correccion de hace un momento: alguien podria seguir subiendo');
  await query(
    `UPDATE proyecto_reporte_correcciones
        SET updated_at = updated_at - INTERVAL '2 hours'
      WHERE reporte_id = $1 AND clave = $2`,
    [id, K2]);
  c(await archivarCorreccionesPendientes() === 1, 'pasada la hora, el cron si la archiva');
  c((await fila(id, K2))?.pdf_version !== null, 'y queda marcada con su version');

  // ---- 4. un guardado que deja todo como estaba no se ve ----
  const K3 = 'clave-tres-0003';
  await pedir('PUT', `/proyecto-reportes/${P}/${id}`, cuerpo(TEXTO3, 'Soleado'), K3);
  await pedir('PUT', `/proyecto-reportes/${P}/${id}`, cuerpo(TEXTO3, 'Nublado'), K3);
  c((await correcciones(id)).length === 2, 'cambiar el clima y devolverlo no deja linea');

  // ---- 5. una pagina abierta desde antes de este cambio, sin clave ----
  const viejo = await pedir('PUT', `/proyecto-reportes/${P}/${id}`, cuerpo(`${TEXTO3}\n-Sin clave.`, 'Nublado'));
  const fotoVieja = await subir(id);
  c(viejo.estado === 200 && fotoVieja.estado === 201, 'sin clave, la correccion se guarda igual');
  const l5 = await correcciones(id);
  c(l5.length === 4 && plano(l5[3]?.cambios) === 'Fotos: se agregó 1',
    `sin clave, cada peticion anota su propia linea, como antes (hay ${l5.length})`);

  // ---- 6. el PDF lee lo mismo que la pantalla ----
  const pdf = await buildReportePdfInput(id);
  c(JSON.stringify(pdf?.correcciones.map((l) => l.cambios)) === JSON.stringify(l5.map((l) => l.cambios)),
    'el PDF trae las mismas lineas, armadas igual');
  c(pdf?.correcciones.every((l) => l.cambios.length > 0) === true, 'y ninguna vacia');

  // ---- 7. la hora es la de Panama, aunque el servidor corra en UTC como Railway ----
  // La correccion real de Cesar se guardo a las 02:04 UTC del 16; en Panama eran
  // las 9:04 de la noche del 15.
  process.env.TZ = 'UTC';
  await query(
    `UPDATE proyecto_reporte_correcciones SET created_at = '2026-09-16T02:04:55Z'
      WHERE reporte_id = $1 AND clave = $2`,
    [id, K1]);
  const cuando = (await buildReportePdfInput(id))?.correcciones[0]?.cuando ?? '';
  c(/^15 sept?\.? 2026, 9:04\s?p\.\s?m\.$/u.test(cuando.replace(/\s/g, ' ')),
    `el PDF dice el 15 a las 9:04 p. m., no el 16 (dice «${cuando}»)`);

  // ---- 8. la migracion 166 copia las correcciones de antes, y solo esas ----
  // Un reporte como los dejaba el codigo viejo: todo en audit_log, lo de antes
  // del envio mezclado con lo de despues.
  const antiguo = await pedir('POST', `/proyecto-reportes/${P}`, cuerpo('A.'));
  const vid = antiguo.cuerpo.data.id as number;
  await pedir('POST', `/proyecto-reportes/${P}/${vid}/emitir`);
  const envio = (await query<{ t: string }>(
    `SELECT created_at::text AS t FROM audit_log
      WHERE entidad = 'reporte_diario' AND accion = 'enviar' AND entidad_id = $1`,
    [vid])).rows[0].t;
  const cambiosViejos = { que_se_hizo: { label: 'Trabajo ejecutado', antes: 'A.', despues: 'A.\n-B.' } };
  await query(
    `INSERT INTO audit_log (user_id, accion, entidad, entidad_id, detalles, created_at) VALUES
       ($1, 'editar', 'reporte_diario', $2, $3, $5::timestamptz - INTERVAL '1 minute'),
       ($1, 'editar', 'reporte_diario', $2, $4, $5::timestamptz + INTERVAL '1 minute'),
       ($1, 'editar', 'reporte_diario', $2, $3, $5::timestamptz + INTERVAL '2 minutes')`,
    [u.rows[0].id, vid, JSON.stringify({ cambios: cambiosViejos }),
      JSON.stringify({ fotos_agregadas: ['image.jpg'] }), envio]);
  // La version que archivo aquella correccion, un momento despues.
  await query(
    `INSERT INTO proyecto_reporte_pdfs (reporte_id, version, r2_key, created_at)
     VALUES ($1, 7, 'prueba', ($2::timestamptz + INTERVAL '3 minutes')::timestamp)`,
    [vid, envio]);

  const migracion = readFileSync(
    path.join(process.cwd(), 'database', 'migrations', '166_reporte_correcciones_historicas.sql'), 'utf8');
  const copiadas = async () => (await query<{ cambios: unknown; pdf_version: number | null; clave: string | null }>(
    'SELECT cambios, pdf_version, clave FROM proyecto_reporte_correcciones WHERE reporte_id = $1', [vid])).rows;
  await query(migracion);
  const cop = await copiadas();
  c(cop.length === 1, `copia solo la correccion de despues del envio, no el guardado de antes ni la foto (copio ${cop.length})`);
  c(isDeepStrictEqual(cop[0]?.cambios, cambiosViejos), 'con sus cambios tal cual');
  c(cop[0]?.pdf_version === 7, `y marcada con la version que la archivo, para que el cron no la vuelva a archivar (tiene ${cop[0]?.pdf_version})`);
  c(plano((await correcciones(vid))[0]?.cambios) === 'Trabajo ejecutado: [+-B.]', 'y se ve en la pantalla');
  await query(migracion);
  c((await copiadas()).length === 1, 'correrla otra vez no la duplica');

  console.log(`${ok} pasaron, ${fallo} fallaron`);
  await pool.end();
  process.exit(fallo ? 1 : 0);
};
main();
