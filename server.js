const express = require('express');
const cors = require('cors');
require('dotenv').config();

// Validación de variables de entorno críticas
const requiredEnvVars = ['JWT_SECRET'];
const missingEnvVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingEnvVars.length > 0) {
  console.error('❌ ERROR: Missing required environment variables:');
  missingEnvVars.forEach(varName => console.error(`   - ${varName}`));
  console.error('\nPlease check your .env file and ensure all required variables are set.');
  process.exit(1);
}

// Validar configuración de base de datos
if (!process.env.DATABASE_URL && (!process.env.DB_HOST || !process.env.DB_NAME || !process.env.DB_USER)) {
  console.error('❌ ERROR: Database configuration is incomplete.');
  console.error('   Either set DATABASE_URL or all of: DB_HOST, DB_NAME, DB_USER, DB_PASSWORD');
  process.exit(1);
}

console.log('✅ Environment variables validated successfully');

// Force Railway redeploy - 2025-09-11

const { testConnection } = require('./database/config');
const { runAllMigrations } = require('./database/migrate');
const authRoutes = require('./routes/auth');
const projectRoutes = require('./routes/projects');
const clientesRoutes = require('./routes/clientes');
const costsRoutes = require('./routes/costs');
const licitacionesRoutes = require('./routes/licitaciones');
const oportunidadesRoutes = require('./routes/oportunidades');
const adendasRoutes = require('./routes/adendas');
const documentsRoutes = require('./routes/documents');
const equiposRoutes = require('./routes/equipos');
const asignacionesRoutes = require('./routes/asignaciones');
const registroUsoRoutes = require('./routes/registro-uso');

const app = express();
const PORT = process.env.PORT || 8080;

// Middleware
app.use(cors({
  origin: [
    'https://andrei-frontend.vercel.app',
    'http://localhost:3000',
    'http://localhost:5173',
    'http://localhost:5174',
    'http://localhost:5175',
    'http://localhost:5176'
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

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/clientes', clientesRoutes);
app.use('/api/costs', costsRoutes);
app.use('/api/licitaciones', licitacionesRoutes);
app.use('/api/oportunidades', oportunidadesRoutes);
app.use('/api/adendas', adendasRoutes);
app.use('/api/documents', documentsRoutes);
app.use('/api/equipos', equiposRoutes);
app.use('/api/asignaciones', asignacionesRoutes);
app.use('/api/registro-uso', registroUsoRoutes);
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
    console.log('🔧 Starting server initialization... [BUILD: 20250827-1521]');
    console.log('📊 Environment:', process.env.NODE_ENV || 'development');
    console.log('🌐 Port:', PORT);
    console.log('🔌 Database URL exists:', !!process.env.DATABASE_URL);
    console.log('🔑 JWT Secret exists:', !!process.env.JWT_SECRET);
    
    console.log('📡 Testing database connection...');
    await testConnection();
    console.log('✅ Database connection successful');
    
    // Run database migrations
    console.log('🔄 Ejecutando migraciones de base de datos...');
    await runAllMigrations();
    console.log('✅ Migrations completed');

    console.log('🚀 Starting HTTP server...');
    app.listen(PORT, () => {
      console.log(`✅ Server running successfully on port ${PORT}`);
      console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`🔗 Health check: http://localhost:${PORT}/api/health`);
      console.log('🎉 Server startup complete!');
    });
  } catch (error) {
    console.error('💥 CRITICAL: Server startup failed');
    console.error('❌ Error type:', error.constructor.name);
    console.error('❌ Error message:', error.message);
    console.error('❌ Error stack:', error.stack);
    console.error('🔍 Environment debug:');
    console.error('   - NODE_ENV:', process.env.NODE_ENV);
    console.error('   - PORT:', process.env.PORT);
    console.error('   - DATABASE_URL exists:', !!process.env.DATABASE_URL);
    console.error('   - JWT_SECRET exists:', !!process.env.JWT_SECRET);
    process.exit(1);
  }
}

startServer();

module.exports = app;