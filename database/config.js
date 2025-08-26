const { Pool } = require('pg');
require('dotenv').config();

// Configuración para Railway (usa DATABASE_URL) o local (variables separadas)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Si no hay DATABASE_URL, usar variables separadas (desarrollo local)
if (!process.env.DATABASE_URL) {
  pool.options.user = process.env.DB_USER;
  pool.options.host = process.env.DB_HOST;
  pool.options.database = process.env.DB_NAME;
  pool.options.password = process.env.DB_PASSWORD;
  pool.options.port = process.env.DB_PORT;
}

// Función para ejecutar consultas
const query = async (text, params) => {
  try {
    const result = await pool.query(text, params);
    return result;
  } catch (error) {
    console.error('Error en consulta de base de datos:', error);
    throw error;
  }
};

// Función para verificar conexión
const testConnection = async () => {
  try {
    console.log('🔍 Database connection details:');
    console.log('   - Using DATABASE_URL:', !!process.env.DATABASE_URL);
    if (!process.env.DATABASE_URL) {
      console.log('   - DB_HOST:', process.env.DB_HOST);
      console.log('   - DB_NAME:', process.env.DB_NAME);  
      console.log('   - DB_USER:', process.env.DB_USER);
      console.log('   - DB_PORT:', process.env.DB_PORT);
    }
    
    const result = await pool.query('SELECT NOW() as current_time, version() as pg_version');
    console.log('✅ Database connection successful');
    console.log('📅 Current time:', result.rows[0].current_time);
    console.log('🔢 PostgreSQL version:', result.rows[0].pg_version.split(' ')[0]);
  } catch (error) {
    console.error('💥 Database connection failed');
    console.error('❌ Error code:', error.code);
    console.error('❌ Error message:', error.message);
    console.error('❌ Error detail:', error.detail);
    console.error('🔍 Connection config debug:');
    console.error('   - DATABASE_URL exists:', !!process.env.DATABASE_URL);
    console.error('   - Pool config:', {
      host: pool.options.host,
      database: pool.options.database,
      user: pool.options.user,
      port: pool.options.port
    });
    throw error;
  }
};

module.exports = {
  pool,
  query,
  testConnection
};