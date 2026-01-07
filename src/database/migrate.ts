import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { query } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface MigrationRow {
  filename: string;
}

async function runMigration(migrationFile: string): Promise<void> {
  try {
    console.log(`🚀 Ejecutando migración: ${migrationFile}`);

    const migrationPath = path.join(__dirname, '..', '..', 'database', 'migrations', migrationFile);
    const sqlContent = fs.readFileSync(migrationPath, 'utf8');

    // Execute the SQL as a single statement
    // PostgreSQL can handle multiple statements separated by semicolons
    // This avoids issues with functions that contain semicolons
    if (sqlContent.trim()) {
      await query(sqlContent);
    }

    console.log(`✅ Migración completada: ${migrationFile}`);

  } catch (error) {
    const dbError = error as Error;
    console.error(`❌ Error en migración ${migrationFile}:`, dbError.message);
    throw error;
  }
}

export async function runAllMigrations(): Promise<void> {
  try {
    console.log('🏗️  Iniciando migraciones...');

    // Create migrations tracking table if it doesn't exist
    await query(`
      CREATE TABLE IF NOT EXISTS migrations (
        id SERIAL PRIMARY KEY,
        filename VARCHAR(255) NOT NULL UNIQUE,
        executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    const migrationsDir = path.join(__dirname, '..', '..', 'database', 'migrations');
    const migrationFiles = fs.readdirSync(migrationsDir)
      .filter(file => file.endsWith('.sql'))
      .sort();

    for (const file of migrationFiles) {
      // Check if migration already executed
      const result = await query<MigrationRow>('SELECT filename FROM migrations WHERE filename = $1', [file]);

      if (result.rows.length === 0) {
        await runMigration(file);
        // Mark as executed
        await query('INSERT INTO migrations (filename) VALUES ($1)', [file]);
      } else {
        console.log(`⏭️  Saltando migración ya ejecutada: ${file}`);
      }
    }

    console.log('🎉 Todas las migraciones completadas!');

  } catch (error) {
    console.error('💥 Error ejecutando migraciones:', error);
    process.exit(1);
  }
}

// Run if called directly
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  runAllMigrations().then(() => {
    console.log('✨ Proceso de migración terminado');
    process.exit(0);
  });
}

export { runMigration };
