const { query } = require('./database/config');
const fs = require('fs');
const path = require('path');

async function runRestore() {
  try {
    console.log('🔄 Restoring legitimate equipos...');

    const sqlPath = path.join(__dirname, 'database', 'migrations', '011_restore_legitimate_equipos.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');

    await query(sql);

    console.log('✅ Restore completed successfully');

    // Verify the results
    const totalResult = await query("SELECT COUNT(*) as total FROM equipos WHERE activo = true");
    console.log(`📊 Total equipos after restore: ${totalResult.rows[0].total}`);

    process.exit(0);
  } catch (error) {
    console.error('❌ Error running restore:', error.message);
    process.exit(1);
  }
}

runRestore();