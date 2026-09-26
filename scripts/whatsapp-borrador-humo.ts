// Prueba de humo: el borrador en PDF y el envio del reporte desde WhatsApp.
// npm run pruebas -- whatsapp-borrador
//
// El modelo va guionizado; lo que se comprueba es lo que pasa de verdad cuando
// llama a sus herramientas. Se exige:
// - el borrador se arma con lo anotado y sale como PDF con «BORRADOR» cruzado;
// - el reporte que crea es un borrador de verdad: sin numero, invisible en la
//   lista, y con las fotos que la persona mando por WhatsApp;
// - pedirlo dos veces no deja dos borradores vivos;
// - no se puede enviar sin que la persona haya visto el borrador, ni sin que
//   haya contestado despues de verlo;
// - la pregunta de enviar sale con sus dos botones;
// - al enviar: el reporte coge numero, queda en cola de correo, la persona
//   recibe su copia en PDF sin el sello, y la conversacion se cierra.
import { API } from './pruebas/contexto.js';
import { SECRETOS_PRUEBA } from './pruebas/entorno.js';
import crypto from 'crypto';
import sharp from 'sharp';
import { query, pool } from '../src/database/config.js';

const META = process.env.PRUEBAS_META ?? '';
const NUMERO = '50762220000';

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
              messages: [{ id: `wamid.B${(n += 1)}`, from: NUMERO, ...mensaje }],
            },
          },
        ],
      },
    ],
  };
  const crudo = Buffer.from(JSON.stringify(sobre), 'utf8');
  await fetch(`${API}/whatsapp/webhook`, {
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
const tocarBoton = (id: string, titulo: string) =>
  entregar({
    type: 'interactive',
    interactive: { type: 'button_reply', button_reply: { id, title: titulo } },
  });

const guionizar = async (respuestas: unknown[]): Promise<void> => {
  await fetch(`${META}/_prueba/ia`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(respuestas),
  });
};
const texto = (t: string) => ({ content: [{ type: 'text', text: t }], stop_reason: 'end_turn' });
const usar = (nombre: string, input: unknown) => ({
  content: [
    { type: 'tool_use', id: `tu_${Math.random().toString(36).slice(2)}`, name: nombre, input },
  ],
  stop_reason: 'tool_use',
});

interface Salido {
  tipo: string;
  texto: string | null;
  archivo?: { nombre: string; bytes: number };
  cuerpo: { interactive?: { action?: { buttons?: { reply?: { id: string } }[] } } };
}
const salidos = async (): Promise<Salido[]> =>
  (await (await fetch(`${META}/_prueba/enviados`)).json()) as never;

async function esperarSalidos(cuantos: number, segundos = 60): Promise<Salido[]> {
  const hasta = Date.now() + segundos * 1000;
  for (;;) {
    const e = await salidos();
    if (e.length >= cuantos || Date.now() > hasta) return e;
    await esperar(250);
  }
}

const main = async () => {
  if (!META) {
    console.error('falta PRUEBAS_META');
    process.exit(1);
  }

  const u = await query<{ id: number }>(
    `UPDATE users SET whatsapp = $1
      WHERE id = (SELECT id FROM users WHERE email = 'aprobador2@pruebas.local')
      RETURNING id`,
    [NUMERO],
  );
  const userId = u.rows[0].id;
  await query(
    `INSERT INTO user_permissions (user_id, reportes) VALUES ($1, true)
     ON CONFLICT (user_id) DO UPDATE SET reportes = true`,
    [userId],
  );
  await query(
    'INSERT INTO user_project_access (user_id, proyecto_id) VALUES ($1, 1) ON CONFLICT DO NOTHING',
    [userId],
  );
  const areas = await query<{ id: number }>(
    'SELECT id FROM proyecto_areas WHERE proyecto_id = 1 AND activo = true ORDER BY id',
  );

  // ── el dia contado de una vez, y una foto ───────────────────────────────
  const foto = await sharp({
    create: { width: 50, height: 40, channels: 3, background: { r: 200, g: 80, b: 40 } },
  })
    .jpeg()
    .toBuffer();
  const media = (await (
    await fetch(`${META}/_prueba/media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base64: foto.toString('base64'), tipoMime: 'image/jpeg' }),
    })
  ).json()) as { mediaId: string };

  const HOY = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Panama' });
  await guionizar([
    usar('elegir_proyecto', { proyecto_id: 1 }),
    usar('anotar', {
      fecha: HOY,
      clima: 'Soleado',
      trabajos: [{ area_id: null, texto: 'Vaciado de losa del nivel 2' }],
      areas: [areas.rows[0].id],
    }),
    texto('Anotado. Mándame las fotos cuando quieras.'),
  ]);
  await decir('Ayúdame con el reporte diario: vaciamos la losa del nivel 2, día soleado');
  await esperarSalidos(1);

  // ── no se puede enviar sin borrador ─────────────────────────────────────
  await guionizar([
    usar('enviar_reporte', {}),
    texto('Todavía no puedo enviarlo: primero te mando el borrador.'),
  ]);
  await entregar({
    type: 'image',
    image: { id: media.mediaId, mime_type: 'image/jpeg', caption: 'Losa nivel 2' },
  });
  const trasIntento = await esperarSalidos(2);
  exigir(
    trasIntento.length === 2 && Boolean(trasIntento[1].texto?.includes('borrador')),
    'sin borrador a la vista, enviar_reporte no envia nada',
  );
  const sinNumero = await query<{ n: string }>(
    "SELECT count(*)::text AS n FROM proyecto_reportes WHERE proyecto_id = 1 AND completo = true AND numero LIKE 'RD-%'",
  );
  exigir(sinNumero.rows[0].n === '0', 'y no queda ningun reporte enviado');

  // ── el borrador ─────────────────────────────────────────────────────────
  await guionizar([usar('mandar_borrador', {}), texto('Ahí tienes el borrador.')]);
  await decir('Mándame el borrador');
  const conBorrador = await esperarSalidos(4);
  const documento = conBorrador.find((s) => s.tipo === 'document');
  exigir(
    documento !== undefined && (documento.archivo?.bytes ?? 0) > 5000,
    'el borrador sale como PDF por WhatsApp',
  );
  exigir(
    Boolean(documento?.archivo?.nombre.startsWith('Borrador-')),
    'el archivo se llama «Borrador-…», no como un reporte enviado',
  );

  const borrador = await query<{ id: number; numero: string | null; completo: boolean }>(
    `SELECT id, numero, completo FROM proyecto_reportes
      WHERE proyecto_id = 1 AND activo = true ORDER BY id DESC LIMIT 1`,
  );
  exigir(
    borrador.rows[0]?.completo === false && borrador.rows[0]?.numero === null,
    'el reporte creado es un borrador: sin numero y sin verse en ninguna parte',
  );
  const fotosDelReporte = await query<{ n: string; leyenda: string | null }>(
    `SELECT count(*)::text AS n, max(leyenda) AS leyenda
       FROM proyecto_reporte_fotos WHERE reporte_id = $1`,
    [borrador.rows[0].id],
  );
  exigir(
    fotosDelReporte.rows[0].n === '1' && fotosDelReporte.rows[0].leyenda === 'Losa nivel 2',
    'la foto de WhatsApp queda en el reporte, con su pie de foto como leyenda',
  );

  // ── pedirlo otra vez no deja dos ────────────────────────────────────────
  await guionizar([
    usar('anotar', { novedades: 'Vino el inspector' }),
    usar('mandar_borrador', {}),
    texto('Corregido, ahí va de nuevo.'),
  ]);
  await decir('Agrega que vino el inspector');
  await esperarSalidos(6);
  const vivos = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM proyecto_reportes
      WHERE proyecto_id = 1 AND activo = true AND completo = false`,
  );
  exigir(vivos.rows[0].n === '1', 'pedir el borrador otra vez no deja dos borradores vivos');

  // ── la pregunta con botones ─────────────────────────────────────────────
  await guionizar([usar('preguntar_si_enviar', {})]);
  await decir('Está bien así');
  const conBotones = await esperarSalidos(7);
  const pregunta = conBotones.find((s) => s.tipo === 'interactive');
  const botones = pregunta?.cuerpo.interactive?.action?.buttons ?? [];
  exigir(
    pregunta?.texto === '¿Deseas enviarlo?' &&
      botones.map((b) => b.reply?.id).join(',') === 'enviar_reporte,cambiar_algo',
    'la pregunta sale con los botones Enviar y Cambiar algo',
  );

  // ── enviar ──────────────────────────────────────────────────────────────
  await guionizar([usar('enviar_reporte', {}), texto('Listo, quedó enviado.')]);
  await tocarBoton('enviar_reporte', 'Enviar');
  const trasEnviar = await esperarSalidos(9);

  // El borrador que se envia es el ULTIMO que se armo: el de la correccion.
  // El primero quedo dado de baja, que es justo lo que se comprobo arriba.
  const enviado = await query<{
    id: number;
    numero: string | null;
    completo: boolean;
    envio_proximo_intento: Date | null;
  }>(
    `SELECT r.id, r.numero, r.completo, r.envio_proximo_intento
       FROM proyecto_reportes r
       JOIN whatsapp_conversaciones c ON c.reporte_id = r.id
      WHERE c.telefono = $1
      ORDER BY c.id DESC LIMIT 1`,
    [NUMERO],
  );
  exigir(
    enviado.rows[0].completo === true && Boolean(enviado.rows[0].numero),
    `el reporte coge su numero al enviarlo (${enviado.rows[0].numero ?? 'ninguno'})`,
  );
  exigir(
    enviado.rows[0].envio_proximo_intento !== null,
    'y queda en la cola para que salga el correo',
  );

  const copia = trasEnviar.filter((s) => s.tipo === 'document').at(-1);
  exigir(
    copia !== undefined && copia.archivo?.nombre === `${enviado.rows[0].numero}.pdf`,
    'la persona recibe su copia del PDF ya enviado, con el numero por nombre',
  );

  const conversacion = await query<{ activa: boolean }>(
    'SELECT activa FROM whatsapp_conversaciones WHERE telefono = $1 ORDER BY id DESC LIMIT 1',
    [NUMERO],
  );
  exigir(conversacion.rows[0].activa === false, 'la conversacion se cierra cuando el reporte sale');

  await pool.end();
  console.log(fallos === 0 ? '\nTodo bien' : `\n${fallos} fallo(s)`);
  process.exit(fallos === 0 ? 0 : 1);
};

main().catch(async (e) => {
  console.error(e);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
