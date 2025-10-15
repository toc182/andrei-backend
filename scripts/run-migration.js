const fs = require('fs');
const path = require('path');
const { query } = require('../database/config');

async function runMigration() {
    try {
        const migrationPath = path.join(__dirname, '../database/migrations/020_drop_unused_tables.sql');
        const sql = fs.readFileSync(migrationPath, 'utf8');

        console.log('🔄 Ejecutando migración 020_drop_unused_tables.sql...');

        await query(sql);

        console.log('✅ Migración completada exitosamente');
        process.exit(0);
    } catch (error) {
        console.error('❌ Error ejecutando migración:', error);
        process.exit(1);
    }
}

runMigration();
