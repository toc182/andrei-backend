// Prueba de humo: las fotos al final del reporte por WhatsApp.
// npm run pruebas -- whatsapp-fotos
//
// Lo que paso el 28/09 (Ivan) y el 30/09 (Cesar): al mandar varias fotos
// juntas, WhatsApp manda antes un mensaje que no deja leer («unsupported») y
// las fotos unos segundos despues. El asistente contestaba a ese mensaje vacio
// antes de que llegaran las fotos, y otra vez ofrecia el borrador con sus
// palabras en vez de con los botones. Se exige:
// - un mensaje ilegible solo no abre turno: se espera a las fotos, y sale UNA
//   respuesta, cuando ya llegaron;
// - un turno de solo fotos lo contesta el sistema, sin llamar al modelo:
//   «Recibí N fotos.» y detras la pregunta que toca, con sus botones;
// - un ilegible que llega solo se atiende igual pasada la espera, y el modelo
//   se entera de que llego algo que no se pudo leer.
import crypto from 'crypto';
import { API } from './pruebas/contexto.js';
import { SECRETOS_PRUEBA } from './pruebas/entorno.js';
import { query, pool } from '../src/database/config.js';
import { conversacionViva, fotosDe, guardarConversacion } from '../src/services/whatsapp/conversacion.js';
import { hoyEnPanama } from '../src/services/whatsapp/herramientas.js';

const META = process.env.PRUEBAS_META ?? '';
const WEBHOOK = `${API}/whatsapp/webhook`;
const NUMERO = '50761110004';

let fallos = 0;
const exigir = (bien: boolean, que: string, visto?: unknown): void => {
  console.log(`${bien ? '  ok  ' : 'FALLA '} ${que}${bien || visto === undefined ? '' : ` → ${JSON.stringify(visto)}`}`);
  if (!bien) fallos += 1;
};
const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

let n = 0;
const entregar = async (mensaje: Record<string, unknown>): Promise<void> => {
  const sobre = {
    object: 'whatsapp_business_account',
    entry: [{
      id: '1',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { phone_number_id: SECRETOS_PRUEBA.numeroId },
          messages: [{ id: `wamid.F${(n += 1)}`, from: NUMERO, ...mensaje }],
        },
      }],
    }],
  };
  const crudo = Buffer.from(JSON.stringify(sobre), 'utf8');
  await fetch(WEBHOOK, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Hub-Signature-256':
        'sha256=' + crypto.createHmac('sha256', SECRETOS_PRUEBA.appSecret).update(crudo).digest('hex'),
    },
    body: crudo,
  });
};

/** Lo que manda WhatsApp delante de unas fotos juntas, tal cual llego el 30/09. */
const ilegible = () =>
  entregar({
    type: 'unsupported',
    errors: [{ code: 131051, title: 'Message type unknown', message: 'Message type unknown' }],
    unsupported: { type: 'unknown', raw_type: 'unknown' },
  });

const foto = async (pie?: string): Promise<void> => {
  const media = (await (
    await fetch(`${META}/_prueba/media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Un JPEG cualquiera: lo que se prueba aqui es el turno, no la imagen.
      body: JSON.stringify({ base64: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64'), tipoMime: 'image/jpeg' }),
    })
  ).json()) as { mediaId: string };
  await entregar({ type: 'image', image: { id: media.mediaId, mime_type: 'image/jpeg', ...(pie ? { caption: pie } : {}) } });
};

const enviados = async (): Promise<{ telefono: string; tipo: string; texto: string | null }[]> =>
  ((await (await fetch(`${META}/_prueba/enviados`)).json()) as { telefono: string; tipo: string; texto: string | null }[])
    .filter((e) => e.telefono === NUMERO);
const peticionesIa = async (): Promise<unknown[]> =>
  (await (await fetch(`${META}/_prueba/ia/peticiones`)).json()) as unknown[];
const guionizar = async (respuestas: unknown[]): Promise<void> => {
  await fetch(`${META}/_prueba/ia`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(respuestas),
  });
};

async function esperarEnviados(cuantos: number, segundos: number): Promise<number> {
  const hasta = Date.now() + segundos * 1000;
  for (;;) {
    const e = await enviados();
    if (e.length >= cuantos || Date.now() > hasta) return e.length;
    await esperar(200);
  }
}

const main = async () => {
  if (!META) {
    console.error('falta PRUEBAS_META');
    process.exit(1);
  }
  const usuario = (await query<{ id: number }>(
    `UPDATE users SET whatsapp = $1 WHERE email = 'aprobador3@pruebas.local' RETURNING id`,
    [NUMERO],
  )).rows[0];
  await query(
    `INSERT INTO user_permissions (user_id, reportes) VALUES ($1, true)
     ON CONFLICT (user_id) DO UPDATE SET reportes = true`,
    [usuario.id],
  );
  await query('INSERT INTO user_project_access (user_id, proyecto_id) VALUES ($1, 1) ON CONFLICT DO NOTHING', [usuario.id]);

  // Un reporte al que solo le faltan las fotos, y la pregunta de las fotos ya
  // hecha: como estaban Cesar y Ivan.
  const area = (await query<{ id: number }>('SELECT id FROM proyecto_areas WHERE proyecto_id = 1 ORDER BY orden, id LIMIT 1')).rows[0].id;
  const conversacion = await conversacionViva(NUMERO, usuario.id);
  await guardarConversacion(conversacion.id, {
    modo: 'reporte_diario',
    proyectoId: 1,
    datos: {
      fecha: hoyEnPanama(),
      clima: 'Soleado',
      horasPerdidas: 0,
      areas: [area],
      trabajos: [{ areaId: area, texto: 'Colocación de anclas de pedestales' }],
      personal: [],
      equipos: [],
      entregas: [],
      preguntadas: ['fecha', 'atrasos', 'novedades', 'personal', 'equipos', 'entregas'],
      veces: { fecha: 1, clima: 1, horas: 1, areas: 1, [`trabajo:${area}`]: 1, mal: 1, gente: 1, maquinas: 1, llego: 1, fotos: 1 },
      ultimaPregunta: 'fotos',
    },
  });
  const pensadas = (await peticionesIa()).length;

  // ── el ilegible y, segundos despues, las fotos ──────────────────────────
  await ilegible();
  await esperar(2500); // mas que la espera normal de las pruebas (1,2 s)
  exigir((await enviados()).length === 0, 'al mensaje ilegible solo no se le contesta enseguida');
  await foto('Anclas del pedestal P-3');
  await foto();
  await foto();

  const salieron = await esperarEnviados(1, 20);
  await esperar(2000); // que no llegue una segunda
  const e = await enviados();
  exigir(salieron === 1 && e.length === 1, 'sale UNA respuesta, cuando ya llegaron las fotos', e);
  exigir(
    e[0]?.tipo === 'interactive' && Boolean(e[0]?.texto?.startsWith('Recibí 3 fotos.')),
    'el sistema dice cuántas fotos recibió y la pregunta va con sus botones',
    e[0],
  );
  exigir(Boolean(e[0]?.texto?.includes('borrador')), 'y lo que toca es ofrecer el borrador', e[0]?.texto);
  exigir((await peticionesIa()).length === pensadas, 'un turno de solo fotos no llama al modelo');
  exigir((await fotosDe(conversacion.id)) === 3, 'las tres fotos quedan en el reporte');
  const pie = await query<{ texto: string | null }>(
    `SELECT texto FROM whatsapp_mensajes WHERE telefono = $1 AND tipo = 'image' AND texto IS NOT NULL`,
    [NUMERO],
  );
  exigir(pie.rows[0]?.texto === 'Anclas del pedestal P-3', 'el pie de la foto se guarda para su leyenda');

  // ── un ilegible solo, sin nada detras ───────────────────────────────────
  await guionizar([
    { content: [{ type: 'text', text: 'No pude ver lo que mandaste. ¿Me lo mandas como foto o como texto?' }], stop_reason: 'end_turn' },
  ]);
  const inicio = Date.now();
  await ilegible();
  const llegaron = await esperarEnviados(2, 25);
  const tardo = Date.now() - inicio;
  exigir(llegaron === 2, 'un ilegible que llega solo se atiende igual', llegaron);
  exigir(tardo >= 8000, 'pero después de esperar a ver si venía algo detrás', tardo);
  const ultima = JSON.stringify((await peticionesIa()).at(-1) ?? {});
  exigir(ultima.includes('WhatsApp no deja leer'), 'y el modelo se entera de que llegó algo que no se pudo leer');

  await pool.end();
  console.log(fallos === 0 ? '\nTodo bien' : `\n${fallos} fallo(s)`);
  process.exit(fallos === 0 ? 0 : 1);
};

main().catch(async (e) => {
  console.error(e);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
