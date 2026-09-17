// El asistente de WhatsApp CON CLAUDE DE VERDAD. Gasta dinero: unos centavos.
//
//   npx tsx --env-file=.env scripts/whatsapp-real.ts
//   npx tsx --env-file=.env scripts/whatsapp-real.ts guion2.json
//
// Para que sirve: ver si el modelo entiende como escribe un ingeniero de obra,
// y cuanto cuesta un reporte. Lo automatico (que las herramientas hagan lo que
// dicen, que no se conteste dos veces, que un area ajena no entre) ya lo
// comprueba `npm run pruebas -- whatsapp-asistente`, y eso no gasta nada.
//
// NADA de esto toca la copia local ni manda un solo mensaje de verdad: levanta
// su propia base desechable, su propio servidor y su propio «Meta», igual que
// las pruebas automaticas. Lo unico real es el modelo.

import 'dotenv/config';
import fs from 'fs';
import crypto from 'crypto';
import { Client } from 'pg';
import { crearEntorno, SECRETOS_PRUEBA } from './pruebas/entorno.js';

/** Lo que el ingeniero va diciendo, un mensaje por linea. */
const GUION_POR_DEFECTO = [
  'Ayúdame a redactar el reporte diario',
  'Hoy vaciamos la losa del nivel 2 en la torre A, 18 m3. Éramos 3 albañiles y 12 ayudantes. ' +
    'Llovió de 2 a 4 y paramos. Llegaron 40 sacos de cemento.',
  'La retro 6 horas y la mezcladora 4',
  'Vino el inspector a revisar el acero antes del vaciado',
  'No, nada más',
];

const NUMERO = '50760000000';
const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Falta ANTHROPIC_API_KEY: esta prueba habla con el modelo de verdad.');
    process.exit(1);
  }
  const guion: string[] = process.argv[2]
    ? (JSON.parse(fs.readFileSync(process.argv[2], 'utf8')) as string[])
    : GUION_POR_DEFECTO;

  console.log('Levantando base, servidor y «Meta» de mentira…');
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

    let n = 0;
    const decir = async (texto: string): Promise<void> => {
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
                  messages: [
                    { id: `wamid.R${(n += 1)}`, from: NUMERO, type: 'text', text: { body: texto } },
                  ],
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

    const leerRespuestas = async (): Promise<{ texto: string | null }[]> =>
      (await (await fetch(`${meta}/_prueba/enviados`)).json()) as never;

    let vistas = 0;
    for (const linea of guion) {
      console.log(`\nTU: ${linea}`);
      await decir(linea);
      const hasta = Date.now() + 120_000;
      for (;;) {
        const r = await leerRespuestas();
        if (r.length > vistas) {
          for (const nueva of r.slice(vistas)) console.log(`\nEL: ${nueva.texto}`);
          vistas = r.length;
          break;
        }
        if (Date.now() > hasta) {
          console.log('\n(el asistente no contestó en dos minutos)');
          break;
        }
        await esperar(500);
      }
    }

    const datos = await base.query<{ datos: unknown; modo: string; proyecto_id: number }>(
      'SELECT datos, modo, proyecto_id FROM whatsapp_conversaciones WHERE telefono = $1',
      [NUMERO],
    );
    console.log('\n──────── lo que quedó anotado ────────');
    console.log(JSON.stringify(datos.rows[0]?.datos, null, 2));

    // Lo que costó: el servidor lo dice en su registro, turno por turno.
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
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
