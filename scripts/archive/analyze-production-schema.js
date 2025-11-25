// Schema analysis script that runs in production environment
const { query } = require('./database/config');

async function analyzeProductionSchema() {
  try {
    console.log('🔍 PRODUCTION DATABASE SCHEMA ANALYSIS');
    console.log('=====================================\n');

    // Get all tables
    const tablesResult = await query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      ORDER BY table_name
    `);

    console.log(`📊 TOTAL TABLES: ${tablesResult.rows.length}`);
    console.log('Tables found:');
    tablesResult.rows.forEach(row => console.log(`  - ${row.table_name}`));
    
    console.log('\n' + '='.repeat(50));
    console.log('DETAILED TABLE STRUCTURES');
    console.log('='.repeat(50) + '\n');

    // Analyze each table structure
    for (const table of tablesResult.rows) {
      const tableName = table.table_name;
      
      // Get columns for this table
      const columnsResult = await query(`
        SELECT 
          column_name, 
          data_type, 
          is_nullable,
          column_default,
          character_maximum_length
        FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = $1
        ORDER BY ordinal_position
      `, [tableName]);

      console.log(`📋 TABLE: ${tableName.toUpperCase()}`);
      console.log(`   Columns (${columnsResult.rows.length}):`);
      
      columnsResult.rows.forEach(col => {
        const nullable = col.is_nullable === 'YES' ? 'NULL' : 'NOT NULL';
        const maxLength = col.character_maximum_length ? `(${col.character_maximum_length})` : '';
        const defaultVal = col.column_default ? ` DEFAULT ${col.column_default}` : '';
        console.log(`     ${col.column_name}: ${col.data_type}${maxLength} ${nullable}${defaultVal}`);
      });

      // Get row count
      try {
        const countResult = await query(`SELECT COUNT(*) as count FROM ${tableName}`);
        console.log(`   📈 Rows: ${countResult.rows[0].count}`);
      } catch (e) {
        console.log(`   📈 Rows: Error - ${e.message}`);
      }
      
      console.log('');
    }

    // Check for missing expected tables
    const expectedTables = [
      'users', 'proyectos', 'clientes', 
      'expense_categories', 'project_expenses', 'project_budgets',
      'tramos_proyecto', 'frentes_trabajo', 'reportes_diarios',
      'materiales', 'metas_proyecto', 'proyecto_usuarios',
      'budget_categories', 'change_orders', 'migrations'
    ];

    console.log('🔍 MISSING TABLE CHECK');
    console.log('='.repeat(30));
    
    const existingTables = tablesResult.rows.map(r => r.table_name);
    const missingTables = expectedTables.filter(table => !existingTables.includes(table));
    
    if (missingTables.length > 0) {
      console.log('❌ Missing tables:');
      missingTables.forEach(table => console.log(`  - ${table}`));
    } else {
      console.log('✅ All expected tables exist');
    }

    // Focus on problematic columns
    console.log('\n🔍 COLUMN-SPECIFIC ISSUES');
    console.log('='.repeat(30));

    // Check clientes.abreviatura
    try {
      const clientesCheck = await query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'clientes' 
        AND column_name = 'abreviatura'
      `);
      
      if (clientesCheck.rows.length > 0) {
        console.log('✅ clientes.abreviatura exists');
      } else {
        console.log('❌ clientes.abreviatura MISSING');
      }
    } catch (e) {
      console.log('❌ Error checking clientes.abreviatura:', e.message);
    }

    // Check proyectos budget fields
    const budgetFields = ['presupuesto_base', 'itbms', 'monto_total'];
    for (const field of budgetFields) {
      try {
        const fieldCheck = await query(`
          SELECT column_name 
          FROM information_schema.columns 
          WHERE table_schema = 'public' AND table_name = 'proyectos' 
          AND column_name = $1
        `, [field]);
        
        if (fieldCheck.rows.length > 0) {
          console.log(`✅ proyectos.${field} exists`);
        } else {
          console.log(`❌ proyectos.${field} MISSING`);
        }
      } catch (e) {
        console.log(`❌ Error checking proyectos.${field}:`, e.message);
      }
    }

    console.log('\n🎉 Schema analysis complete!');

  } catch (error) {
    console.error('💥 ERROR analyzing production schema:', error.message);
    console.error('Stack:', error.stack);
  }
}

// Only run if called directly or if NODE_ENV is production
if (require.main === module || process.env.NODE_ENV === 'production') {
  analyzeProductionSchema().then(() => {
    console.log('Schema analysis finished');
    process.exit(0);
  });
}

module.exports = { analyzeProductionSchema };