// Las consultas que el asistente de WhatsApp le escribe a la base.
//
// Decision de Ivan del 2026-10-01: «si tengo varios dias con conteo de
// calificados, por que no los pudo contar?». Un resumen hecho de antemano solo
// contesta lo que se previo; con esto el asistente escribe su propia consulta y
// la base hace la cuenta, asi que las cifras siguen saliendo de la base y no
// del modelo.
//
// Lo que lo hace seguro no depende de lo que el modelo escriba:
//
//  1. Corre con una cuenta aparte (asistente_lector, migracion 179) que solo
//     puede LEER las vistas del esquema `asistente`. No ve pagos, usuarios ni
//     datos de banco, y no puede escribir nada.
//  2. Cada vista filtra por las obras de asistente.acceso marcadas con el
//     numero de ESTA conexion. Las escribe el sistema, con las reglas de la
//     pantalla (obrasDeReportes), justo antes de la consulta y las borra al
//     terminar. La cuenta del asistente no puede tocar esa tabla.
//  3. Una sola consulta de lectura, con tope de filas y cinco segundos.
//
// La contrasena de la cuenta sale de JWT_SECRET: nada nuevo que configurar en
// Railway. Vale poco aunque se filtrara: sin una fila en asistente.acceso para
// su conexion, las vistas no le devuelven nada.

import crypto from 'crypto';
import { Pool, types } from 'pg';
import { query } from '../../database/config.js';
import type { Usuario } from './herramientas.js';
import { obrasDeReportes } from './reportes.js';

/** Filas que se le devuelven al modelo; si hay mas, se le dice que agrupe. */
export const TOPE_FILAS = 200;
/** Largo maximo de una consulta: una pregunta no necesita mas. */
const LARGO_MAX = 6000;

const CUENTA = 'asistente_lector';

/**
 * La contrasena de la cuenta, siempre la misma para el mismo JWT_SECRET: asi
 * dos servidores a la vez —el viejo y el nuevo durante un despliegue— no se la
 * cambian el uno al otro.
 */
function clave(): string {
  const secreto = process.env.JWT_SECRET;
  if (!secreto) throw new Error('Sin JWT_SECRET no hay cuenta del asistente');
  return crypto.createHmac('sha256', secreto).update(CUENTA).digest('hex');
}

// Fechas como texto (una DATE convertida a Date de JS se corre un dia con la
// zona horaria) y los numeros como numeros: SUM devuelve bigint o numeric, que
// pg entrega como texto.
const crudo = (v: string): string => v;
const numero = (v: string): number | string => {
  const n = Number(v);
  return Number.isFinite(n) && Math.abs(n) <= Number.MAX_SAFE_INTEGER ? n : v;
};
const TIPOS = {
  getTypeParser: (oid: number, formato?: string) => {
    if (oid === 1082 || oid === 1114 || oid === 1184) return crudo; // date, timestamp, timestamptz
    if (oid === 20 || oid === 1700) return numero; // bigint, numeric
    return types.getTypeParser(oid, formato as 'text');
  },
};

let lector: Promise<Pool> | null = null;

/** La conexion del asistente: le pone la contrasena a la cuenta la primera vez. */
function poolLector(): Promise<Pool> {
  lector ??= (async () => {
    const pass = clave();
    // ALTER ROLE no acepta parametros ($1). La contrasena es hexadecimal —sale
    // de un HMAC—, asi que no puede traer comillas; se comprueba igual.
    if (!/^[0-9a-f]{64}$/.test(pass)) throw new Error('Contrasena del asistente con forma inesperada');
    await query(`ALTER ROLE ${CUENTA} WITH LOGIN PASSWORD '${pass}'`);

    const comun = {
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
      max: 3,
      idleTimeoutMillis: 60_000,
      // Lo mismo que la cuenta ya tiene por defecto (migracion 179), repetido
      // aqui por si alguien se lo quitara.
      options: '-c default_transaction_read_only=on -c statement_timeout=5000 -c search_path=asistente',
      types: TIPOS,
    };
    if (process.env.DATABASE_URL) {
      const url = new URL(process.env.DATABASE_URL);
      url.username = CUENTA;
      url.password = pass;
      return new Pool({ ...comun, connectionString: url.toString() });
    }
    return new Pool({
      ...comun,
      host: process.env.DB_HOST,
      port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 5432,
      database: process.env.DB_NAME,
      user: CUENTA,
      password: pass,
    });
  })();
  // Si fallo, que el proximo intento vuelva a probar en vez de heredar el error.
  lector.catch(() => {
    lector = null;
  });
  return lector;
}

/**
 * Cierra la conexion del asistente. Solo para un script que termina y tira su
 * base (la hoja de respuestas): una conexion abierta a una base que se tira
 * revienta el proceso.
 */
export async function cerrarLector(): Promise<void> {
  const p = lector;
  lector = null;
  if (p) await (await p).end();
}

let vistas: Promise<string> | null = null;

/**
 * Las tablas que el asistente puede consultar, con sus columnas y lo que
 * significa cada una. Sale de la base misma —de los COMMENT ON de la migracion
 * 179—, asi que una vista nueva queda descrita para el asistente sin tocar
 * codigo. Se lee una vez por proceso: el texto va en la descripcion de la
 * herramienta, que se cachea con las instrucciones y tiene que ser estable.
 */
export function describirVistas(): Promise<string> {
  vistas ??= (async () => {
    const r = await query<{ vista: string; que: string | null; columna: string; tipo: string; nota: string | null }>(
      `SELECT c.relname AS vista, obj_description(c.oid, 'pg_class') AS que,
              a.attname AS columna, format_type(a.atttypid, a.atttypmod) AS tipo,
              col_description(c.oid, a.attnum) AS nota
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'asistente'
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
        WHERE c.relkind = 'v' AND has_table_privilege($1, c.oid, 'SELECT')
        ORDER BY c.relname NOT IN ('obras', 'reportes'), c.relname, a.attnum`,
      [CUENTA],
    );
    if (r.rows.length === 0) throw new Error('No hay vistas para el asistente (¿falta la migracion 179?)');
    const porVista = new Map<string, typeof r.rows>();
    for (const fila of r.rows) porVista.set(fila.vista, [...(porVista.get(fila.vista) ?? []), fila]);
    const tipo = (t: string): string => t.replace(/\(.*\)/, '').replace('character varying', 'text');
    return [...porVista.entries()]
      .map(([vista, cols]) =>
        [
          `${vista}: ${cols[0].que ?? ''}`,
          `  columnas: ${cols.map((c) => `${c.columna} ${tipo(c.tipo)}`).join(', ')}`,
          ...cols.filter((c) => c.nota).map((c) => `  · ${c.columna}: ${c.nota}`),
        ].join('\n'),
      )
      .join('\n\n');
  })();
  vistas.catch(() => {
    vistas = null;
  });
  return vistas;
}

/**
 * Deja escrita la consulta y lo que salio. No puede tumbar la respuesta: si no
 * se guarda, la persona igual recibe su cifra.
 */
export async function guardarConsulta(args: {
  conversacionId: number | null;
  userId: number;
  proposito: string | null;
  consulta: string;
  resultado: ResultadoConsulta;
}): Promise<void> {
  const r = args.resultado;
  await query(
    `INSERT INTO whatsapp_consultas
       (conversacion_id, user_id, proposito, consulta, filas, resultado, error, milisegundos)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      args.conversacionId,
      args.userId,
      args.proposito,
      args.consulta,
      r.ok ? r.filas.length : null,
      r.ok ? JSON.stringify({ columnas: r.columnas, filas: r.filas, hay_mas: r.hay_mas }) : null,
      r.ok ? null : r.error,
      r.milisegundos,
    ],
  ).catch((e) => console.error('[whatsapp] no se pudo guardar la consulta:', (e as Error).message));
}

export type ResultadoConsulta =
  | { ok: true; columnas: string[]; filas: unknown[][]; hay_mas: boolean; milisegundos: number }
  | { ok: false; error: string; milisegundos: number };

/** Lo que escribio el modelo, listo para ir dentro de otra consulta. */
function limpia(sql: string): string | null {
  const s = sql.trim().replace(/;\s*$/, '').trim();
  if (!s || s.length > LARGO_MAX) return null;
  return s;
}

/**
 * Corre una consulta del asistente con las obras que esta persona puede ver.
 * Si no tiene permiso de reportes, no ve nada.
 */
export async function consultarBase(usuario: Usuario, sql: string): Promise<ResultadoConsulta> {
  const inicio = Date.now();
  const ms = (): number => Date.now() - inicio;

  const consulta = limpia(sql);
  if (!consulta) return { ok: false, error: `La consulta está vacía o pasa de ${LARGO_MAX} caracteres.`, milisegundos: ms() };

  const obras = await obrasDeReportes(usuario);
  if (!obras) return { ok: false, error: 'Esta persona no tiene permiso para ver reportes.', milisegundos: ms() };

  const pool = await poolLector();
  const cliente = await pool.connect();
  let pid: number | null = null;
  let roto = false;
  try {
    pid = (await cliente.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    // Lo que haya quedado de esta misma conexion (un error a medias) se borra
    // antes de escribir lo de esta persona.
    await query('DELETE FROM asistente.acceso WHERE pid = $1', [pid]);
    if (obras.length) {
      await query(
        'INSERT INTO asistente.acceso (pid, proyecto_id) SELECT $1, unnest($2::int[])',
        [pid, obras.map((o) => o.id)],
      );
    }

    // Dentro de otra consulta y con un parametro, que la manda por el protocolo
    // extendido: ese no admite dos ordenes en una, asi que lo que venga detras
    // de un «;» es un error y no otra orden.
    await cliente.query('BEGIN READ ONLY');
    try {
      const r = await cliente.query<unknown[]>({
        text: `SELECT * FROM (\n${consulta}\n) AS consulta LIMIT $1`,
        values: [TOPE_FILAS + 1],
        rowMode: 'array',
      });
      return {
        ok: true,
        columnas: r.fields.map((f) => f.name),
        filas: r.rows.slice(0, TOPE_FILAS),
        hay_mas: r.rows.length > TOPE_FILAS,
        milisegundos: ms(),
      };
    } finally {
      await cliente.query('ROLLBACK');
    }
  } catch (e) {
    // Un error de la base (columna que no existe, se paso de tiempo) trae
    // codigo y la conexion sigue sana; cualquier otro la deja dudosa.
    roto = !(e as { code?: string }).code;
    return { ok: false, error: (e as Error).message, milisegundos: ms() };
  } finally {
    if (pid !== null) await query('DELETE FROM asistente.acceso WHERE pid = $1', [pid]).catch(() => undefined);
    cliente.release(roto);
  }
}
