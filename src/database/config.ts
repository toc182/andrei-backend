import { Pool, QueryResultRow } from 'pg';
import dotenv from 'dotenv';
import type { DatabaseQueryResult } from '../types/database.js';

dotenv.config();

// Configuración para Railway (usa DATABASE_URL) o local (variables separadas)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.NODE_ENV === 'production'
      ? { rejectUnauthorized: false }
      : false,
});

// Si no hay DATABASE_URL, usar variables separadas (desarrollo local)
if (!process.env.DATABASE_URL) {
  pool.options.user = process.env.DB_USER;
  pool.options.host = process.env.DB_HOST;
  pool.options.database = process.env.DB_NAME;
  pool.options.password = process.env.DB_PASSWORD;
  pool.options.port = process.env.DB_PORT
    ? parseInt(process.env.DB_PORT, 10)
    : 5432;
}

/**
 * Ejecuta una consulta SQL con parámetros tipados
 */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<DatabaseQueryResult<T>> {
  try {
    const result = await pool.query<T>(text, params);
    return result as DatabaseQueryResult<T>;
  } catch (error) {
    console.error('Error en consulta de base de datos:', error);
    throw error;
  }
}

/**
 * Verifica la conexión a la base de datos
 */
export async function testConnection(): Promise<void> {
  try {
    console.log('🔍 Database connection details:');
    console.log('   - Using DATABASE_URL:', !!process.env.DATABASE_URL);
    if (!process.env.DATABASE_URL) {
      console.log('   - DB_HOST:', process.env.DB_HOST);
      console.log('   - DB_NAME:', process.env.DB_NAME);
      console.log('   - DB_USER:', process.env.DB_USER);
      console.log('   - DB_PORT:', process.env.DB_PORT);
    }

    interface ConnectionResult {
      current_time: Date;
      pg_version: string;
    }

    const result = await pool.query<ConnectionResult>(
      'SELECT NOW() as current_time, version() as pg_version',
    );
    console.log('✅ Database connection successful');
    console.log('📅 Current time:', result.rows[0].current_time);
    console.log(
      '🔢 PostgreSQL version:',
      result.rows[0].pg_version.split(' ')[0],
    );
  } catch (error) {
    const dbError = error as {
      code?: string;
      message?: string;
      detail?: string;
    };
    console.error('💥 Database connection failed');
    console.error('❌ Error code:', dbError.code);
    console.error('❌ Error message:', dbError.message);
    console.error('❌ Error detail:', dbError.detail);
    console.error('🔍 Connection config debug:');
    console.error('   - DATABASE_URL exists:', !!process.env.DATABASE_URL);
    console.error('   - Pool config:', {
      host: pool.options.host,
      database: pool.options.database,
      user: pool.options.user,
      port: pool.options.port,
    });
    throw error;
  }
}

export { pool };
