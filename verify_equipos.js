const { query } = require('./database/config');

async function verifyEquipos() {
  try {
    console.log('🔍 AUDITORIA COMPLETA DE EQUIPOS');
    console.log('=================================\n');

    // Total equipos en BD
    const totalResult = await query("SELECT COUNT(*) as total FROM equipos WHERE activo = true");
    console.log(`📊 Total equipos en BD: ${totalResult.rows[0].total}`);

    // Por propietario
    const pinellasResult = await query("SELECT COUNT(*) as total FROM equipos WHERE owner = 'Pinellas' AND activo = true");
    const cocpResult = await query("SELECT COUNT(*) as total FROM equipos WHERE owner = 'COCP' AND activo = true");

    console.log(`📊 Equipos Pinellas: ${pinellasResult.rows[0].total}`);
    console.log(`📊 Equipos COCP: ${cocpResult.rows[0].total}`);

    // Buscar duplicados por descripción, marca, modelo, año
    console.log('\n🔍 BUSCANDO DUPLICADOS...');
    const duplicatesResult = await query(`
      SELECT descripcion, marca, modelo, ano, owner, COUNT(*) as count
      FROM equipos
      WHERE activo = true
      GROUP BY descripcion, marca, modelo, ano, owner
      HAVING COUNT(*) > 1
      ORDER BY count DESC, descripcion
    `);

    if (duplicatesResult.rows.length === 0) {
      console.log('✅ No se encontraron duplicados exactos');
    } else {
      console.log('❌ DUPLICADOS ENCONTRADOS:');
      duplicatesResult.rows.forEach((dup, index) => {
        console.log(`${index + 1}. ${dup.descripcion} (${dup.marca} ${dup.modelo}, ${dup.ano}) - ${dup.owner} - ${dup.count} veces`);
      });
    }

    // Buscar duplicados por descripción + marca + modelo (sin importar año)
    console.log('\n🔍 BUSCANDO DUPLICADOS SIMILARES...');
    const similarResult = await query(`
      SELECT descripcion, marca, modelo, STRING_AGG(DISTINCT ano::text, ', ') as anos,
             STRING_AGG(DISTINCT owner, ', ') as owners, COUNT(*) as count
      FROM equipos
      WHERE activo = true
      GROUP BY descripcion, marca, modelo
      HAVING COUNT(*) > 1
      ORDER BY count DESC, descripcion
    `);

    if (similarResult.rows.length === 0) {
      console.log('✅ No se encontraron equipos similares duplicados');
    } else {
      console.log('❌ EQUIPOS SIMILARES ENCONTRADOS:');
      similarResult.rows.forEach((sim, index) => {
        console.log(`${index + 1}. ${sim.descripcion} (${sim.marca} ${sim.modelo}) - Años: ${sim.anos} - Owners: ${sim.owners} - ${sim.count} veces`);
      });
    }

    // Listar todos los equipos para comparación manual
    console.log('\n📋 LISTADO COMPLETO DE EQUIPOS:');
    const allResult = await query(`
      SELECT id, codigo, descripcion, marca, modelo, ano, owner, observaciones
      FROM equipos
      WHERE activo = true
      ORDER BY owner, descripcion, ano
    `);

    allResult.rows.forEach((equipo, index) => {
      console.log(`${index + 1}. ${equipo.codigo || 'SIN CÓDIGO'} - ${equipo.descripcion} (${equipo.marca} ${equipo.modelo}, ${equipo.ano}) - ${equipo.owner} ${equipo.observaciones ? '- ' + equipo.observaciones : ''}`);
    });

    process.exit(0);
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

verifyEquipos();