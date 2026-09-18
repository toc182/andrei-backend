// Prueba de humo: lo que entra por el WhatsApp de la empresa.
// npm run pruebas -- whatsapp-entrada
//
// Esta pieza es la puerta y el registro, todavia sin asistente. Se exige:
// - el saludo de alta solo pasa con la palabra acordada;
// - una entrega sin firma, o con la firma cambiada, se rechaza y no guarda nada;
// - el WhatsApp de una persona se guarda como lo manda Meta (507 delante) y no
//   se lo puede quedar otra;
// - un mensaje de un numero registrado queda guardado a nombre de su dueno, y
//   NO se le contesta nada todavia;
// - la misma entrega repetida —Meta reintenta— no duplica el mensaje;
// - una foto se copia a R2 con sus bytes, y su pie de foto queda como texto;
// - a un numero desconocido se le contesta una vez, y esa respuesta queda anotada;
// - cuando Meta avisa de que un envio nuestro fallo, el motivo queda en su fila.
import { API } from './pruebas/contexto.js';
import { SECRETOS_PRUEBA } from './pruebas/entorno.js';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import sharp from 'sharp';
import { query, pool } from '../src/database/config.js';
import { downloadFile } from '../src/services/storage.js';

const META = process.env.PRUEBAS_META ?? '';
const WEBHOOK = `${API}/whatsapp/webhook`;
const NUMERO_INGENIERO = '50766199092';
const NUMERO_DESCONOCIDO = '50761234567';

let fallos = 0;
const exigir = (bien: boolean, que: string): void => {
  console.log(`${bien ? '  ok  ' : 'FALLA '} ${que}`);
  if (!bien) fallos += 1;
};

/** Una entrega firmada como la firma Meta. */
const entregar = async (sobre: unknown, firmaMala = false): Promise<number> => {
  const crudo = Buffer.from(JSON.stringify(sobre), 'utf8');
  const firma =
    'sha256=' +
    crypto
      .createHmac('sha256', firmaMala ? 'otro-secreto' : SECRETOS_PRUEBA.appSecret)
      .update(crudo)
      .digest('hex');
  const res = await fetch(WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': firma },
    body: crudo,
  });
  return res.status;
};

/** El sobre de un mensaje, con la forma que manda Meta. */
const sobreMensaje = (mensaje: Record<string, unknown>): unknown => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: '1064189769861023',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { phone_number_id: SECRETOS_PRUEBA.numeroId },
            messages: [mensaje],
          },
        },
      ],
    },
  ],
});

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** El trabajo se hace despues de contestarle 200 a Meta: hay que esperarlo. */
async function esperarFila<T extends Record<string, unknown>>(
  sql: string,
  params: unknown[],
  condicion: (f: T | undefined) => boolean,
  segundos = 15,
): Promise<T | undefined> {
  const hasta = Date.now() + segundos * 1000;
  for (;;) {
    const r = await query<T>(sql, params);
    const fila = r.rows[0];
    if (condicion(fila)) return fila;
    if (Date.now() > hasta) return fila;
    await esperar(200);
  }
}

const main = async () => {
  if (!META) {
    console.error('falta PRUEBAS_META: esta prueba necesita el Meta de mentira');
    process.exit(1);
  }

  const admin = await query<{ id: number; email: string; rol: string }>(
    "SELECT id, email, rol FROM users WHERE rol='admin' AND activo=true ORDER BY id LIMIT 1",
  );
  const token = jwt.sign(
    { userId: admin.rows[0].id, email: admin.rows[0].email, rol: admin.rows[0].rol },
    process.env.JWT_SECRET!,
    { expiresIn: '10m' },
  );
  const pedir = async (m: string, ruta: string, cuerpo?: unknown) => {
    const res = await fetch(`${API}${ruta}`, {
      method: m,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(cuerpo ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(cuerpo ? { body: JSON.stringify(cuerpo) } : {}),
    });
    return { estado: res.status, cuerpo: (await res.json().catch(() => null)) as never };
  };

  const enviados = async (): Promise<{ telefono: string; texto: string | null }[]> =>
    (await (await fetch(`${META}/_prueba/enviados`)).json()) as never;

  // ── el saludo de alta ───────────────────────────────────────────────────
  const alta = async (palabra: string) =>
    fetch(
      `${WEBHOOK}?hub.mode=subscribe&hub.verify_token=${palabra}&hub.challenge=1234`,
    );
  const buena = await alta(SECRETOS_PRUEBA.verifyToken);
  exigir(
    buena.status === 200 && (await buena.text()) === '1234',
    'el saludo de alta devuelve el desafio cuando la palabra es la acordada',
  );
  exigir((await alta('otra-palabra')).status === 403, 'con otra palabra, el alta se rechaza');

  // ── la firma ────────────────────────────────────────────────────────────
  const sobreFalso = sobreMensaje({
    id: 'wamid.FALSO',
    from: NUMERO_INGENIERO,
    type: 'text',
    text: { body: 'entrega sin firma buena' },
  });
  exigir(await entregar(sobreFalso, true).then((e) => e === 401), 'la firma cambiada se rechaza');
  const sinFirma = await fetch(WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(sobreFalso),
  });
  exigir(sinFirma.status === 401, 'una entrega sin firma se rechaza');
  await esperar(500);
  const falsos = await query('SELECT id FROM whatsapp_mensajes WHERE wa_id = $1', ['wamid.FALSO']);
  exigir(falsos.rows.length === 0, 'lo rechazado no queda guardado');

  // ── el numero en la ficha de la persona ─────────────────────────────────
  const gente = await query<{ id: number; nombre: string }>(
    "SELECT id, nombre FROM users WHERE email LIKE 'aprobador%@pruebas.local' ORDER BY id",
  );
  const ingeniero = gente.rows[0];
  const otro = gente.rows[1];

  const puesto = await pedir('PUT', `/users/${ingeniero.id}`, { whatsapp: '6619-9092' });
  const guardado = await query<{ whatsapp: string }>('SELECT whatsapp FROM users WHERE id = $1', [
    ingeniero.id,
  ]);
  exigir(
    puesto.estado === 200 && guardado.rows[0].whatsapp === NUMERO_INGENIERO,
    'un numero escrito a mano se guarda como lo manda Meta (507 delante, solo digitos)',
  );

  const repetido = await pedir('PUT', `/users/${otro.id}`, { whatsapp: '+507 6619 9092' });
  exigir(repetido.estado === 400, 'el mismo WhatsApp no se lo puede quedar otra persona');

  const corto = await pedir('PUT', `/users/${otro.id}`, { whatsapp: '12345' });
  exigir(corto.estado === 400, 'un numero sin codigo de pais se rechaza');

  // ── un mensaje de alguien registrado ────────────────────────────────────
  const WA_TEXTO = 'wamid.TEXTO1';
  exigir(
    (await entregar(
      sobreMensaje({
        id: WA_TEXTO,
        from: NUMERO_INGENIERO,
        type: 'text',
        text: { body: 'Hoy vaciamos la losa del nivel 2' },
      }),
    )) === 200,
    'una entrega firmada se acepta',
  );

  const fila = await esperarFila<{ id: number; user_id: number; texto: string; tipo: string }>(
    'SELECT id, user_id, texto, tipo FROM whatsapp_mensajes WHERE wa_id = $1',
    [WA_TEXTO],
    (f) => f !== undefined,
  );
  exigir(
    fila?.user_id === ingeniero.id && fila?.texto === 'Hoy vaciamos la losa del nivel 2',
    'el mensaje queda guardado a nombre del dueno del numero',
  );
  exigir((await enviados()).length === 0, 'a alguien registrado todavia no se le contesta nada');

  const avisos = (await (await fetch(`${META}/_prueba/escribiendo`)).json()) as string[];
  exigir(
    avisos.includes(WA_TEXTO),
    'al recibirlo se le marca como leido y se le ensena «escribiendo...»',
  );

  // ── el repetido de Meta ─────────────────────────────────────────────────
  await entregar(
    sobreMensaje({
      id: WA_TEXTO,
      from: NUMERO_INGENIERO,
      type: 'text',
      text: { body: 'Hoy vaciamos la losa del nivel 2' },
    }),
  );
  await esperar(700);
  const cuantos = await query<{ n: string }>(
    'SELECT count(*)::text AS n FROM whatsapp_mensajes WHERE wa_id = $1',
    [WA_TEXTO],
  );
  exigir(cuantos.rows[0].n === '1', 'la misma entrega repetida no duplica el mensaje');

  // ── una foto ────────────────────────────────────────────────────────────
  const foto = await sharp({
    create: { width: 80, height: 60, channels: 3, background: { r: 20, g: 120, b: 90 } },
  })
    .jpeg()
    .toBuffer();
  const alta_media = (await (
    await fetch(`${META}/_prueba/media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base64: foto.toString('base64'), tipoMime: 'image/jpeg' }),
    })
  ).json()) as { mediaId: string };

  const WA_FOTO = 'wamid.FOTO1';
  await entregar(
    sobreMensaje({
      id: WA_FOTO,
      from: NUMERO_INGENIERO,
      type: 'image',
      image: { id: alta_media.mediaId, mime_type: 'image/jpeg', caption: 'Vaciado losa nivel 2' },
    }),
  );
  const conFoto = await esperarFila<{
    r2_key: string | null;
    texto: string | null;
    tipo_mime: string | null;
    tamano: number | null;
    error: string | null;
  }>(
    'SELECT r2_key, texto, tipo_mime, tamano, error FROM whatsapp_mensajes WHERE wa_id = $1',
    [WA_FOTO],
    (f) => f?.r2_key !== null && f?.r2_key !== undefined,
  );
  exigir(
    conFoto?.texto === 'Vaciado losa nivel 2' && conFoto?.tipo_mime === 'image/jpeg',
    'el pie de foto queda como texto del mensaje',
  );
  exigir(
    Boolean(conFoto?.r2_key?.startsWith('whatsapp/')) && conFoto?.error === null,
    'la foto queda copiada en el almacen, no en Meta',
  );
  if (conFoto?.r2_key) {
    const bajada = await downloadFile(conFoto.r2_key).catch(() => Buffer.alloc(0));
    exigir(bajada.equals(foto), 'los bytes guardados son los de la foto que mando el ingeniero');
  }

  // ── un numero desconocido ───────────────────────────────────────────────
  const WA_AJENO = 'wamid.AJENO1';
  await entregar(
    sobreMensaje({
      id: WA_AJENO,
      from: NUMERO_DESCONOCIDO,
      type: 'text',
      text: { body: 'buenas, quien es?' },
    }),
  );
  const ajeno = await esperarFila<{ user_id: number | null }>(
    'SELECT user_id FROM whatsapp_mensajes WHERE wa_id = $1',
    [WA_AJENO],
    (f) => f !== undefined,
  );
  exigir(ajeno !== undefined && ajeno.user_id === null, 'el mensaje de un desconocido se guarda igual');

  const respuestas = await (async () => {
    const hasta = Date.now() + 10_000;
    for (;;) {
      const e = await enviados();
      if (e.length > 0 || Date.now() > hasta) return e;
      await esperar(200);
    }
  })();
  exigir(
    respuestas.length === 1 &&
      respuestas[0].telefono === NUMERO_DESCONOCIDO &&
      Boolean(respuestas[0].texto?.includes('no está registrado')),
    'al desconocido se le contesta una sola vez que su numero no esta registrado',
  );

  const anotada = await esperarFila<{ wa_id: string | null; error: string | null }>(
    "SELECT wa_id, error FROM whatsapp_mensajes WHERE direccion = 'saliente' AND telefono = $1",
    [NUMERO_DESCONOCIDO],
    (f) => f?.wa_id !== null && f?.wa_id !== undefined,
  );
  exigir(anotada?.error === null, 'la respuesta queda anotada con el id que le dio WhatsApp');

  // ── el aviso de que un envio nuestro no llego ───────────────────────────
  if (anotada?.wa_id) {
    await entregar({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '1064189769861023',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: SECRETOS_PRUEBA.numeroId },
                statuses: [
                  {
                    id: anotada.wa_id,
                    status: 'failed',
                    recipient_id: NUMERO_DESCONOCIDO,
                    errors: [{ code: 131000, title: 'Something went wrong' }],
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const conError = await esperarFila<{ error: string | null }>(
      'SELECT error FROM whatsapp_mensajes WHERE wa_id = $1',
      [anotada.wa_id],
      (f) => f?.error !== null,
    );
    exigir(
      conError?.error === 'Something went wrong',
      'cuando Meta avisa de que no se entrego, el motivo queda en la fila',
    );
  }

  await pool.end();
  console.log(fallos === 0 ? '\nTodo bien' : `\n${fallos} fallo(s)`);
  process.exit(fallos === 0 ? 0 : 1);
};

main().catch(async (e) => {
  console.error(e);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
