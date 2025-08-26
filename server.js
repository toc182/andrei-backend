const express = require('express');
const cors = require('cors');
require('dotenv').config();

const { testConnection } = require('./database/config');
const { runAllMigrations } = require('./database/migrate');
const authRoutes = require('./routes/auth');
const projectRoutes = require('./routes/projects');
const clientesRoutes = require('./routes/clientes');
// Cost routes will be loaded conditionally after migrations

const app = express();
const PORT = process.env.PORT || 8080;

// Middleware
app.use(cors({
  origin: [
    'https://andrei-frontend.vercel.app',
    'http://localhost:3000',
    'http://localhost:5173',
    'http://localhost:5174',
    'http://localhost:5175'
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Debug temporal - updated
app.use((req, res, next) => {
  console.log('🌐 Request from:', req.headers.origin);
  console.log('🔧 Method:', req.method);
  next();
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Core routes
app.use('/api/auth', authRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/clientes', clientesRoutes);
// Rutas de seguimiento de tuberías
app.use('/api/seguimiento', require('./routes/seguimiento'));

// Ruta de prueba
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    message: 'Servidor funcionando correctamente',
    timestamp: new Date().toISOString()
  });
});

// Ruta para manejar rutas no encontradas
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    message: 'Ruta no encontrada'
  });
});

// Middleware de manejo de errores
app.use((error, req, res, next) => {
  console.error('Error no manejado:', error);
  res.status(500).json({
    success: false,
    message: 'Error interno del servidor'
  });
});

// Iniciar servidor
async function startServer() {
  try {
    await testConnection();
    
    // Run database migrations
    console.log('🔄 Ejecutando migraciones de base de datos...');
    await runAllMigrations();

    // Load cost routes after successful migrations
    try {
      console.log('📊 Loading cost tracking routes...');
      const costsRoutes = require('./routes/costs');
      app.use('/api/costs', costsRoutes);
      console.log('✅ Cost tracking routes loaded successfully');
    } catch (error) {
      console.log('⚠️  Cost tracking routes not loaded:', error.message);
      console.log('   This is normal if cost tracking tables are not ready yet');
    }

    app.listen(PORT, () => {
      console.log(`🚀 Servidor ejecutándose en puerto ${PORT}`);
      console.log(`📊 Ambiente: ${process.env.NODE_ENV || 'development'}`);
      console.log(`🔗 Health check: http://localhost:${PORT}/api/health`);
    });
  } catch (error) {
    console.error('❌ Error iniciando servidor:', error);
    process.exit(1);
  }
}

startServer();

module.exports = app;