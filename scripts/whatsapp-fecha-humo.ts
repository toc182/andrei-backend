// Prueba de humo: el «Sí» a la pregunta de la fecha lo anota el sistema.
// npm run pruebas -- whatsapp-fecha
//
// Con el boton «Sí» el modelo volvia a preguntar la fecha (tanda del
// 2026-09-28). Ahora, si lo ultimo que salio fue la pregunta de la fecha y la
// persona contesta que si, la fecha de hoy queda anotada antes de que el
// modelo piense. Se exige:
// - «Sí» deja la fecha de hoy, y el modelo ya la ve anotada;
// - «Otra fecha» no anota nada: eso lo resuelve el modelo preguntando cual;
// - un «sí» que no contesta a la pregunta de la fecha no toca la fecha.
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
const esperarSalidas = async (cuantas: number): Promise<void> => {
  for (const hasta = Date.now() + 20000; Date.now() < hasta; await esperar(200)) {
    if ((await salidas()).length >= cuantas) return;
  }
};
const fecha = async (): Promise<string | undefined> =>
  (
    await query<{ datos: { fecha?: string } }>(
      'SELECT datos FROM whatsapp_conversaciones WHERE telefono = $1 AND activa',
      [NUMERO],
    )
  ).rows[0]?.datos?.fecha;
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

  // ── «Sí» ────────────────────────────────────────────────────────────────
  await guionizar([usar('elegir_proyecto', { proyecto_id: 1 }), usar('preguntar_fecha', {})]);
  await decir('Ayúdame con el reporte diario');
  await esperarSalidas(1);
  await guionizar([texto('¿Cómo estuvo el clima?')]);
  await decir('Sí');
  await esperarSalidas(2);
  exigir((await fecha()) === hoyEnPanama(), '«Sí» a la pregunta de la fecha deja anotada la de hoy');
  const peticiones = (await (await fetch(`${META}/_prueba/ia/peticiones`)).json()) as {
    system?: { text: string }[];
  }[];
  const contexto = (peticiones.at(-1)?.system ?? []).map((s) => s.text).join('\n');
  exigir(
    contexto.includes(`"fecha":"${hoyEnPanama()}"`),
    'y el modelo ya la ve anotada cuando le toca pensar',
  );

  // ── «Otra fecha» ────────────────────────────────────────────────────────
  await empezar();
  await guionizar([usar('elegir_proyecto', { proyecto_id: 1 }), usar('preguntar_fecha', {})]);
  await decir('Reporte diario');
  await esperarSalidas(3);
  await guionizar([texto('¿De qué fecha es?')]);
  await decir('Otra fecha');
  await esperarSalidas(4);
  exigir((await fecha()) === undefined, '«Otra fecha» no anota nada');

  // ── un «sí» que contesta a otra cosa ────────────────────────────────────
  await empezar();
  await guionizar([texto('¿Quieres hacer el reporte diario?')]);
  await decir('Hola');
  await esperarSalidas(5);
  await guionizar([texto('Dale.')]);
  await decir('Sí');
  await esperarSalidas(6);
  exigir((await fecha()) === undefined, 'un «sí» a otra pregunta no toca la fecha');

  await pool.end();
  console.log(fallos === 0 ? '\nTodo bien' : `\n${fallos} fallo(s)`);
  process.exit(fallos === 0 ? 0 : 1);
};

main().catch(async (e) => {
  console.error(e);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
