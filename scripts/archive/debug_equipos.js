const { Pool } = require('pg');

const pool = new Pool({
  host: 'localhost',
  database: 'andrei_db',
  user: 'postgres',
  password: 'Dinocore51720',
  port: 5432,
});

async function checkDatabase() {
  try {
    // Ver todas las tablas en la base de datos
    const tablesResult = await pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);

    console.log('=== TODAS LAS TABLAS EN LA BASE DE DATOS ===');
    tablesResult.rows.forEach((row, index) => {
      console.log(`${index + 1}. ${row.table_name}`);
    });

    console.log(`\nTotal de tablas: ${tablesResult.rows.length}`);

    // Ver estructura de cada tabla
    console.log('\n=== ESTRUCTURA DE CADA TABLA ===');
    for (const table of tablesResult.rows) {
      const tableName = table.table_name;

      const columnsResult = await pool.query(`
        SELECT column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
        ORDER BY ordinal_position
      `, [tableName]);

      console.log(`\n📋 Tabla: ${tableName.toUpperCase()}`);
      console.log('Columnas:');
      columnsResult.rows.forEach(col => {
        console.log(`  - ${col.column_name} (${col.data_type}) ${col.is_nullable === 'NO' ? '- NOT NULL' : ''}`);
      });

      // Contar registros en cada tabla
      try {
        const countResult = await pool.query(`SELECT COUNT(*) as total FROM ${tableName}`);
        console.log(`Registros: ${countResult.rows[0].total}`);
      } catch (e) {
        console.log('Registros: Error al contar');
      }
    }

    await pool.end();
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

checkDatabase();