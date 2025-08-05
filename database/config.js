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
    await pool.query('SELECT NOW()');
    console.log('✅ Conexión a base de datos exitosa');
  } catch (error) {
    console.error('❌ Error conectando a base de datos:', error.message);
    process.exit(1);
  }
};

module.exports = {
  pool,
  query,
  testConnection
};