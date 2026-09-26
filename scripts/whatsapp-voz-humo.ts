// Prueba de humo: las notas de voz del asistente.
// npm run pruebas -- whatsapp-voz
//
// Quien «oye» es el Whisper de mentira del entorno de pruebas, igual que el
// modelo va guionizado: lo que se comprueba aqui NO es que se entienda bien una
// obra con ruido, sino que la maquinaria funciona —que la nota se guarda, se
// pasa a texto antes de que el asistente piense, que el modelo la lee como lo
// que dijo la persona, que se le manda el vocabulario de esa obra y que una
// nota que no se entiende no se cuela en el reporte.
import { API } from './pruebas/contexto.js';
import { SECRETOS_PRUEBA } from './pruebas/entorno.js';
import crypto from 'crypto';
import { query, pool } from '../src/database/config.js';

const META = process.env.PRUEBAS_META ?? '';
const WEBHOOK = `${API}/whatsapp/webhook`;
const NUMERO = '50761110002';

let fallos = 0;
const exigir = (bien: boolean, que: string): void => {
  console.log(`${bien ? '  ok  ' : 'FALLA '} ${que}`);
  if (!bien) fallos += 1;
};

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

let n = 0;
const entregar = async (mensaje: Record<string, unknown>): Promise<void> => {
  const sobre = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '1',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: SECRETOS_PRUEBA.numeroId },
              messages: [{ id: `wamid.V${(n += 1)}`, from: NUMERO, ...mensaje }],
            },
          },
        ],
      },
    ],
  };
  const crudo = Buffer.from(JSON.stringify(sobre), 'utf8');
  await fetch(WEBHOOK, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Hub-Signature-256':
        'sha256=' +
        crypto.createHmac('sha256', SECRETOS_PRUEBA.appSecret).update(crudo).digest('hex'),
    },
    body: crudo,
  });
};

const decir = (texto: string) => entregar({ type: 'text', text: { body: texto } });

/** Sube un «audio» al Meta de mentira y lo manda como nota de voz. */
const mandarNota = async (bytes = 4000): Promise<void> => {
  const media = (await (
    await fetch(`${META}/_prueba/media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        base64: Buffer.alloc(bytes, 7).toString('base64'),
        tipoMime: 'audio/ogg; codecs=opus',
      }),
    })
  ).json()) as { mediaId: string };
  await entregar({
    type: 'audio',
    audio: { id: media.mediaId, mime_type: 'audio/ogg; codecs=opus', voice: true },
  });
};

const guionizar = async (respuestas: unknown[]): Promise<void> => {
  await fetch(`${META}/_prueba/ia`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(respuestas),
  });
};
const guionizarAudio = async (textos: string[]): Promise<void> => {
  await fetch(`${META}/_prueba/audio`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(textos),
  });
};

const texto = (t: string) => ({ content: [{ type: 'text', text: t }], stop_reason: 'end_turn' });
const usar = (nombre: string, input: unknown, id = `tu_${Math.random().toString(36).slice(2)}`) => ({
  content: [{ type: 'tool_use', id, name: nombre, input }],
  stop_reason: 'tool_use',
});

const enviados = async (): Promise<{ texto: string | null }[]> =>
  (await (await fetch(`${META}/_prueba/enviados`)).json()) as never;

const peticionesIa = async (): Promise<{ system?: { text: string }[] }[]> =>
  (await (await fetch(`${META}/_prueba/ia/peticiones`)).json()) as never;

const promptsAudio = async (): Promise<string[]> =>
  (await (await fetch(`${META}/_prueba/audio/prompts`)).json()) as never;

async function esperarRespuestas(cuantas: number, segundos = 25): Promise<{ texto: string | null }[]> {
  const hasta = Date.now() + segundos * 1000;
  for (;;) {
    const e = await enviados();
    if (e.length >= cuantas || Date.now() > hasta) return e;
    await esperar(200);
  }
}

const main = async () => {
  if (!META) {
    console.error('falta PRUEBAS_META');
    process.exit(1);
  }

  const usuario = await query<{ id: number }>(
    `UPDATE users SET whatsapp = $1
      WHERE id = (SELECT id FROM users WHERE email = 'aprobador2@pruebas.local')
      RETURNING id`,
    [NUMERO],
  );
  const userId = usuario.rows[0].id;
  await query(
    `INSERT INTO user_permissions (user_id, reportes) VALUES ($1, true)
     ON CONFLICT (user_id) DO UPDATE SET reportes = true`,
    [userId],
  );
  await query(
    `INSERT INTO user_project_access (user_id, proyecto_id) VALUES ($1, 1)
     ON CONFLICT DO NOTHING`,
    [userId],
  );

  // ── la obra ya elegida, para que la nota lleve su vocabulario ───────────
  await guionizar([
    usar('ver_proyectos', {}),
    usar('elegir_proyecto', { proyecto_id: 1 }),
    texto('Listo. Cuéntame qué se hizo hoy.'),
  ]);
  await decir('Ayúdame con el reporte diario');
  await esperarRespuestas(1);

  // ── una nota de voz se oye y se anota ───────────────────────────────────
  await guionizarAudio(['Hoy vaciamos la losa del nivel 2 con la retroexcavadora']);
  await guionizar([
    usar('anotar', { trabajos: [{ area_id: null, texto: 'Vaciado de la losa del nivel 2' }] }),
    texto('Anotado lo del vaciado. ¿Cómo estuvo el clima?'),
  ]);
  await mandarNota();

  const segunda = await esperarRespuestas(2);
  exigir(
    segunda.length === 2 && Boolean(segunda[1].texto?.includes('clima')),
    'una nota de voz se atiende como cualquier mensaje',
  );

  const guardado = await query<{ texto: string | null; tipo: string; error: string | null }>(
    `SELECT texto, tipo, error FROM whatsapp_mensajes
      WHERE telefono = $1 AND tipo = 'audio' ORDER BY id DESC LIMIT 1`,
    [NUMERO],
  );
  exigir(
    guardado.rows[0]?.texto === 'Hoy vaciamos la losa del nivel 2 con la retroexcavadora',
    'lo que dijo queda guardado como texto en el mensaje',
  );

  const ultima = (await peticionesIa()).at(-1);
  const contexto = JSON.stringify(ultima ?? {});
  exigir(
    contexto.includes('[nota de voz] Hoy vaciamos la losa'),
    'el modelo la lee como lo que dijo la persona, marcada como nota de voz',
  );

  const prompts = await promptsAudio();
  exigir(
    Boolean(prompts.at(-1)?.includes('Retroexcavadora')),
    'y se le manda el vocabulario de esa obra a quien transcribe',
  );

  // ── una nota que no se entiende no se inventa ───────────────────────────
  await guionizarAudio(['Subtítulos realizados por la comunidad de Amara.org']);
  await guionizar([texto('No te entendí la nota de voz. ¿Me la repites o me lo escribes?')]);
  await mandarNota();

  const tercera = await esperarRespuestas(3);
  exigir(
    tercera.length === 3 && Boolean(tercera[2].texto?.includes('entendí')),
    'lo que Whisper se inventa con el silencio no entra: se pide que lo repita',
  );
  const fallida = await query<{ texto: string | null; error: string | null }>(
    `SELECT texto, error FROM whatsapp_mensajes
      WHERE telefono = $1 AND tipo = 'audio' ORDER BY id DESC LIMIT 1`,
    [NUMERO],
  );
  exigir(
    fallida.rows[0]?.texto === null && (fallida.rows[0]?.error ?? '').includes('no se entendió'),
    'y la nota queda marcada como no entendida, sin texto inventado',
  );
  const ultima2 = (await peticionesIa()).at(-1);
  exigir(
    JSON.stringify(ultima2 ?? {}).includes('[nota de voz que no se pudo entender]'),
    'el modelo se entera de que la nota no se pudo leer',
  );

  // ── una nota larguisima ni se manda a transcribir ───────────────────────
  await guionizar([texto('Esa nota es muy larga. Mándamela más corta o escríbemelo.')]);
  await mandarNota(1_600_000);
  const cuarta = await esperarRespuestas(4);
  exigir(
    cuarta.length === 4 && Boolean(cuarta[3].texto?.includes('larga')),
    'una nota de más de doce minutos se rechaza sin pagar por transcribirla',
  );
  const larga = await query<{ error: string | null }>(
    `SELECT error FROM whatsapp_mensajes WHERE telefono = $1 AND tipo = 'audio' ORDER BY id DESC LIMIT 1`,
    [NUMERO],
  );
  exigir(
    (larga.rows[0]?.error ?? '').includes('demasiado larga'),
    'y queda dicho en el mensaje por qué no se leyó',
  );

  await pool.end();
  console.log(fallos === 0 ? '\nTodo bien' : `\n${fallos} fallo(s)`);
  process.exit(fallos === 0 ? 0 : 1);
};

main().catch(async (e) => {
  console.error(e);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
