const express = require('express');
const cors = require('cors');
require('dotenv').config();

const { testConnection } = require('./database/config');

const app = express();
const PORT = process.env.PORT || 8080;

// Minimal CORS
app.use(cors({
  origin: ['https://andrei-frontend.vercel.app', 'http://localhost:3000', 'http://localhost:5173', 'http://localhost:5174', 'http://localhost:5175'],
  credentials: true
}));

app.use(express.json());

// Only essential routes
const authRoutes = require('./routes/auth');
app.use('/api/auth', authRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    message: 'Servidor funcionando correctamente',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// Simple projects route test
app.get('/api/projects/test', async (req, res) => {
  try {
    const { query } = require('./database/config');
    const result = await query('SELECT COUNT(*) as count FROM proyectos');
    res.json({
      success: true,
      message: 'Database connection working',
      projectCount: result.rows[0].count
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Database error',
      error: error.message
    });
  }
});

// Error handling
app.use((error, req, res, next) => {
  console.error('Error:', error);
  res.status(500).json({
    success: false,
    message: 'Internal server error',
    error: process.env.NODE_ENV === 'development' ? error.message : 'Server error'
  });
});

// Start server
async function startServer() {
  try {
    console.log('🔍 Testing database connection...');
    await testConnection();
    
    app.listen(PORT, () => {
      console.log(`🚀 Test server running on port ${PORT}`);
      console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`🔗 Health: http://localhost:${PORT}/api/health`);
      console.log(`🔗 Test projects: http://localhost:${PORT}/api/projects/test`);
    });
  } catch (error) {
    console.error('❌ Server startup failed:', error);
    process.exit(1);
  }
}

startServer();