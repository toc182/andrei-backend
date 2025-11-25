const { query } = require('./database/config');

async function checkArafat() {
  try {
    console.log('🔍 Verificando equipos de Pinellas con ARAFAT...');
    const result = await query(
      "SELECT codigo, descripcion, marca, modelo, ano, observaciones, owner FROM equipos WHERE owner = 'Pinellas' AND observaciones LIKE '%ARAFAT%' ORDER BY descripcion"
    );

    if (result.rows.length === 0) {
      console.log('✅ No hay equipos de Pinellas con ARAFAT');
    } else {
      console.log('❌ Equipos de Pinellas que tienen ARAFAT:');
      result.rows.forEach((equipo, index) => {
        console.log(`${index + 1}. ${equipo.codigo || 'SIN CÓDIGO'} - ${equipo.descripcion} (${equipo.marca} ${equipo.modelo}, ${equipo.ano}) - ${equipo.observaciones}`);
      });
    }

    console.log('\n🔍 Verificando equipos de COCP con ARAFAT...');
    const cocpResult = await query(
      "SELECT codigo, descripcion, marca, modelo, ano, observaciones, owner FROM equipos WHERE owner = 'COCP' AND observaciones LIKE '%ARAFAT%' ORDER BY descripcion"
    );

    console.log(`📊 Total equipos COCP con ARAFAT: ${cocpResult.rows.length}`);

    process.exit(0);
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

checkArafat();