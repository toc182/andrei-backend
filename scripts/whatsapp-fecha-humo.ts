// Prueba de humo: las preguntas del reporte las hace el sistema.
// npm run pruebas -- whatsapp-fecha
//
// Decision de Ivan del 2026-09-28: el sistema decide que se pregunta y con que
// palabras (preguntasFijas.ts); el modelo solo entiende y anota. Aqui el modelo
// va guionizado, asi que lo que se comprueba es la maquinaria. Se exige:
// - empezar el reporte con una sola obra pregunta la fecha, con sus botones;
// - «Sí», un numero del clima, «no» a las horas y los numeros de las areas los
//   resuelve el sistema SIN llamar al modelo, y sale la pregunta que sigue;
// - los numeros de las areas son la POSICION en la lista, no el id;
// - lo que dice el modelo va delante de la pregunta, en el mismo mensaje;
// - una pregunta que no contesta sale la segunda vez con otras palabras, y a la
//   tercera se sigue;
// - si el modelo aclara algo (su mensaje es una pregunta), no se le pregunta
//   nada mas: se espera la respuesta;
// - una pregunta de pagos en medio vuelve a la misma pregunta, con aviso;
// - contestar la fecha con otra cosa deja la de hoy y el modelo recibe el aviso;
// - «Otra fecha» la lee el modelo;
// - al final, «¿Te mando el borrador?» con sus botones;
// - y siguen en pie las dos correcciones: «anoté» sin anotar y el mismo
//   mensaje dos veces vuelven al modelo.
import { API } from './pruebas/contexto.js';
import { SECRETOS_PRUEBA } from './pruebas/entorno.js';
import crypto from 'crypto';
import { query, pool } from '../src/database/config.js';
import { hoyEnPanama } from '../src/services/whatsapp/herramientas.js';

const META = process.env.PRUEBAS_META ?? '';
const NUMERO = '50761110002';

let fallos = 0;
const exigir = (bien: boolean, que: string, visto?: unknown): void => {
  console.log(`${bien ? '  ok  ' : 'FALLA '} ${que}${bien || visto === undefined ? '' : ` → ${JSON.stringify(visto)}`}`);
  if (!bien) fallos += 1;
};
const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

let n = 0;
const decir = async (texto: string): Promise<void> => {
  const crudo = Buffer.from(
    JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{
        id: '1',
        changes: [{
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { phone_number_id: SECRETOS_PRUEBA.numeroId },
            messages: [{ id: `wamid.F${(n += 1)}`, from: NUMERO, type: 'text', text: { body: texto } }],
          },
        }],
      }],
    }),
    'utf8',
  );
  await fetch(`${API}/whatsapp/webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Hub-Signature-256':
        'sha256=' + crypto.createHmac('sha256', SECRETOS_PRUEBA.appSecret).update(crudo).digest('hex'),
    },
    body: crudo,
  });
};

const guionizar = (respuestas: unknown[]) =>
  fetch(`${META}/_prueba/ia`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(respuestas),
  });
const usar = (nombre: string, input: unknown) => ({
  content: [{ type: 'tool_use', id: `tu_${(n += 1)}`, name: nombre, input }],
  stop_reason: 'tool_use',
});
const texto = (t: string) => ({ content: [{ type: 'text', text: t }], stop_reason: 'end_turn' });

type Salida = { tipo: string; texto: string | null };
const salidas = async (): Promise<Salida[]> =>
  (await (await fetch(`${META}/_prueba/enviados`)).json()) as Salida[];
const peticiones = async (): Promise<{ system?: { text: string }[]; messages?: { content: unknown }[] }[]> =>
  (await (await fetch(`${META}/_prueba/ia/peticiones`)).json()) as never;

/** Dice algo y espera a que salga la respuesta. Devuelve la ultima que salio. */
let vistas = 0;
const conversar = async (dicho: string): Promise<Salida | undefined> => {
  await decir(dicho);
  for (const hasta = Date.now() + 20000; Date.now() < hasta; await esperar(200)) {
    const s = await salidas();
    if (s.length > vistas) {
      await esperar(300); // por si sale un segundo mensaje del mismo turno
      const todas = await salidas();
      vistas = todas.length;
      return todas.at(-1);
    }
  }
  return undefined;
};

const datos = async (): Promise<Record<string, unknown>> =>
  (
    await query<{ datos: Record<string, unknown> }>(
      'SELECT datos FROM whatsapp_conversaciones WHERE telefono = $1 AND activa',
      [NUMERO],
    )
  ).rows[0]?.datos ?? {};
const empezar = async (): Promise<void> => {
  await query('UPDATE whatsapp_conversaciones SET activa = false WHERE telefono = $1', [NUMERO]);
};

const main = async () => {
  if (!META) {
    console.error('falta PRUEBAS_META');
    process.exit(1);
  }
  const u = await query<{ id: number }>(
    `UPDATE users SET whatsapp = $1
      WHERE id = (SELECT id FROM users WHERE email = 'aprobador4@pruebas.local') RETURNING id`,
    [NUMERO],
  );
  await query(
    `INSERT INTO user_permissions (user_id, reportes, solicitudes_ver) VALUES ($1, true, true)
     ON CONFLICT (user_id) DO UPDATE SET reportes = true, solicitudes_ver = true`,
    [u.rows[0].id],
  );
  await query(
    'INSERT INTO user_project_access (user_id, proyecto_id) VALUES ($1, 1) ON CONFLICT DO NOTHING',
    [u.rows[0].id],
  );
  // Las areas del proyecto, al reves: la primera de la lista es la de id mas
  // alto. Asi un «1» que se tradujera como id caeria en otra area.
  await query('UPDATE proyecto_areas SET orden = 10 - orden WHERE proyecto_id = 1');
  const areas = (
    await query<{ id: number; nombre: string }>(
      'SELECT id, nombre FROM proyecto_areas WHERE proyecto_id = 1 AND activo ORDER BY orden, id',
    )
  ).rows;

  // ── empieza: la fecha, con botones ──────────────────────────────────────
  await guionizar([usar('empezar_reporte', {}), texto('Vamos con el reporte.')]);
  let s = await conversar('Ayúdame con el reporte');
  exigir(
    s?.tipo === 'interactive' &&
      Boolean(s.texto?.startsWith('Vamos con el reporte.\n\n¿El reporte es de hoy,')),
    'empezar con una sola obra: lo que dijo el modelo y, detrás, la fecha con botones',
    s,
  );
  let d = await datos();
  exigir(d.fecha === hoyEnPanama(), 'el reporte ya trae la fecha de hoy');

  // ── lo que resuelve el sistema sin el modelo ────────────────────────────
  const antes = (await peticiones()).length;
  s = await conversar('Sí');
  exigir(Boolean(s?.texto?.startsWith('¿Cómo estuvo el clima?')), '«Sí» → sale el clima', s?.texto);
  s = await conversar('1');
  exigir(Boolean(s?.texto?.startsWith('¿Se perdieron horas')), 'un número del clima → salen las horas perdidas', s?.texto);
  s = await conversar('no');
  exigir(Boolean(s?.texto?.startsWith('¿En qué áreas se trabajó?')) && Boolean(s?.texto?.includes(`1. ${areas[0].nombre}`)), '«no» → salen las áreas, numeradas en su orden', s?.texto);
  s = await conversar('1 y 2');
  exigir(s?.texto === `¿Qué se hizo en ${areas[0].nombre}?`, 'los números de las áreas → se pregunta la primera', s?.texto);
  exigir((await peticiones()).length === antes, 'y ninguna de esas cuatro respuestas llamó al modelo');
  d = await datos();
  exigir(
    d.clima === 'Soleado' && d.horasPerdidas === 0 &&
      JSON.stringify(d.areas) === JSON.stringify([areas[0].id, areas[1].id]),
    'quedó anotado: el clima, cero horas y las áreas por su POSICIÓN en la lista',
    d,
  );

  // ── lo que dice el modelo va delante de la pregunta ─────────────────────
  await guionizar([
    usar('anotar', { trabajos: [{ area_id: areas[0].id, texto: 'Colocamos 6 zapatas' }] }),
    texto('Anoté 6 zapatas.'),
  ]);
  s = await conversar('Colocamos 6 zapatas');
  exigir(s?.texto === `Anoté 6 zapatas.\n\n¿Qué se hizo en ${areas[1].nombre}?`, 'lo que anotó el modelo, y detrás la siguiente área', s?.texto);

  // ── una pregunta de pagos en medio ──────────────────────────────────────
  await guionizar([usar('buscar_solicitudes', {}), texto('No hay solicitudes en tus obras.')]);
  s = await conversar('¿Hay pagos pendientes?');
  exigir(
    s?.texto === `No hay solicitudes en tus obras.\n\nVolviendo al reporte: ¿qué se hizo en ${areas[1].nombre}?`,
    'una pregunta de pagos vuelve a la misma pregunta, con las mismas palabras',
    s?.texto,
  );

  // ── la que no contesta: otra vez con otras palabras, y a la tercera se sigue
  await guionizar([texto('')]);
  s = await conversar('mmm');
  exigir(s?.texto === `Cuéntame lo que se hizo en ${areas[1].nombre}, aunque sea en pocas palabras.`, 'la segunda vez, con otras palabras', s?.texto);
  await guionizar([texto('')]);
  s = await conversar('eh');
  exigir(Boolean(s?.texto?.startsWith('¿Hubo atrasos')), 'a la tercera se sigue con lo que sigue', s?.texto);

  // ── si el modelo aclara algo, se espera ─────────────────────────────────
  await guionizar([texto('¿Cuál retro, la grande o la pequeña?')]);
  s = await conversar('la retro se dañó');
  exigir(s?.texto === '¿Cuál retro, la grande o la pequeña?', 'si el modelo pregunta, no se le pregunta nada más', s?.texto);

  // ── lo demás, «nada», hasta el final ────────────────────────────────────
  await guionizar([texto('')]);
  s = await conversar('La grande, pero no hubo atraso');
  exigir(Boolean(s?.texto?.startsWith('¿Hubo atrasos')) || Boolean(s?.texto?.startsWith('¿Algún atraso')), 'después de la aclaración sigue donde iba', s?.texto);
  for (const nada of ['nada', 'nada', 'ninguna', 'nada', 'no']) {
    s = await conversar(nada);
  }
  exigir(
    s?.tipo === 'interactive' && s.texto === 'Ya tengo todo. ¿Te mando el borrador?',
    'al final, el borrador con sus botones',
    s,
  );

  // ── contestar la fecha con otra cosa ────────────────────────────────────
  await empezar();
  await guionizar([usar('empezar_reporte', {}), texto('')]);
  await conversar('Reporte');
  await guionizar([
    usar('anotar', { trabajos: [{ area_id: areas[0].id, texto: 'Colocamos 6 zapatas' }] }),
    texto('Queda con la de hoy. Anoté 6 zapatas.'),
  ]);
  s = await conversar('Hoy colocamos 6 zapatas');
  const ps = await peticiones();
  const sistema = (ps.at(-1)?.system ?? []).map((x) => x.text).join('\n');
  exigir(sistema.includes('AVISO DEL SISTEMA') && sistema.includes('media línea'), 'contestar la fecha con otra cosa: el modelo recibe el aviso');
  exigir(Boolean(s?.texto?.startsWith('Queda con la de hoy. Anoté 6 zapatas.\n\n¿Cómo estuvo el clima?')), 'y después sale el clima', s?.texto);
  d = await datos();
  exigir((d.preguntadas as string[] ?? []).includes('fecha') && d.fecha === hoyEnPanama(), 'la fecha queda confirmada en hoy');

  // ── «Otra fecha» la lee el modelo ───────────────────────────────────────
  await empezar();
  await guionizar([usar('empezar_reporte', {}), texto('')]);
  await conversar('Reporte');
  const antesOtra = (await peticiones()).length;
  await guionizar([texto('¿De qué fecha es?')]);
  s = await conversar('Otra fecha');
  exigir((await peticiones()).length > antesOtra && s?.texto === '¿De qué fecha es?', '«Otra fecha» la lee el modelo, y se espera su respuesta', s?.texto);

  // ── las dos correcciones, fuera del reporte ─────────────────────────────
  await empezar();
  await guionizar([texto('Anoté lo de la limpieza.'), texto('¿Qué más se hizo?')]);
  s = await conversar('También limpiamos el acceso');
  const corregida = JSON.stringify((await peticiones()).at(-1)?.messages?.at(-1)?.content ?? '');
  exigir(corregida.includes('no llamaste anotar') && s?.texto === '¿Qué más se hizo?', '«anoté» sin anotar vuelve al modelo, y sale la corregida', s?.texto);
  await guionizar([texto('¿Qué más se hizo?'), texto('¿Algo más del trabajo de hoy?')]);
  s = await conversar('Mmm');
  const repetida = JSON.stringify((await peticiones()).at(-1)?.messages?.at(-1)?.content ?? '');
  exigir(repetida.includes('exactamente lo que ya le mandaste') && s?.texto === '¿Algo más del trabajo de hoy?', 'el mismo mensaje dos veces vuelve al modelo, y sale dicho de otra manera', s?.texto);

  await pool.end();
  console.log(fallos === 0 ? '\nTodo bien' : `\n${fallos} fallo(s)`);
  process.exit(fallos === 0 ? 0 : 1);
};

main().catch(async (e) => {
  console.error(e);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
