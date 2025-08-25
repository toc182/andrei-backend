const fs = require('fs');
const path = require('path');
const { query } = require('./config');

async function runMigration(migrationFile) {
  try {
    console.log(`🚀 Ejecutando migración: ${migrationFile}`);
    
    const migrationPath = path.join(__dirname, 'migrations', migrationFile);
    const sqlContent = fs.readFileSync(migrationPath, 'utf8');
    
    // Execute the SQL
    await query(sqlContent);
    
    console.log(`✅ Migración completada: ${migrationFile}`);
    
  } catch (error) {
    console.error(`❌ Error en migración ${migrationFile}:`, error.message);
    throw error;
  }
}

async function runAllMigrations() {
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
    
    const migrationsDir = path.join(__dirname, 'migrations');
    const migrationFiles = fs.readdirSync(migrationsDir)
      .filter(file => file.endsWith('.sql'))
      .sort();
    
    for (const file of migrationFiles) {
      // Check if migration already executed
      const result = await query('SELECT filename FROM migrations WHERE filename = $1', [file]);
      
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
if (require.main === module) {
  runAllMigrations().then(() => {
    console.log('✨ Proceso de migración terminado');
    process.exit(0);
  });
}

module.exports = {
  runMigration,
  runAllMigrations
};