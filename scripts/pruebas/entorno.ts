/**
 * La base de datos desechable de las pruebas.
 *
 * Hasta el 2026-09-15 las pruebas de humo corrían contra la base local, la
 * misma que Ivan mira: creaban reportes, empresas y puestos de mentira y los
 * borraban al final a mano. Una prueba que reventaba a mitad dejaba esa basura
 * mezclada con sus datos, y dos pruebas se olvidaron de borrar el historial.
 *
 * Aquí se crea una base NUEVA por corrida, desde las mismas migraciones que
 * construyen la de verdad, con solo los datos que las pruebas necesitan
 * (semilla.sql), y se arranca un servidor propio contra ella en un puerto
 * libre. Al terminar se tira entera. No hay limpieza que escribir ni que
 * olvidar: lo que la prueba cree, se va con la base.
 *
 * Los puertos de siempre no se tocan: el servidor de verdad sigue en el 5000 y
 * las pantallas en el 5173. El de las pruebas pide al sistema uno libre.
 */

import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { DeleteObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { Client } from 'pg';
import net from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.join(AQUI, '..', '..');

/** Toda base de pruebas empieza así. La guardia de las pruebas lo exige. */
export const PREFIJO_BASE = 'andrei_pruebas_';

/** El único cubo de R2 donde las pruebas pueden escribir y borrar. */
const CUBO_PRUEBAS = 'andrei-pruebas';

/**
 * Los nombres cortos de los proyectos de semilla.sql. Las fotos y los PDF de un
 * reporte se guardan bajo el nombre corto de su proyecto, así que esto es
 * también el prefijo de todo lo que las pruebas dejan en R2.
 */
const PROYECTOS_SEMILLA = ['PRUEBAS1', 'PRUEBAS2', 'PRUEBAS3'];

export interface Entorno {
  /** Nombre de la base desechable de esta corrida. */
  base: string;
  /** Raíz de la API del servidor de pruebas, p. ej. http://127.0.0.1:53124/api */
  api: string;
  /** Lo que hay que ponerle de entorno a cada prueba. */
  env: NodeJS.ProcessEnv;
  /** Lo que el servidor de pruebas ha escrito, por si algo falla. */
  registro: () => string;
  cerrar: () => Promise<void>;
}

const conexionAdmin = () =>
  new Client({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT ?? 5432),
    database: 'postgres',
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  });

/** Un puerto que el sistema operativo dice que está libre ahora mismo. */
const puertoLibre = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * El entorno de las pruebas no hereda lo que pueda hacer daño:
 * - DATABASE_URL apuntaría a producción y se impondría sobre DB_NAME;
 * - RESEND_API_KEY mandaría correos de verdad desde una prueba.
 */
function entornoHijo(base: string, puerto: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, DB_NAME: base, PORT: String(puerto) };
  delete env.DATABASE_URL;
  delete env.RESEND_API_KEY;
  return env;
}

async function crearBase(base: string, plantilla?: string): Promise<void> {
  const admin = conexionAdmin();
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${base}`);
    // Copiar la plantilla cuesta un instante; migrar y sembrar desde cero
    // cuesta un par de segundos por prueba. Nueve pruebas lo notan.
    await admin.query(
      plantilla ? `CREATE DATABASE ${base} TEMPLATE ${plantilla}` : `CREATE DATABASE ${base}`,
    );
  } finally {
    await admin.end();
  }
}

export async function tirarBase(base: string): Promise<void> {
  // Nunca una base que no sea de pruebas, pase lo que pase más arriba.
  if (!base.startsWith(PREFIJO_BASE)) {
    throw new Error(`me niego a tirar la base «${base}»: no es de pruebas`);
  }
  const admin = conexionAdmin();
  await admin.connect();
  try {
    // El servidor de pruebas puede tardar un instante en soltar sus conexiones;
    // con una sola abierta, DROP DATABASE falla.
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [base],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${base}`);
  } finally {
    await admin.end();
  }
}

/** Las migraciones de verdad, las mismas que corre el servidor al arrancar. */
function migrar(env: NodeJS.ProcessEnv): void {
  const r = spawnSync(
    process.execPath,
    ['--import', 'tsx', path.join('src', 'database', 'migrate.ts')],
    { cwd: RAIZ, env, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 },
  );
  if (r.status !== 0) {
    throw new Error(`las migraciones fallaron:\n${r.stdout ?? ''}${r.stderr ?? ''}`);
  }
}

async function sembrar(base: string): Promise<void> {
  const sql = fs.readFileSync(path.join(AQUI, 'semilla.sql'), 'utf8');
  const c = new Client({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT ?? 5432),
    database: base,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  });
  await c.connect();
  try {
    await c.query(sql);
  } finally {
    await c.end();
  }
}

async function arrancarServidor(
  env: NodeJS.ProcessEnv,
  puerto: number,
): Promise<{ proceso: ChildProcess; registro: () => string }> {
  const trozos: string[] = [];
  // Sin `shell`: así el proceso que se lanza es el mismo que se mata. Con shell
  // de por medio, en Windows queda un servidor huérfano agarrado a la base y el
  // DROP DATABASE del final no puede con ella.
  const proceso = spawn(process.execPath, ['--import', 'tsx', path.join('src', 'server.ts')], {
    cwd: RAIZ,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (proceso.pid) anotarServidor(proceso.pid);
  proceso.stdout?.on('data', (d: Buffer) => trozos.push(d.toString()));
  proceso.stderr?.on('data', (d: Buffer) => trozos.push(d.toString()));
  const registro = () => trozos.join('');

  const hasta = Date.now() + 90_000;
  for (;;) {
    if (proceso.exitCode !== null) {
      throw new Error(`el servidor de pruebas se cayó al arrancar:\n${registro()}`);
    }
    try {
      const r = await fetch(`http://127.0.0.1:${puerto}/api/health`);
      if (r.ok) break;
    } catch {
      // todavía no escucha
    }
    if (Date.now() > hasta) {
      proceso.kill();
      throw new Error(`el servidor de pruebas no respondió en 90 s:\n${registro()}`);
    }
    await esperar(250);
  }
  return { proceso, registro };
}

/**
 * La base modelo de la corrida: migrada y sembrada una sola vez. Cada prueba
 * saca de ella una copia suya, así que ninguna ve lo que otra dejó y el orden
 * en que corren da igual.
 */
export async function crearPlantilla(): Promise<string> {
  const plantilla = `${PREFIJO_BASE}plantilla_${process.pid}`;
  await crearBase(plantilla);
  try {
    migrar(entornoHijo(plantilla, 0));
    await sembrar(plantilla);
  } catch (e) {
    await tirarBase(plantilla).catch(() => undefined);
    throw e;
  }
  return plantilla;
}

/**
 * El cuaderno de los servidores de pruebas vivos.
 *
 * Si a esta corrida la matan en seco —Ctrl-C que no llega, la ventana que se
 * cierra—, el servidor que había arrancado se queda huérfano, con su puerto y
 * su conexión a la base. Anotar el pid es lo que permite que la corrida
 * siguiente lo remate. Sin esto, «no deja nada detrás» sería mentira en cuanto
 * algo se corta a mitad.
 */
const CUADERNO = path.join(os.tmpdir(), 'andrei-servidores-de-pruebas.json');

function leerCuaderno(): number[] {
  try {
    const x: unknown = JSON.parse(fs.readFileSync(CUADERNO, 'utf8'));
    return Array.isArray(x) ? x.filter((n): n is number => typeof n === 'number') : [];
  } catch {
    return [];
  }
}

function escribirCuaderno(pids: number[]): void {
  try {
    fs.writeFileSync(CUADERNO, JSON.stringify(pids));
  } catch {
    // El cuaderno es una red de seguridad, no un requisito: si el disco no
    // deja escribirlo, la corrida sigue igual.
  }
}

const anotarServidor = (pid: number) => escribirCuaderno([...new Set([...leerCuaderno(), pid])]);
const olvidarServidor = (pid: number) => escribirCuaderno(leerCuaderno().filter((p) => p !== pid));

/**
 * Las fotos y los PDF que las pruebas subieron a R2.
 *
 * La base se tira entera y con ella desaparecen las filas, pero los archivos
 * viven fuera: hay que ir a buscarlos. Van todos bajo el nombre corto de los
 * proyectos de la semilla, así que se barren por prefijo y no hay lista que
 * mantener.
 */
export async function limpiarAlmacen(): Promise<number> {
  const cubo = process.env.R2_BUCKET_NAME;
  // Si esto apuntara al cubo de verdad, borrar por prefijo sería catastrófico.
  if (cubo !== CUBO_PRUEBAS) {
    throw new Error(
      `las pruebas solo pueden tocar el cubo «${CUBO_PRUEBAS}», y R2_BUCKET_NAME dice «${cubo ?? '(ninguno)'}»`,
    );
  }
  const s3 = new S3Client({
    region: 'auto',
    endpoint:
      process.env.R2_ENDPOINT ?? `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID ?? '',
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? '',
    },
  });
  let borrados = 0;
  for (const prefijo of PROYECTOS_SEMILLA) {
    let token: string | undefined;
    do {
      const r = await s3.send(
        new ListObjectsV2Command({ Bucket: cubo, Prefix: `${prefijo}/`, ContinuationToken: token }),
      );
      for (const o of r.Contents ?? []) {
        if (!o.Key) continue;
        await s3.send(new DeleteObjectCommand({ Bucket: cubo, Key: o.Key }));
        borrados += 1;
      }
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
  }
  return borrados;
}

/** Lo que quedó suelto de corridas anteriores: servidores huérfanos y bases. */
export async function barrer(): Promise<{ servidores: number[]; bases: string[] }> {
  const servidores: number[] = [];
  for (const pid of leerCuaderno()) {
    try {
      process.kill(pid); // si ya no existe, lanza y no se cuenta
      servidores.push(pid);
    } catch {
      // ya no estaba
    }
  }
  escribirCuaderno([]);

  const admin = conexionAdmin();
  await admin.connect();
  let bases: string[] = [];
  try {
    const r = await admin.query<{ datname: string }>(
      `SELECT datname FROM pg_database WHERE datname LIKE $1`,
      [`${PREFIJO_BASE}%`],
    );
    bases = r.rows.map((x) => x.datname);
  } finally {
    await admin.end();
  }
  for (const b of bases) await tirarBase(b);
  return { servidores, bases };
}

/**
 * Deja listo: base nueva + migraciones + semilla + servidor propio.
 * Si algo revienta a medio montar, deshace lo que llevaba hecho.
 */
export async function crearEntorno(plantilla?: string): Promise<Entorno> {
  const base = `${PREFIJO_BASE}${process.pid}_${Date.now()}`;
  const puerto = await puertoLibre();
  const env = entornoHijo(base, puerto);

  await crearBase(base, plantilla);
  let servidor: { proceso: ChildProcess; registro: () => string } | null = null;
  try {
    if (!plantilla) {
      migrar(env);
      await sembrar(base);
    }
    servidor = await arrancarServidor(env, puerto);
  } catch (e) {
    servidor?.proceso.kill();
    await tirarBase(base).catch(() => undefined);
    throw e;
  }

  const api = `http://127.0.0.1:${puerto}/api`;
  return {
    base,
    api,
    env: { ...env, PRUEBAS_API: api },
    registro: servidor.registro,
    cerrar: async () => {
      servidor.proceso.kill();
      if (servidor.proceso.pid) olvidarServidor(servidor.proceso.pid);
      // Esperar a que suelte la base; si no, el DROP se queda esperando.
      for (let i = 0; i < 40 && servidor.proceso.exitCode === null; i += 1) await esperar(100);
      await tirarBase(base);
    },
  };
}
