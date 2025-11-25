// Script to analyze production database schema
const { Pool } = require('pg');

// Production database connection
const productionPool = new Pool({
  connectionString: 'postgresql://postgres:BbKlHMwAHbprvXHWaMnhNgdyBxySDUSQ@postgres.railway.internal:5432/railway',
  ssl: { rejectUnauthorized: false }
});

async function analyzeProductionSchema() {
  try {
    console.log('🔍 ANALYZING PRODUCTION DATABASE SCHEMA');
    console.log('=====================================\n');

    // Get all tables
    const tablesResult = await productionPool.query(`
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
      const columnsResult = await productionPool.query(`
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
        const countResult = await productionPool.query(`SELECT COUNT(*) as count FROM ${tableName}`);
        console.log(`   📈 Rows: ${countResult.rows[0].count}`);
      } catch (e) {
        console.log(`   📈 Rows: Error - ${e.message}`);
      }
      
      console.log('');
    }

    // Check for missing tables that should exist
    const expectedTables = [
      'users', 'proyectos', 'clientes', 
      'expense_categories', 'project_expenses', 'project_budgets',
      'tramos_proyecto', 'frentes_trabajo', 'reportes_diarios',
      'materiales', 'metas_proyecto'
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

    // Special focus on problematic tables
    console.log('\n🔍 PROBLEMATIC TABLE ANALYSIS');
    console.log('='.repeat(35));

    const problemTables = ['clientes', 'proyectos'];
    for (const tableName of problemTables) {
      if (existingTables.includes(tableName)) {
        const columnsResult = await productionPool.query(`
          SELECT column_name 
          FROM information_schema.columns 
          WHERE table_schema = 'public' AND table_name = $1
          ORDER BY ordinal_position
        `, [tableName]);
        
        console.log(`\n${tableName.toUpperCase()} columns:`);
        const columns = columnsResult.rows.map(r => r.column_name);
        console.log(`  [${columns.join(', ')}]`);
      }
    }

  } catch (error) {
    console.error('💥 ERROR analyzing production schema:', error.message);
    console.error('Details:', error);
  } finally {
    await productionPool.end();
  }
}

analyzeProductionSchema();