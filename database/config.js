const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

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