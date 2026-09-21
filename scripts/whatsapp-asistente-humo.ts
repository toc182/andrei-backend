// Prueba de humo: la conversacion del asistente por WhatsApp.
// npm run pruebas -- whatsapp-asistente
//
// El modelo va guionizado (el Claude de mentira del entorno de pruebas): lo que
// se comprueba aqui NO es que el modelo acierte, sino que la maquinaria que hay
// debajo funciona —que se espera a que la persona termine de escribir, que las
// herramientas se ejecutan de verdad contra la base, que lo anotado queda
// guardado y que la respuesta sale por WhatsApp una sola vez.
//
// Se exige:
// - varios mensajes seguidos se atienden JUNTOS y con una sola respuesta;
// - el asistente elige proyecto y queda en modo reporte diario;
// - lo que anota queda en la conversacion, validado contra las listas del
//   proyecto: un area de otra obra se rechaza y el modelo se entera;
// - la pregunta de las areas sale con todas las del proyecto, numeradas;
// - una maquina que no esta en la lista se agrega, con su rastro, y sus horas
//   se anotan en el mismo turno; una repetida con otra escritura no entra, y
//   una parecida solo entra cuando la persona dijo que es otra;
// - las fotos de la conversacion se cuentan;
// - lo que el modelo no pregunta no se da por preguntado, y lo que marca como
//   preguntado deja de estar pendiente;
// - si el modelo revienta, el mensaje se reintenta y, agotados los intentos, a
//   la persona se le avisa en vez de dejarla esperando.
import { API } from './pruebas/contexto.js';
import { SECRETOS_PRUEBA } from './pruebas/entorno.js';
import crypto from 'crypto';
import sharp from 'sharp';
import { query, pool } from '../src/database/config.js';

const META = process.env.PRUEBAS_META ?? '';
const WEBHOOK = `${API}/whatsapp/webhook`;
const NUMERO = '50761110000';

let fallos = 0;
const exigir = (bien: boolean, que: string): void => {
  console.log(`${bien ? '  ok  ' : 'FALLA '} ${que}`);
  if (!bien) fallos += 1;
};

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

const entregar = async (sobre: unknown): Promise<number> => {
  const crudo = Buffer.from(JSON.stringify(sobre), 'utf8');
  const firma =
    'sha256=' +
    crypto.createHmac('sha256', SECRETOS_PRUEBA.appSecret).update(crudo).digest('hex');
  const res = await fetch(WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': firma },
    body: crudo,
  });
  return res.status;
};

let n = 0;
const sobre = (mensaje: Record<string, unknown>): unknown => ({
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
            messages: [{ id: `wamid.A${(n += 1)}`, from: NUMERO, ...mensaje }],
          },
        },
      ],
    },
  ],
});

const decir = (texto: string) => entregar(sobre({ type: 'text', text: { body: texto } }));

/** Deja preparado lo que «el modelo» va a contestar, en orden. */
const guionizar = async (respuestas: unknown[]): Promise<void> => {
  await fetch(`${META}/_prueba/ia`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(respuestas),
  });
};

const texto = (t: string) => ({ content: [{ type: 'text', text: t }], stop_reason: 'end_turn' });
const usar = (nombre: string, input: unknown, id = `tu_${Math.random().toString(36).slice(2)}`) => ({
  content: [{ type: 'tool_use', id, name: nombre, input }],
  stop_reason: 'tool_use',
});

const enviados = async (): Promise<{ telefono: string; texto: string | null }[]> =>
  (await (await fetch(`${META}/_prueba/enviados`)).json()) as never;

const peticionesIa = async (): Promise<unknown[]> =>
  (await (await fetch(`${META}/_prueba/ia/peticiones`)).json()) as never;

/** Espera a que el trabajador conteste: cuenta los mensajes que salieron. */
async function esperarRespuestas(cuantas: number, segundos = 20): Promise<{ texto: string | null }[]> {
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

  // Un ingeniero con su WhatsApp puesto, y un proyecto con sus listas.
  const usuario = await query<{ id: number }>(
    `UPDATE users SET whatsapp = $1
      WHERE id = (SELECT id FROM users WHERE email = 'aprobador1@pruebas.local')
      RETURNING id`,
    [NUMERO],
  );
  const userId = usuario.rows[0].id;
  // Con permiso de reportes y acceso al proyecto 1, como cualquier ingeniero
  // que reporta: el asistente respeta las mismas reglas que la pantalla.
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
  const areas = await query<{ id: number; nombre: string }>(
    'SELECT id, nombre FROM proyecto_areas WHERE proyecto_id = 1 AND activo = true ORDER BY id',
  );
  const equipos = await query<{ id: number; nombre: string }>(
    'SELECT id, nombre FROM proyecto_equipos WHERE proyecto_id = 1 AND activo = true ORDER BY id',
  );
  const puestos = await query<{ id: number; nombre: string }>(
    'SELECT id, nombre FROM proyecto_puestos WHERE proyecto_id = 1 AND activo = true ORDER BY id',
  );

  // ── primer turno: pide el reporte y el asistente elige la obra ──────────
  await guionizar([
    usar('ver_proyectos', {}),
    usar('elegir_proyecto', { proyecto_id: 1 }),
    texto('Reporte diario de PRUEBAS1, hoy. Cuéntame qué se hizo.'),
  ]);
  await decir('Ayúdame a redactar el reporte diario');

  const primera = await esperarRespuestas(1);
  exigir(
    primera.length === 1 && Boolean(primera[0].texto?.includes('Cuéntame qué se hizo')),
    'el asistente contesta por WhatsApp lo que dijo el modelo',
  );

  const conv = await query<{ id: number; modo: string; proyecto_id: number; user_id: number }>(
    'SELECT id, modo, proyecto_id, user_id FROM whatsapp_conversaciones WHERE telefono = $1 AND activa',
    [NUMERO],
  );
  exigir(
    conv.rows[0]?.modo === 'reporte_diario' &&
      conv.rows[0]?.proyecto_id === 1 &&
      conv.rows[0]?.user_id === userId,
    'la conversacion queda en modo reporte diario, con su proyecto y su dueno',
  );

  // ── segundo turno: tres mensajes seguidos, una sola respuesta ───────────
  await guionizar([
    usar('anotar', {
      clima: 'Lluvia parcial',
      horas_perdidas: 2,
      motivo: 'Lluvia de 2 a 4',
      que_se_hizo: 'Vaciado de la losa del nivel 2',
      areas: [areas.rows[0].id],
      personal: [{ puesto_id: puestos.rows[0].id, cantidad: 3 }],
    }),
    texto('¿Qué equipo trabajó hoy, y cuántas horas?'),
  ]);
  const antes = (await peticionesIa()).length;
  await decir('Hoy vaciamos la losa del nivel 2');
  await decir('Llovió de 2 a 4 y paramos');
  await decir('Éramos 3 en el área 1');

  const segunda = await esperarRespuestas(2);
  exigir(
    segunda.length === 2 && Boolean(segunda[1].texto?.includes('equipo')),
    'tres mensajes seguidos reciben UNA sola respuesta',
  );
  const despues = (await peticionesIa()).length;
  exigir(despues - antes === 2, 'y el modelo se llamo una vez por turno, no una vez por mensaje');

  const datos1 = await query<{ datos: Record<string, unknown> }>(
    'SELECT datos FROM whatsapp_conversaciones WHERE id = $1',
    [conv.rows[0].id],
  );
  const d1 = datos1.rows[0].datos;
  exigir(
    d1.clima === 'Lluvia parcial' &&
      d1.queSeHizo === 'Vaciado de la losa del nivel 2' &&
      Array.isArray(d1.areas) &&
      (d1.areas as number[])[0] === areas.rows[0].id,
    'lo que el modelo anoto queda guardado en la conversacion',
  );

  // ── un area que no es de este proyecto ──────────────────────────────────
  await guionizar([
    usar('anotar', { areas: [999999] }),
    usar('anotar', { equipos: [{ equipo_id: equipos.rows[0].id, unidades: 1, horas: 6 }] }),
    texto('Anotado. ¿Llegó material hoy?'),
  ]);
  await decir('La retro trabajó 6 horas');
  const tercera = await esperarRespuestas(3);
  exigir(
    tercera.length === 3 && Boolean(tercera[2].texto?.includes('material')),
    'un area ajena no rompe la conversacion: el modelo se entera y sigue',
  );
  const datos2 = await query<{ datos: Record<string, unknown> }>(
    'SELECT datos FROM whatsapp_conversaciones WHERE id = $1',
    [conv.rows[0].id],
  );
  const d2 = datos2.rows[0].datos;
  exigir(
    Array.isArray(d2.areas) && (d2.areas as number[])[0] === areas.rows[0].id,
    'y el area ajena no se guarda',
  );
  exigir(
    Array.isArray(d2.equipos) && (d2.equipos as { horas: number }[])[0].horas === 6,
    'el equipo del proyecto si se guarda',
  );

  // ── la pregunta de las areas la arma el sistema, con todas ──────────────
  // Sin nada guionizado detras: la pregunta cierra el turno y el modelo no se
  // vuelve a llamar. Si se llamara, el guion vacio contestaria error.
  await guionizar([usar('preguntar_areas', { pregunta: '¿En qué áreas se trabajó hoy?' })]);
  const antesDeAreas = (await peticionesIa()).length;
  await decir('No sé bien cómo se llama el área');
  const cuarta = await esperarRespuestas(4);
  const listaAreas = cuarta[3]?.texto ?? '';
  exigir(
    cuarta.length === 4 &&
      listaAreas.startsWith('¿En qué áreas se trabajó hoy?') &&
      areas.rows.every((a, i) => listaAreas.includes(`${i + 1}. ${a.nombre}`)),
    'la pregunta de las areas sale con todas las del proyecto, numeradas',
  );
  await esperar(1500);
  exigir(
    (await enviados()).length === 4 && (await peticionesIa()).length - antesDeAreas === 1,
    'y sale sola: la pregunta cierra el turno y el modelo no escribe nada detras',
  );

  // ── una maquina que no esta en la lista se agrega ───────────────────────
  // El guion tiene que saber que numero le tocara: en esta base desechable no
  // escribe nadie mas, asi que es el siguiente de la secuencia.
  const secuencia = await query<{ siguiente: string }>(
    `SELECT (CASE WHEN is_called THEN last_value + 1 ELSE last_value END)::text AS siguiente
       FROM proyecto_equipos_id_seq`,
  );
  const nuevoId = Number(secuencia.rows[0].siguiente);
  await guionizar([
    usar('agregar_equipo', { nombre: 'Minicargador' }),
    usar('anotar', {
      equipos: [
        { equipo_id: equipos.rows[0].id, unidades: 1, horas: 6 },
        { equipo_id: nuevoId, unidades: 1, horas: 5 },
      ],
    }),
    texto('Agregué Minicargador a los equipos de la obra.'),
  ]);
  await decir('También trabajó un minicargador 5 horas');
  const quinta = await esperarRespuestas(5);
  exigir(
    quinta.length === 5 && Boolean(quinta[4].texto?.includes('Agregué Minicargador')),
    'la maquina nueva se agrega sin preguntar y se le dice a la persona',
  );
  const agregada = await query<{ id: number; activo: boolean; creado_por: number }>(
    `SELECT id, activo, creado_por FROM proyecto_equipos
      WHERE proyecto_id = 1 AND nombre = 'Minicargador'`,
  );
  exigir(
    agregada.rows.length === 1 &&
      agregada.rows[0].id === nuevoId &&
      agregada.rows[0].activo &&
      agregada.rows[0].creado_por === userId,
    'queda en la lista del proyecto, a nombre de quien la nombro',
  );
  const rastro = await query(
    `SELECT 1 FROM audit_log
      WHERE entidad = 'proyecto_equipo' AND entidad_id = $1 AND accion = 'crear' AND user_id = $2`,
    [nuevoId, userId],
  );
  exigir(rastro.rows.length === 1, 'y deja su rastro, como cuando se agrega desde el formulario');
  const datosEquipo = await query<{ datos: { equipos?: { equipoId: number; horas: number }[] } }>(
    'SELECT datos FROM whatsapp_conversaciones WHERE id = $1',
    [conv.rows[0].id],
  );
  exigir(
    (datosEquipo.rows[0].datos.equipos ?? []).some((e) => e.equipoId === nuevoId && e.horas === 5),
    'y sus horas se anotan en el mismo turno en que se agrego',
  );

  // ── una que ya esta escrita de otra manera NO se agrega ─────────────────
  const resultadosDeHerramientas = async (): Promise<{ content: string; is_error?: boolean }[]> => {
    const peticiones = (await peticionesIa()) as {
      messages?: { role: string; content: unknown }[];
    }[];
    const ultima = peticiones.at(-1)?.messages?.at(-1);
    return Array.isArray(ultima?.content) ? (ultima.content as never) : [];
  };
  await guionizar([
    usar('agregar_equipo', { nombre: 'Retro excavadora' }),
    texto('Ya está la Retroexcavadora en la lista, la anoto con esa.'),
  ]);
  await decir('La retro excavadora trabajó 8 horas');
  await esperarRespuestas(6);
  const igual = await resultadosDeHerramientas();
  exigir(
    igual[0]?.is_error === true && igual[0].content.includes('Retroexcavadora'),
    'la misma maquina escrita con otro espacio no se agrega: el modelo se entera de cual es',
  );

  // ── una parecida se pregunta, y si la persona dice que es otra, se agrega ─
  await guionizar([
    usar('agregar_equipo', { nombre: 'Mixer 2' }),
    usar('agregar_equipo', { nombre: 'Mixer 2', es_otra: true }),
    texto('Listo.'),
  ]);
  await decir('Es otro mixer, el número 2');
  await esperarRespuestas(7);
  const peticionesMixer = ((await peticionesIa()) as {
    messages?: { role: string; content: unknown }[];
  }[]).slice(-2);
  const primeraRespuesta = peticionesMixer[0]?.messages?.at(-1)?.content as
    | { content: string; is_error?: boolean }[]
    | undefined;
  exigir(
    primeraRespuesta?.[0]?.is_error === true && primeraRespuesta[0].content.includes('Mixer'),
    'una parecida no se agrega a la primera: el modelo tiene que preguntar si es esa',
  );
  const nombres = await query<{ nombre: string }>(
    'SELECT nombre FROM proyecto_equipos WHERE proyecto_id = 1 AND activo ORDER BY id',
  );
  const lista = nombres.rows.map((r) => r.nombre);
  exigir(
    lista.includes('Mixer 2') && !lista.includes('Retro excavadora'),
    'y con es_otra se agrega; la repetida nunca entro',
  );

  // ── una foto ────────────────────────────────────────────────────────────
  const foto = await sharp({
    create: { width: 40, height: 30, channels: 3, background: { r: 10, g: 90, b: 60 } },
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

  await guionizar([
    usar('anotar', { preguntadas: ['entregas', 'novedades'] }),
    texto('Listo. ¿Algo más que quieras mencionar, o te mando el borrador?'),
  ]);
  await entregar(
    sobre({
      type: 'image',
      image: { id: media.mediaId, mime_type: 'image/jpeg', caption: 'Losa nivel 2' },
    }),
  );
  await decir('No llegó nada y sin novedades');

  const octava = await esperarRespuestas(8);
  exigir(
    octava.length === 8 && Boolean(octava[7].texto?.includes('borrador')),
    'la foto y el mensaje que la sigue se atienden juntos',
  );

  const ultima = (await peticionesIa()).at(-1) as { system?: { text: string }[] } | undefined;
  const contexto = (ultima?.system ?? []).map((s) => s.text).join('\n');
  exigir(contexto.includes('Fotos recibidas: 1'), 'el modelo ve que llego una foto');
  const datos3 = await query<{ datos: { preguntadas?: string[] } }>(
    'SELECT datos FROM whatsapp_conversaciones WHERE id = $1',
    [conv.rows[0].id],
  );
  const preguntadas = datos3.rows[0].datos.preguntadas ?? [];
  exigir(
    preguntadas.includes('entregas') && preguntadas.includes('novedades'),
    'lo que el modelo marco como preguntado deja de estar pendiente',
  );

  // ── el modelo revienta ──────────────────────────────────────────────────
  // Sin guion: el Claude de mentira contesta error, que es justo lo que se
  // quiere probar.
  await decir('Mándame el borrador');
  const novena = await esperarRespuestas(9, 25);
  exigir(
    novena.length === 9 && Boolean(novena[8].texto?.includes('complicó')),
    'si el modelo no contesta, a la persona se le avisa en vez de dejarla esperando',
  );
  const intentos = await query<{ intentos: number; procesado_at: Date | null }>(
    `SELECT intentos, procesado_at FROM whatsapp_mensajes
      WHERE direccion = 'entrante' AND telefono = $1 ORDER BY id DESC LIMIT 1`,
    [NUMERO],
  );
  exigir(
    intentos.rows[0].intentos >= 3 && intentos.rows[0].procesado_at !== null,
    'ese mensaje se reintento tres veces y despues se dio por atendido',
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
