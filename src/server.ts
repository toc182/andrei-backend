import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Validación de variables de entorno críticas
const requiredEnvVars = ['JWT_SECRET'];
const missingEnvVars = requiredEnvVars.filter(
  (varName) => !process.env[varName],
);

if (missingEnvVars.length > 0) {
  console.error('❌ ERROR: Missing required environment variables:');
  missingEnvVars.forEach((varName) => console.error(`   - ${varName}`));
  console.error(
    '\nPlease check your .env file and ensure all required variables are set.',
  );
  process.exit(1);
}

// Validar configuración de base de datos
if (
  !process.env.DATABASE_URL &&
  (!process.env.DB_HOST || !process.env.DB_NAME || !process.env.DB_USER)
) {
  console.error('❌ ERROR: Database configuration is incomplete.');
  console.error(
    '   Either set DATABASE_URL or all of: DB_HOST, DB_NAME, DB_USER, DB_PASSWORD',
  );
  process.exit(1);
}

console.log('✅ Environment variables validated successfully');

// Imports después de validación
import { testConnection } from './database/config.js';
import { runAllMigrations } from './database/migrate.js';
import authRoutes from './routes/auth.js';
import projectRoutes from './routes/projects.js';
import clientesRoutes from './routes/clientes.js';
import costsRoutes from './routes/costs.js';
import licitacionesRoutes from './routes/licitaciones.js';
import oportunidadesRoutes from './routes/oportunidades.js';
import adendasRoutes from './routes/adendas.js';
import documentsRoutes from './routes/documents.js';
import equiposRoutes from './routes/equipos.js';
import asignacionesRoutes from './routes/asignaciones.js';
import registroUsoRoutes from './routes/registro-uso.js';

import requisicionesRoutes from './routes/requisiciones.js';
import projectMembersRoutes from './routes/projectMembers.js';
import externalContactsRoutes from './routes/externalContacts.js';
import projectTodosRoutes from './routes/projectTodos.js';
import projectBitacoraRoutes from './routes/projectBitacora.js';
import usersRoutes from './routes/users.js';
import solicitudesPagoRoutes from './routes/solicitudesPago.js';
import solicitudesPagoAdjuntosRoutes from './routes/solicitudesPagoAdjuntos.js';
import approvalSettingsRoutes from './routes/approvalSettings.js';
import permissionsRoutes from './routes/permissions.js';
import verificacionRoutes from './routes/verificacion.js';
import notificationsRoutes from './routes/notifications.js';
import cajasMenudasRoutes from './routes/cajasMenudas.js';
import { startScheduler } from './cron/scheduler.js';

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(
  cors({
    origin: [
      'https://andrei-frontend.vercel.app',
      'https://sistema.pinellaspanama.com',
      'http://localhost:5173',
    ],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }),
);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Public routes (no auth required)
app.use('/api/verificar', verificacionRoutes);

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

app.use('/api/requisiciones', requisicionesRoutes);
app.use('/api/project-members', projectMembersRoutes);
app.use('/api/external-contacts', externalContactsRoutes);
app.use('/api/project-todos', projectTodosRoutes);
app.use('/api/project-bitacora', projectBitacoraRoutes);
app.use('/api/users', usersRoutes);
// Inyectar token de query param para el endpoint PDF (window.open no envía headers)
app.use('/api/solicitudes-pago/:id/pdf', (req, res, next) => {
  if (!req.headers['authorization'] && req.query.token) {
    req.headers['authorization'] = `Bearer ${req.query.token}`;
  }
  next();
});
app.use('/api/solicitudes-pago', solicitudesPagoAdjuntosRoutes);
app.use('/api/solicitudes-pago', solicitudesPagoRoutes);
app.use('/api/approval-settings', approvalSettingsRoutes);
app.use('/api/permissions', permissionsRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/cajas-menudas', cajasMenudasRoutes);

// Servir archivos estáticos de uploads
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));

// Ruta de prueba
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({
    success: true,
    message: 'Servidor funcionando correctamente',
    timestamp: new Date().toISOString(),
  });
});

// Ruta para manejar rutas no encontradas
app.use('*', (_req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    message: 'Ruta no encontrada',
  });
});

// Middleware de manejo de errores
app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Error no manejado:', error);
  res.status(500).json({
    success: false,
    message: 'Error interno del servidor',
  });
});

// Iniciar servidor
async function startServer(): Promise<void> {
  try {
    console.log('🔧 Starting server initialization... [BUILD: TypeScript]');
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

    // Start cron scheduler
    startScheduler();

    console.log('🚀 Starting HTTP server...');
    app.listen(PORT, () => {
      console.log(`✅ Server running successfully on port ${PORT}`);
      console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`🔗 Health check: http://localhost:${PORT}/api/health`);
      console.log('🎉 Server startup complete!');
    });
  } catch (error) {
    const startupError = error as Error;
    console.error('💥 CRITICAL: Server startup failed');
    console.error('❌ Error type:', startupError.constructor.name);
    console.error('❌ Error message:', startupError.message);
    console.error('❌ Error stack:', startupError.stack);
    console.error('🔍 Environment debug:');
    console.error('   - NODE_ENV:', process.env.NODE_ENV);
    console.error('   - PORT:', process.env.PORT);
    console.error('   - DATABASE_URL exists:', !!process.env.DATABASE_URL);
    console.error('   - JWT_SECRET exists:', !!process.env.JWT_SECRET);
    process.exit(1);
  }
}

startServer();

export default app;
