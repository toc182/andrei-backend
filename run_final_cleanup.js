const { query } = require('./database/config');
const fs = require('fs');
const path = require('path');

async function runFinalCleanup() {
  try {
    console.log('🧹 Running final duplicate cleanup...');

    const sqlPath = path.join(__dirname, 'database', 'migrations', '010_final_duplicate_cleanup.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');

    await query(sql);

    console.log('✅ Final cleanup completed successfully');

    // Verify the results
    const totalResult = await query("SELECT COUNT(*) as total FROM equipos WHERE activo = true");
    console.log(`📊 Total equipos after cleanup: ${totalResult.rows[0].total}`);

    process.exit(0);
  } catch (error) {
    console.error('❌ Error running cleanup:', error.message);
    process.exit(1);
  }
}

runFinalCleanup();