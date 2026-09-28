// Prueba de humo: la fecha no frena el reporte, y el asistente no dice «lo
// anoto» sin anotar ni repite el mismo mensaje.
// npm run pruebas -- whatsapp-fecha
//
// Salio de la tanda del 2026-09-28: con el boton «Sí» volvia a preguntar la
// fecha; si a la fecha le contestaban otra cosa insistia cinco veces igual; y
// decia «lo anoto» y lo que le contaron se perdia. Se exige:
// - al elegir la obra el reporte ya trae la fecha de hoy, pendiente de confirmar;
// - «Sí» la confirma;
// - «Otra fecha» la deja pendiente: el modelo pregunta cual;
// - si contesta otra cosa, se queda la de hoy y el modelo recibe el aviso;
// - un «sí» que no contesta a la pregunta de la fecha no la toca;
// - la misma pregunta de la fecha, igualita, no sale dos veces seguidas;
// - una respuesta que dice «anoté» sin haber anotado vuelve al modelo;
// - una respuesta igual a la ultima que salio vuelve al modelo.
import { API } from './pruebas/contexto.js';
import { SECRETOS_PRUEBA } from './pruebas/entorno.js';
import crypto from 'crypto';
import { query, pool } from '../src/database/config.js';
import { hoyEnPanama } from '../src/services/whatsapp/herramientas.js';

const META = process.env.PRUEBAS_META ?? '';
const NUMERO = '50761110002';

let fallos = 0;
const exigir = (bien: boolean, que: string): void => {
  console.log(`${bien ? '  ok  ' : 'FALLA '} ${que}`);
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

const salidas = async (): Promise<unknown[]> =>
  (await (await fetch(`${META}/_prueba/enviados`)).json()) as unknown[];
const esperarSalidas = async (cuantas: number, segundos = 20): Promise<void> => {
  for (const hasta = Date.now() + segundos * 1000; Date.now() < hasta; await esperar(200)) {
    if ((await salidas()).length >= cuantas) return;
  }
};
const estado = async (): Promise<{ fecha?: string; confirmada: boolean }> => {
  const d = (
    await query<{ datos: { fecha?: string; preguntadas?: string[] } }>(
      'SELECT datos FROM whatsapp_conversaciones WHERE telefono = $1 AND activa',
      [NUMERO],
    )
  ).rows[0]?.datos;
  return { fecha: d?.fecha, confirmada: (d?.preguntadas ?? []).includes('fecha') };
};
const ultimaPeticion = async (): Promise<{ system: string; ultimo: string }> => {
  const ps = (await (await fetch(`${META}/_prueba/ia/peticiones`)).json()) as {
    system?: { text: string }[];
    messages?: { content: unknown }[];
  }[];
  const p = ps.at(-1);
  return {
    system: (p?.system ?? []).map((x) => x.text).join('\n'),
    ultimo: JSON.stringify(p?.messages?.at(-1)?.content ?? ''),
  };
};
const ultimoSalido = async (): Promise<string | null> =>
  ((await salidas()).at(-1) as { texto: string | null } | undefined)?.texto ?? null;
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
    `INSERT INTO user_permissions (user_id, reportes) VALUES ($1, true)
     ON CONFLICT (user_id) DO UPDATE SET reportes = true`,
    [u.rows[0].id],
  );
  await query(
    'INSERT INTO user_project_access (user_id, proyecto_id) VALUES ($1, 1) ON CONFLICT DO NOTHING',
    [u.rows[0].id],
  );

  // ── al elegir la obra ya hay fecha, sin confirmar ─────────────────────
  await guionizar([usar('elegir_proyecto', { proyecto_id: 1 }), usar('preguntar_fecha', {})]);
  await decir('Ayúdame con el reporte diario');
  await esperarSalidas(1);
  let e = await estado();
  exigir(e.fecha === hoyEnPanama() && !e.confirmada, 'al elegir la obra el reporte ya trae la fecha de hoy, sin confirmar');

  // ── «Sí» ────────────────────────────────────────────────────────────────
  await guionizar([texto('¿Cómo estuvo el clima?')]);
  await decir('Sí');
  await esperarSalidas(2);
  e = await estado();
  exigir(e.fecha === hoyEnPanama() && e.confirmada, '«Sí» a la pregunta de la fecha la confirma');
  exigir(
    (await ultimaPeticion()).system.includes('"preguntadas":["fecha"]'),
    'y el modelo ya la ve confirmada cuando le toca pensar',
  );

  // ── «Otra fecha» ────────────────────────────────────────────────────────
  await empezar();
  await guionizar([usar('elegir_proyecto', { proyecto_id: 1 }), usar('preguntar_fecha', {})]);
  await decir('Reporte diario');
  await esperarSalidas(3);
  await guionizar([texto('¿De qué fecha es?')]);
  await decir('Otra fecha');
  await esperarSalidas(4);
  exigir(!(await estado()).confirmada, '«Otra fecha» la deja pendiente');

  // ── contesta otra cosa, y el modelo quiere repetir la pregunta ─────────
  await empezar();
  await guionizar([usar('elegir_proyecto', { proyecto_id: 1 }), usar('preguntar_fecha', {})]);
  await decir('Reporte');
  await esperarSalidas(5);
  await guionizar([usar('preguntar_fecha', {}), texto('Queda con la de hoy. ¿Cómo estuvo el clima?')]);
  await decir('Colocamos 6 zapatas en el área 1');
  await esperarSalidas(6);
  e = await estado();
  const p = await ultimaPeticion();
  exigir(e.confirmada && e.fecha === hoyEnPanama(), 'si contesta otra cosa, se queda la de hoy');
  exigir(
    p.system.includes('AVISO DEL SISTEMA') && p.system.includes('media línea'),
    'y el modelo recibe el aviso para decírselo',
  );
  exigir(
    p.ultimo.includes('ya se la mandaste exactamente igual') &&
      (await salidas()).length === 6 &&
      (await ultimoSalido()) === 'Queda con la de hoy. ¿Cómo estuvo el clima?',
    'la misma pregunta de la fecha, igualita, no sale dos veces seguidas',
  );

  // ── un «sí» que contesta a otra cosa ────────────────────────────────────
  await empezar();
  await guionizar([texto('¿Quieres hacer el reporte diario?')]);
  await decir('Hola');
  await esperarSalidas(7);
  await guionizar([texto('Dale.')]);
  await decir('Sí');
  await esperarSalidas(8);
  e = await estado();
  exigir(e.fecha === undefined && !e.confirmada, 'un «sí» a otra pregunta no toca la fecha');

  // ── «anoté» sin anotar ──────────────────────────────────────────────────
  await guionizar([texto('Anoté lo de la limpieza.'), texto('¿Qué más se hizo?')]);
  await decir('También limpiamos el acceso');
  await esperarSalidas(9);
  exigir(
    (await ultimaPeticion()).ultimo.includes('no llamaste anotar'),
    'una respuesta que dice «anoté» sin haber anotado vuelve al modelo',
  );
  exigir((await ultimoSalido()) === '¿Qué más se hizo?', 'y sale la respuesta corregida, no la otra');

  // ── el mismo mensaje dos veces ──────────────────────────────────────────
  await guionizar([texto('¿Qué más se hizo?'), texto('¿Algo más del trabajo de hoy?')]);
  await decir('Mmm');
  await esperarSalidas(10);
  exigir(
    (await ultimaPeticion()).ultimo.includes('exactamente lo que ya le mandaste'),
    'una respuesta igual a la ultima que salio vuelve al modelo',
  );
  exigir((await ultimoSalido()) === '¿Algo más del trabajo de hoy?', 'y sale dicha de otra manera');

  await pool.end();
  console.log(fallos === 0 ? '\nTodo bien' : `\n${fallos} fallo(s)`);
  process.exit(fallos === 0 ? 0 : 1);
};

main().catch(async (e) => {
  console.error(e);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
