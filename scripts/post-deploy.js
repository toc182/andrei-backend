const { runAllMigrations } = require('../database/migrate');

console.log('🚀 Post-deploy script iniciado...');

runAllMigrations()
  .then(() => {
    console.log('✅ Post-deploy completado exitosamente');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Error en post-deploy:', error);
    process.exit(1);
  });