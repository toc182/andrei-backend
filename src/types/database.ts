import { QueryResult, QueryResultRow } from 'pg';

/**
 * Resultado de una query a la base de datos
 */
export interface DatabaseQueryResult<
  T extends QueryResultRow = QueryResultRow,
> {
  rows: T[];
  rowCount: number | null;
  command: string;
  oid: number;
  fields: QueryResult['fields'];
}

/**
 * Función para ejecutar queries con tipos genéricos
 */
export type QueryFunction = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
) => Promise<DatabaseQueryResult<T>>;

/**
 * Configuración de conexión a PostgreSQL
 */
export interface DatabaseConfig {
  connectionString?: string;
  ssl?: boolean | { rejectUnauthorized: boolean };
  user?: string;
  host?: string;
  database?: string;
  password?: string;
  port?: number;
}
