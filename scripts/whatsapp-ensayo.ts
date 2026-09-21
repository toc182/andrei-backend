// El ensayo: el asistente contra reportes que ya escribieron los ingenieros.
// GASTA DINERO (modelo de verdad), unos centavos por reporte.
//
//   npx tsx --env-file=.env scripts/whatsapp-ensayo.ts casos.json [cuantos]
//
// Que hace: por cada reporte real, monta en una base desechable las listas de
// ESE proyecto —sus areas, sus puestos, sus equipos con los nombres raros que
// tienen de verdad—, le manda al asistente lo que el ingeniero escribio ese dia
// y una frase suelta con la gente y el equipo, y compara lo que el asistente
// anoto con lo que decia el reporte de verdad.
//
// No es una prueba automatica: no dice «pasa» o «falla», imprime el lado a lado
// para que una persona lo lea. La maquinaria se prueba en whatsapp-asistente;
// esto sirve para saber si entiende como habla la obra.
//
// El archivo de casos se saca de produccion en SOLO LECTURA y vive FUERA del
// repositorio: es texto real de gente real.
//
// Un caso con `conversacion` se repite ENTERO en vez de en dos mensajes: a cada
// pregunta del asistente se le contesta lo que contesto el ingeniero a esa
// pregunta ese dia (`respuestas`: la primera regla cuya expresion calce con la
// pregunta). Asi se ve si un arreglo cambia lo que salio mal en una
// conversacion de verdad, aunque el asistente pregunte en otro orden.

import 'dotenv/config';
import fs from 'fs';
import crypto from 'crypto';
import sharp from 'sharp';
import { Client } from 'pg';
import { crearEntorno, SECRETOS_PRUEBA } from './pruebas/entorno.js';

interface Respuesta {
  /** Expresion que tiene que calzar con la pregunta del asistente. */
  si: string;
  /** Lo que se contesta, en orden si se pregunta mas de una vez. */
  responde?: string[];
  foto?: boolean;
  /** Aqui se acaba el ensayo. */
  fin?: boolean;
}

interface Caso {
  numero: string;
  fecha: string;
  proyecto: string;
  clima: string;
  motivo: string | null;
  que_se_hizo: string;
  atrasos: string | null;
  novedades: string | null;
  listas: {
    areas: { id: number; nombre: string }[];
    puestos: { id: number; nombre: string; empresa: string | null }[];
    equipos: { id: number; nombre: string }[];
    categorias: { id: number; nombre: string }[];
  };
  real: {
    areas: { id: number; nombre: string }[];
    personal: { id: number; nombre: string; cantidad: number }[];
    equipos: { id: number; nombre: string; unidades: number; horas: string }[];
    entregas: { descripcion: string; cantidad: string | null; unidad: string | null }[];
  };
  conversacion?: { inicio: string; respuestas: Respuesta[] };
}

/** La pregunta de un mensaje del asistente: desde el ultimo «¿». */
function preguntaDe(texto: string): string {
  const i = texto.lastIndexOf('¿');
  return i >= 0 ? texto.slice(i) : texto;
}

const NUMERO = '50769999999';
const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Como lo diria el ingeniero por WhatsApp, no como quedo en la tabla. */
function fraseDeGenteYEquipo(caso: Caso): string {
  const gente = caso.real.personal
    .filter((p) => p.cantidad > 0)
    .map((p) => `${p.cantidad} ${p.nombre.toLowerCase()}`);
  const maquinas = caso.real.equipos
    .filter((e) => Number(e.horas) > 0)
    .map((e) => `${e.nombre.toLowerCase().replace(/\s*-\s*$/, '')} ${Number(e.horas)} horas`);
  const cosas = caso.real.entregas.map(
    (e) => `${e.descripcion.toLowerCase()}${e.cantidad ? ` ${Number(e.cantidad)} ${e.unidad ?? ''}` : ''}`,
  );
  const partes: string[] = [];
  if (gente.length) partes.push(`Éramos ${gente.join(', ')}`);
  if (maquinas.length) partes.push(`trabajó ${maquinas.join(' y ')}`);
  if (cosas.length) partes.push(`llegó ${cosas.join(' y ')}`);
  return partes.length ? `${partes.join('. ')}.` : 'No hubo más.';
}

const main = async (): Promise<void> => {
  const archivo = process.argv[2];
  if (!archivo || !process.env.ANTHROPIC_API_KEY) {
    console.error('uso: npx tsx --env-file=.env scripts/whatsapp-ensayo.ts casos.json [cuantos]');
    process.exit(1);
  }
  const todos = JSON.parse(fs.readFileSync(archivo, 'utf8')) as Caso[];
  const casos = todos.slice(0, Number(process.argv[3] ?? 3));

  console.log(`Ensayo con ${casos.length} reporte(s) de verdad. Levantando lo desechable…`);
  const entorno = await crearEntorno(undefined, { iaDeVerdad: true });
  const meta = entorno.env.PRUEBAS_META!;
  const base = new Client({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT ?? 5432),
    database: entorno.base,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  });

  try {
    await base.connect();
    const u = await base.query<{ id: number }>(
      `UPDATE users SET whatsapp = $1
        WHERE id = (SELECT id FROM users WHERE email = 'aprobador1@pruebas.local')
        RETURNING id`,
      [NUMERO],
    );
    const userId = u.rows[0].id;
    await base.query(
      `INSERT INTO user_permissions (user_id, reportes) VALUES ($1, true)
       ON CONFLICT (user_id) DO UPDATE SET reportes = true`,
      [userId],
    );
    await base.query(
      'INSERT INTO user_project_access (user_id, proyecto_id) VALUES ($1, 1) ON CONFLICT DO NOTHING',
      [userId],
    );

    let vistos = 0;
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
                  messages: [{ id: `wamid.E${(n += 1)}`, from: NUMERO, ...mensaje }],
                },
              },
            ],
          },
        ],
      };
      const crudo = Buffer.from(JSON.stringify(sobre), 'utf8');
      await fetch(`${entorno.api}/whatsapp/webhook`, {
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
    const mandarFoto = async (): Promise<void> => {
      const foto = await sharp({
        create: { width: 40, height: 30, channels: 3, background: { r: 10, g: 90, b: 60 } },
      })
        .jpeg()
        .toBuffer();
      const media = (await (
        await fetch(`${meta}/_prueba/media`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ base64: foto.toString('base64'), tipoMime: 'image/jpeg' }),
        })
      ).json()) as { mediaId: string };
      await entregar({ type: 'image', image: { id: media.mediaId, mime_type: 'image/jpeg' } });
    };
    /**
     * Todo lo que el asistente mando en un turno. Un turno puede soltar dos
     * mensajes —la lista de las areas sale por su cuenta—, asi que se espera a
     * que lo de la persona quede atendido y se recoge todo lo nuevo.
     */
    const esperarTurno = async (): Promise<string[]> => {
      const hasta = Date.now() + 180_000;
      await esperar(1500);
      for (;;) {
        const pendientes = await base.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM whatsapp_mensajes
            WHERE direccion = 'entrante' AND telefono = $1 AND procesado_at IS NULL`,
          [NUMERO],
        );
        if (pendientes.rows[0].n === 0) break;
        if (Date.now() > hasta) return ['(no contestó)'];
        await esperar(500);
      }
      const r = (await (await fetch(`${meta}/_prueba/enviados`)).json()) as {
        texto: string | null;
      }[];
      const nuevos = r.slice(vistos).map((m) => m.texto ?? '');
      vistos = r.length;
      return nuevos;
    };
    const esperarRespuesta = async (): Promise<string> => {
      const hasta = Date.now() + 180_000;
      for (;;) {
        const r = (await (await fetch(`${meta}/_prueba/enviados`)).json()) as {
          texto: string | null;
        }[];
        if (r.length > vistos) {
          vistos = r.length;
          return r[r.length - 1].texto ?? '';
        }
        if (Date.now() > hasta) return '(no contestó)';
        await esperar(500);
      }
    };

    for (const caso of casos) {
      // Las listas de ESE proyecto, con sus nombres de verdad.
      await base.query('DELETE FROM proyecto_reporte_areas WHERE area_id IN (SELECT id FROM proyecto_areas WHERE proyecto_id = 1)');
      await base.query('UPDATE proyecto_areas SET activo = false WHERE proyecto_id = 1');
      await base.query('UPDATE proyecto_puestos SET activo = false WHERE proyecto_id = 1');
      await base.query('UPDATE proyecto_equipos SET activo = false WHERE proyecto_id = 1');
      await base.query('UPDATE proyecto_entrega_categorias SET activo = false WHERE proyecto_id = 1');
      const mapa = { areas: new Map<number, number>(), puestos: new Map<number, number>(), equipos: new Map<number, number>() };
      for (const [i, a] of caso.listas.areas.entries()) {
        const r = await base.query<{ id: number }>(
          'INSERT INTO proyecto_areas (proyecto_id, nombre, orden) VALUES (1, $1, $2) RETURNING id',
          [a.nombre, i + 1],
        );
        mapa.areas.set(a.id, r.rows[0].id);
      }
      for (const [i, p] of caso.listas.puestos.entries()) {
        const r = await base.query<{ id: number }>(
          'INSERT INTO proyecto_puestos (proyecto_id, nombre, orden, fijo) VALUES (1, $1, $2, false) RETURNING id',
          [p.nombre, i + 1],
        );
        mapa.puestos.set(p.id, r.rows[0].id);
      }
      for (const [i, e] of caso.listas.equipos.entries()) {
        const r = await base.query<{ id: number }>(
          'INSERT INTO proyecto_equipos (proyecto_id, nombre, orden) VALUES (1, $1, $2) RETURNING id',
          [e.nombre, i + 1],
        );
        mapa.equipos.set(e.id, r.rows[0].id);
      }
      for (const [i, c] of caso.listas.categorias.entries()) {
        await base.query(
          'INSERT INTO proyecto_entrega_categorias (proyecto_id, nombre, orden) VALUES (1, $1, $2)',
          [c.nombre, i + 1],
        );
      }
      // Conversacion nueva para cada reporte.
      await base.query('UPDATE whatsapp_conversaciones SET activa = false WHERE telefono = $1', [NUMERO]);

      console.log(`\n══════ ${caso.numero} · ${caso.proyecto.slice(0, 60)} ══════`);
      if (caso.conversacion) {
        // La conversacion entera, contestando cada pregunta como la contesto el
        // ingeniero ese dia.
        const veces = new Map<Respuesta, number>();
        console.log(`TU: ${caso.conversacion.inicio}`);
        await decir(caso.conversacion.inicio);
        for (let turno = 0; turno < 30; turno += 1) {
          const dijo = await esperarTurno();
          for (const m of dijo) console.log(`\nEL: ${m}`);
          const pregunta = preguntaDe(dijo.at(-1) ?? '');
          const regla = caso.conversacion.respuestas.find((r) =>
            new RegExp(r.si, 'i').test(pregunta),
          );
          if (!regla) {
            console.log('\n(el ensayo no sabe que contestar a eso: se acaba aqui)');
            break;
          }
          if (regla.fin) break;
          if (regla.foto) {
            console.log('\nTU: [foto]');
            await mandarFoto();
            continue;
          }
          const usadas = veces.get(regla) ?? 0;
          veces.set(regla, usadas + 1);
          const opciones = regla.responde ?? [];
          const respuesta = opciones[Math.min(usadas, opciones.length - 1)] ?? '';
          console.log(`\nTU: ${respuesta}`);
          await decir(respuesta);
        }
      } else {
        const contado = [caso.que_se_hizo, caso.atrasos, caso.novedades]
          .filter((x) => x && x.trim())
          .join('\n');
        console.log(`TU (lo que escribio ese dia):\n${contado.slice(0, 400)}`);
        await decir(`Ayúdame con el reporte diario.\n${contado}`);
        console.log(`\nEL: ${await esperarRespuesta()}`);

        const frase = fraseDeGenteYEquipo(caso);
        console.log(`\nTU: ${frase}`);
        await decir(frase);
        console.log(`\nEL: ${await esperarRespuesta()}`);
      }

      const datos = (
        await base.query<{ datos: Record<string, unknown> }>(
          'SELECT datos FROM whatsapp_conversaciones WHERE telefono = $1 AND activa',
          [NUMERO],
        )
      ).rows[0]?.datos;

      const nombreDe = async (tabla: string, id: number): Promise<string> =>
        (await base.query<{ nombre: string }>(`SELECT nombre FROM ${tabla} WHERE id = $1`, [id]))
          .rows[0]?.nombre ?? `#${id}`;

      console.log('\n── lo que anoto vs lo que decia el reporte ──');
      const personalAnotado = (datos?.personal ?? []) as { puestoId: number; cantidad: number }[];
      const equiposAnotados = (datos?.equipos ?? []) as { equipoId: number; horas: number }[];
      const areasAnotadas = (datos?.areas ?? []) as number[];
      console.log(
        'personal:',
        (
          await Promise.all(
            personalAnotado.map(async (p) => `${p.cantidad} ${await nombreDe('proyecto_puestos', p.puestoId)}`),
          )
        ).join(', ') || '(nada)',
        '   ||   real:',
        caso.real.personal.map((p) => `${p.cantidad} ${p.nombre}`).join(', ') || '(nada)',
      );
      console.log(
        'equipo:  ',
        (
          await Promise.all(
            equiposAnotados.map(async (e) => `${await nombreDe('proyecto_equipos', e.equipoId)} ${e.horas}h`),
          )
        ).join(', ') || '(nada)',
        '   ||   real:',
        caso.real.equipos.map((e) => `${e.nombre} ${Number(e.horas)}h`).join(', ') || '(nada)',
      );
      console.log(
        'areas:   ',
        (await Promise.all(areasAnotadas.map((id) => nombreDe('proyecto_areas', id)))).join(', ') ||
          '(nada)',
        '   ||   real:',
        caso.real.areas.map((a) => a.nombre).join(', ') || '(nada)',
      );
      const entregasAnotadas = (datos?.entregas ?? []) as {
        descripcion: string;
        cantidad: number | null;
        unidad: string | null;
      }[];
      console.log(
        'entregas:',
        entregasAnotadas
          .map((e) => `${e.descripcion}${e.cantidad ? ` ${e.cantidad} ${e.unidad ?? ''}` : ''}`)
          .join(', ') || '(nada)',
        '   ||   real:',
        caso.real.entregas.map((e) => e.descripcion).join(', ') || '(nada)',
      );
      console.log('clima:   ', datos?.clima ?? '(nada)', '   ||   real:', caso.clima);
      console.log(
        'perdidas:',
        datos?.horasPerdidas ?? '(nada)',
        'h ·',
        String(datos?.motivo ?? '(sin motivo)'),
        '   ||   real:',
        caso.motivo ?? '(nada)',
      );
      console.log('atrasos: ', String(datos?.atrasos ?? '(nada)'), '   ||   real:', caso.atrasos ?? '(nada)');
      const listaEquipos = await base.query<{ nombre: string }>(
        'SELECT nombre FROM proyecto_equipos WHERE proyecto_id = 1 AND activo ORDER BY id',
      );
      console.log(
        'equipos de la obra al terminar:',
        listaEquipos.rows.map((r) => r.nombre).join(', ') || '(ninguno)',
      );
      console.log(`trabajo:\n${String(datos?.queSeHizo ?? '(nada)')}`);
    }

    const gasto = entorno
      .registro()
      .split('\n')
      .filter((l) => l.includes('mensaje(s) atendidos'));
    if (gasto.length) {
      console.log('\n──────── lo que gastó ────────');
      for (const l of gasto) console.log(l.trim());
    }
  } finally {
    await base.end().catch(() => undefined);
    await entorno.cerrar();
  }
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
