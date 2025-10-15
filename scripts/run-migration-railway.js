const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

async function runMigration() {
    // Usar la DATABASE_URL de Railway desde las variables de entorno
    const databaseUrl = process.env.DATABASE_URL || process.env.RAILWAY_DATABASE_URL;

    if (!databaseUrl) {
        console.error('❌ DATABASE_URL no encontrada. Por favor proporciona la URL de Railway.');
        console.log('\nUsa: DATABASE_URL="postgresql://..." node scripts/run-migration-railway.js');
        process.exit(1);
    }

    const client = new Client({
        connectionString: databaseUrl,
        ssl: {
            rejectUnauthorized: false
        }
    });

    try {
        console.log('🔄 Conectando a Railway...');
        await client.connect();

        const migrationPath = path.join(__dirname, '../database/migrations/020_drop_unused_tables.sql');
        const sql = fs.readFileSync(migrationPath, 'utf8');

        console.log('🔄 Ejecutando migración 020_drop_unused_tables.sql en Railway...');

        await client.query(sql);

        console.log('✅ Migración completada exitosamente en Railway');

    } catch (error) {
        console.error('❌ Error ejecutando migración:', error.message);
        process.exit(1);
    } finally {
        await client.end();
        process.exit(0);
    }
}

runMigration();
