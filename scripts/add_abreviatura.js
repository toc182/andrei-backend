const { query } = require('../database/config');

async function addAbreviaturaField() {
  try {
    console.log('🔄 Adding abreviatura field to clientes table...');
    
    // Add the abreviatura column
    await query('ALTER TABLE clientes ADD COLUMN abreviatura VARCHAR(25)');
    console.log('✅ Column abreviatura added successfully');
    
    // Add unique constraint
    await query('ALTER TABLE clientes ADD CONSTRAINT unique_abreviatura UNIQUE (abreviatura)');
    console.log('✅ Unique constraint added successfully');
    
    // Add index
    await query('CREATE INDEX idx_clientes_abreviatura ON clientes(abreviatura)');
    console.log('✅ Index created successfully');
    
    console.log('🎉 Migration completed successfully!');
    process.exit(0);
    
  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    
    // If column already exists, that's okay
    if (error.message.includes('already exists')) {
      console.log('ℹ️  Column already exists, migration not needed');
      process.exit(0);
    }
    
    process.exit(1);
  }
}

addAbreviaturaField();