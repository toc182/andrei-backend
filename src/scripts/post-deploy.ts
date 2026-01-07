/**
 * Post-deploy script
 * Runs after deployment to execute necessary tasks
 */

import { runAllMigrations } from '../database/migrate.js';

async function postDeploy(): Promise<void> {
  console.log('🚀 Running post-deploy tasks...');

  try {
    // Run database migrations
    console.log('📦 Running database migrations...');
    await runAllMigrations();
    console.log('✅ Migrations completed successfully');

    console.log('🎉 Post-deploy tasks completed!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Post-deploy failed:', error);
    process.exit(1);
  }
}

postDeploy();
