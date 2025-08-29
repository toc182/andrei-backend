// Verify schema parity between local and production
const { query } = require('./database/config');

async function checkLocalSchema() {
  try {
    console.log('=== LOCAL DATABASE SCHEMA ===');
    
    const tables = await query(`
      SELECT table_name FROM information_schema.tables 
      WHERE table_schema = 'public' ORDER BY table_name
    `);
    
    console.log(`📊 Total tables: ${tables.rows.length}`);
    console.log('Tables:', tables.rows.map(r => r.table_name));
    
    // Check clientes columns specifically
    const clientesColumns = await query(`
      SELECT column_name FROM information_schema.columns 
      WHERE table_schema = 'public' AND table_name = 'clientes'
      ORDER BY ordinal_position
    `);
    
    console.log('📋 Clientes columns:', clientesColumns.rows.map(r => r.column_name));
    
    // Check proyectos columns
    const proyectosColumns = await query(`
      SELECT column_name FROM information_schema.columns 
      WHERE table_schema = 'public' AND table_name = 'proyectos'  
      ORDER BY ordinal_position
    `);
    
    console.log('📋 Proyectos columns:', proyectosColumns.rows.map(r => r.column_name));
    
  } catch (error) {
    console.error('❌ Local schema check failed:', error.message);
  }
}

if (require.main === module) {
  checkLocalSchema().then(() => process.exit(0));
}

module.exports = { checkLocalSchema };