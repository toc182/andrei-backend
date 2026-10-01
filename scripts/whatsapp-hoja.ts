// La hoja de respuestas del asistente de WhatsApp: preguntas de verdad, con la
// respuesta correcta sacada a mano de las tablas del sistema, hechas al modelo
// de verdad (el mismo que Railway) contra una copia de la base de produccion.
//
// CUESTA DINERO: ~$1 por corrida con Opus. Sin --si-gastar solo dice que haria;
// con el, corre. Se usa cuando cambia como contesta el asistente —sus
// instrucciones, sus herramientas, las vistas que consulta, el modelo— y
// siempre despues de decirle a Ivan cuanto cuesta.
//
//   npx tsx scripts/whatsapp-hoja.ts                   -> que haria
//   npx tsx scripts/whatsapp-hoja.ts --si-gastar       -> las 21 preguntas
//   npx tsx scripts/whatsapp-hoja.ts --si-gastar 4,15  -> solo esas
//
// La copia: pg_dump de produccion EN SOLO LECTURA (DATABASE_PUBLIC_URL del
// Postgres de Railway, leida con el token de ../.railway-token.txt) a la base
// local andrei_copia_hoja, que se migra, se usa y se tira al terminar, pase lo
// que pase. NO se llama andrei_pruebas_*: `npm run pruebas` barre esas al
// arrancar y se llevo la copia a media corrida el 2026-10-01.
//
// Las preguntas (guiones/hoja-respuestas.json) son de septiembre de 2026, un
// periodo cerrado, para que las respuestas no cambien con los reportes que
// lleguen. Si una correccion cambia un reporte de septiembre, se corrige la
// respuesta alla. En `debe`, un numero es una cifra que tiene que aparecer
// (escrita como sea: 1550, 1,550, 18.0) y un texto es una expresion regular.
import 'dotenv/config';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { Client } from 'pg';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'andrei_copia_hoja';
const PG_BIN = process.env.PG_BIN ?? 'C:/Program Files/PostgreSQL/17/bin';
const RAILWAY = {
  proyecto: 'believable-youth',
  entorno: '328c5bc6-fabf-4263-b290-c3fb212cffa6',
  postgres: '9c7a5996-58d7-40be-8c46-885791c35c34',
};
// Opus 5 por millon: $5 entrada, $25 salida, $0.50 lectura de cache. La
// escritura de cache ($6.25) no la cuenta conversar(): el total sale un poco
// por debajo de lo real.
const PRECIO = { entrada: 5, salida: 25, cache: 0.5 };

interface Caso {
  quien: string;
  pregunta: string;
  debe: (number | string)[];
  noDebe?: (number | string)[];
  nota: string;
}

const casos: Caso[] = JSON.parse(
  fs.readFileSync(path.join(RAIZ, 'scripts', 'guiones', 'hoja-respuestas.json'), 'utf8'),
);
const gastar = process.argv.includes('--si-gastar');
const solo = process.argv.slice(2).find((a) => /^\d+(,\d+)*$/.test(a))?.split(',').map(Number) ?? null;
const elegidos = casos.map((c, i) => ({ ...c, n: i + 1 })).filter((c) => !solo || solo.includes(c.n));

if (!gastar) {
  console.log(
    `Harían ${elegidos.length} pregunta(s) al modelo de verdad: ~$${(elegidos.length * 0.06).toFixed(2)} ` +
      '(con la cache, algo más la primera vez).\nPara correrla: --si-gastar, y solo con el OK de Ivan.',
  );
  process.exit(0);
}

/** Una cifra escrita como sea: 1550, 1,550, 1.550, 18.0. */
const cifra = (n: number): RegExp => {
  const miles = String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '[.,]?');
  return new RegExp(`(?<![\\d.,])${miles}(?:[.,]0+)?(?!\\d|[.,]\\d)`);
};
const patron = (x: number | string): RegExp => (typeof x === 'number' ? cifra(x) : new RegExp(x, 'i'));

const admin = (): Client =>
  new Client({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT ?? 5432),
    database: 'postgres',
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  });

async function tirarCopia(): Promise<void> {
  const c = admin();
  await c.connect();
  try {
    await c.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
      [BASE],
    );
    await c.query(`DROP DATABASE IF EXISTS ${BASE}`);
  } finally {
    await c.end();
  }
}

/** La URL de la base de produccion. Nunca se imprime. */
async function urlProduccion(): Promise<string> {
  const token = fs.readFileSync(path.join(RAIZ, '..', '.railway-token.txt'), 'utf8').trim();
  const gql = async (query: string, variables?: Record<string, string>) => {
    const r = await fetch('https://backboard.railway.com/graphql/v2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ query, variables }),
    });
    return (await r.json()) as { data: Record<string, unknown> };
  };
  const p = await gql('{ projects { edges { node { id name } } } }');
  const proyectos = (p.data.projects as { edges: { node: { id: string; name: string } }[] }).edges;
  const id = proyectos.map((e) => e.node).find((n) => n.name === RAILWAY.proyecto)?.id;
  if (!id) throw new Error('no encontré el proyecto de Railway');
  const v = await gql(
    'query($p:String!,$e:String!,$s:String!){ variables(projectId:$p, environmentId:$e, serviceId:$s) }',
    { p: id, e: RAILWAY.entorno, s: RAILWAY.postgres },
  );
  const url = (v.data.variables as Record<string, string>).DATABASE_PUBLIC_URL;
  if (!url) throw new Error('Railway no dio DATABASE_PUBLIC_URL');
  return url;
}

async function hacerCopia(): Promise<void> {
  const archivo = path.join(os.tmpdir(), `${BASE}-${process.pid}.dump`);
  try {
    const dump = spawnSync(
      path.join(PG_BIN, 'pg_dump'),
      ['-Fc', '--no-owner', '--no-acl', '-f', archivo, '--dbname', await urlProduccion()],
      {
        env: { ...process.env, PGOPTIONS: '-c default_transaction_read_only=on', PGSSLMODE: 'require' },
        encoding: 'utf8',
      },
    );
    if (dump.status !== 0) throw new Error(`pg_dump falló: ${dump.stderr}`);
    await tirarCopia();
    const c = admin();
    await c.connect();
    await c.query(`CREATE DATABASE ${BASE}`);
    await c.end();
    const restore = spawnSync(
      path.join(PG_BIN, 'pg_restore'),
      ['--no-owner', '--no-acl', '-h', process.env.DB_HOST ?? 'localhost', '-p', String(process.env.DB_PORT ?? 5432),
        '-U', process.env.DB_USER ?? 'postgres', '-d', BASE, archivo],
      { env: { ...process.env, PGPASSWORD: process.env.DB_PASSWORD }, encoding: 'utf8' },
    );
    if (restore.status !== 0) throw new Error(`pg_restore falló: ${restore.stderr}`);
  } finally {
    fs.rmSync(archivo, { force: true });
  }
  // Las migraciones que produccion todavia no tiene, como las corre el servidor.
  const env: NodeJS.ProcessEnv = { ...process.env, DB_NAME: BASE };
  delete env.DATABASE_URL;
  const m = spawnSync(process.execPath, ['--import', 'tsx', path.join('src', 'database', 'migrate.ts')], {
    cwd: RAIZ,
    env,
    encoding: 'utf8',
  });
  if (m.status !== 0) throw new Error(`las migraciones fallaron:\n${m.stdout}${m.stderr}`);
}

async function main(): Promise<number> {
  console.log('Copiando producción (solo lectura)...');
  await hacerCopia();

  // Desde aqui todo habla con la copia: config.ts lee DB_NAME al importarse.
  process.env.DB_NAME = BASE;
  delete process.env.DATABASE_URL;
  const { query, pool } = await import('../src/database/config.js');
  const { conversar } = await import('../src/services/whatsapp/asistente.js');
  const { conversacionViva } = await import('../src/services/whatsapp/conversacion.js');
  type Usuario = { id: number; nombre: string; rol: 'admin' | 'co-admin' | 'usuario' };

  const uso = { entrada: 0, salida: 0, cache: 0 };
  let bien = 0;
  try {
    for (const c of elegidos) {
      const usuario = (await query<Usuario>('SELECT id, nombre, rol FROM users WHERE nombre = $1', [c.quien])).rows[0];
      if (!usuario) throw new Error(`no hay nadie llamado ${c.quien} en la copia`);
      const conversacion = await conversacionViva(`50700099${String(c.n).padStart(3, '0')}`, usuario.id);
      const historial = [{ id: 1, direccion: 'entrante' as const, texto: c.pregunta, tipo: 'text', r2Key: null }];
      const inicio = Date.now();
      let texto: string;
      try {
        const r = await conversar({ ctx: { usuario, conversacion, fotos: 0 }, historial });
        texto = r.texto;
        uso.entrada += r.uso.entrada;
        uso.salida += r.uso.salida;
        uso.cache += r.uso.cache;
      } catch (e) {
        texto = `ERROR: ${(e as Error).message}`;
      }
      const consultas = (
        await query<{ proposito: string; filas: number | null; error: string | null }>(
          'SELECT proposito, filas, error FROM whatsapp_consultas WHERE conversacion_id = $1 ORDER BY id',
          [conversacion.id],
        )
      ).rows;
      const faltan = c.debe.filter((x) => !patron(x).test(texto));
      const sobran = (c.noDebe ?? []).filter((x) => patron(x).test(texto));
      const ok = faltan.length === 0 && sobran.length === 0;
      if (ok) bien += 1;
      console.log(`\n${ok ? 'BIEN' : 'MAL '} ${c.n}. [${c.quien}] ${c.pregunta} (${Math.round((Date.now() - inicio) / 1000)} s)`);
      console.log(`  esperado: ${c.nota}`);
      console.log(`  contestó: ${texto.replace(/\n+/g, ' / ')}`);
      for (const q of consultas) console.log(`  consulta: ${q.proposito} → ${q.error ?? `${q.filas} filas`}`);
      if (!ok) console.log(`  faltó: ${faltan.join(', ') || '-'} · sobró: ${sobran.join(', ') || '-'}`);
    }
  } finally {
    await pool.end().catch(() => undefined);
  }
  const costo = (uso.entrada * PRECIO.entrada + uso.salida * PRECIO.salida + uso.cache * PRECIO.cache) / 1e6;
  console.log(`\n${bien} de ${elegidos.length} bien · ~$${costo.toFixed(2)} más la escritura de cache`);
  return bien === elegidos.length ? 0 : 1;
}

main()
  .then(async (codigo) => {
    await tirarCopia();
    process.exit(codigo);
  })
  .catch(async (e) => {
    console.error(e instanceof Error ? e.message : e);
    await tirarCopia().catch(() => undefined);
    process.exit(1);
  });
