// Prueba de humo: preguntarle al asistente por los reportes diarios enviados.
// npm run pruebas -- whatsapp-reportes
//
// Se exige:
// - ve solo las obras cuyos reportes ve en la pantalla, y solo reportes
//   enviados y activos;
// - aqui no se cuenta ni se suma: eso es consultar_reportes, y su prueba es
//   whatsapp-consultas;
// - buscar por palabra mira TODOS los reportes —tambien uno de hace año y
//   medio—, sin tildes, y en todo lo escrito: trabajo (nuevo y viejo),
//   atrasos, lo que llego y las leyendas; devuelve la frase y la fecha;
// - una obra ajena no se busca;
// - sin palabra, la lista lleva como mucho 60 reportes y dice cuantos son;
// - un reporte se ve entero por su numero, nuevo o viejo.
import { query, pool } from '../src/database/config.js';
import { buscarReportes, verReporte } from '../src/services/whatsapp/reportes.js';
import type { Usuario } from '../src/services/whatsapp/herramientas.js';

let fallos = 0;
const exigir = (bien: boolean, que: string, visto?: unknown): void => {
  console.log(`${bien ? '  ok  ' : 'FALLA '} ${que}${bien || visto === undefined ? '' : ` → ${JSON.stringify(visto)}`}`);
  if (!bien) fallos += 1;
};

interface Busqueda {
  totales?: unknown;
  aparece_en?: { reportes: number; primer_dia: string; ultimo_dia: string };
  frases?: { fecha: string; donde: string; frase: string }[];
  reportes?: unknown[];
  ojo?: string;
}

const main = async () => {
  const ingeniero = (
    await query<Usuario>("SELECT id, nombre, rol FROM users WHERE email = 'aprobador1@pruebas.local'")
  ).rows[0];
  await query(
    `INSERT INTO user_permissions (user_id, reportes) VALUES ($1, true)
     ON CONFLICT (user_id) DO UPDATE SET reportes = true`,
    [ingeniero.id],
  );
  await query('INSERT INTO user_project_access (user_id, proyecto_id) VALUES ($1, 1) ON CONFLICT DO NOTHING', [ingeniero.id]);

  let n = 0;
  const reporte = async (
    proyecto: number,
    fecha: string,
    campos: Record<string, unknown> = {},
    estado: { completo?: boolean; activo?: boolean } = {},
  ): Promise<{ id: number; numero: string }> => {
    const numero = `RD-PRU${proyecto}-${fecha.replace(/-/g, '').slice(2)}-${(n += 1)}`;
    const cols = ['proyecto_id', 'numero', 'fecha', 'creado_por', 'completo', 'activo', ...Object.keys(campos)];
    const vals = [proyecto, numero, fecha, ingeniero.id, estado.completo ?? true, estado.activo ?? true, ...Object.values(campos)];
    const r = await query<{ id: number }>(
      `INSERT INTO proyecto_reportes (${cols.join(', ')})
       VALUES (${vals.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
      vals,
    );
    return { id: r.rows[0].id, numero };
  };

  // Uno viejo, de hace año y medio: trabajo en un solo texto, la gente en dos
  // numeros y las maquinas sin horas.
  const viejo = await reporte(1, '2025-03-03', {
    clima: 'Soleado', horas_perdidas: 0,
    que_se_hizo: 'Se inició la instalación de TUBERIA de 12" en el carcamo 3. Relleno compactado.',
    personal_calificado: 6, ayudantes: 4, equipo: ['Retroexcavadora vieja'],
  });
  // Dos nuevos.
  const nuevo1 = await reporte(1, '2026-09-20', { clima: 'Lluvia parcial', horas_perdidas: 2, motivo: 'Lluvia', atrasos: 'Llovió de 2 a 4.' });
  const nuevo2 = await reporte(1, '2026-09-21', { clima: 'Soleado', horas_perdidas: 0 });
  // Lo que no cuenta: un borrador, uno dado de baja y uno de una obra ajena.
  await reporte(1, '2026-09-22', { clima: 'Soleado', que_se_hizo: 'tubería del borrador' }, { completo: false });
  await reporte(1, '2026-09-23', { clima: 'Soleado', que_se_hizo: 'tubería de uno borrado' }, { activo: false });
  await reporte(2, '2026-09-20', { clima: 'Soleado', que_se_hizo: 'Tubería de la obra ajena' });

  const area = (await query<{ id: number }>('SELECT id FROM proyecto_areas WHERE proyecto_id = 1 ORDER BY orden, id LIMIT 1')).rows[0].id;
  await query(
    `INSERT INTO proyecto_reporte_trabajos (reporte_id, area_id, texto, orden) VALUES
       ($1, $3, 'Se terminó la instalación de tuberías del carcamo 3.', 1),
       ($2, $3, 'Vaciado de pedestales.', 1)`,
    [nuevo1.id, nuevo2.id, area],
  );
  const puesto = (await query<{ id: number }>("SELECT id FROM proyecto_puestos WHERE proyecto_id = 1 AND nombre = 'Calificados'")).rows[0].id;
  await query(
    'INSERT INTO proyecto_reporte_personal (reporte_id, puesto_id, cantidad) VALUES ($1, $3, 8), ($2, $3, 12)',
    [nuevo1.id, nuevo2.id, puesto],
  );
  const retro = (await query<{ id: number }>("SELECT id FROM proyecto_equipos WHERE proyecto_id = 1 AND nombre = 'Retroexcavadora'")).rows[0].id;
  await query(
    'INSERT INTO proyecto_reporte_equipos (reporte_id, equipo_id, unidades, horas) VALUES ($1, $3, 1, 6), ($2, $3, 1, 3.5)',
    [nuevo1.id, nuevo2.id, retro],
  );
  await query(
    `INSERT INTO proyecto_reporte_fotos (reporte_id, nombre_archivo, r2_key, orden, creado_por, leyenda)
     VALUES ($1, 'f.jpg', 'PRUEBAS1/x/f.jpg', 1, $2, 'Prueba de la tubería con agua')`,
    [nuevo2.id, ingeniero.id],
  );

  // ── la lista ────────────────────────────────────────────────────────────
  const todo = await buscarReportes(ingeniero, {});
  const t = todo.ok ? (todo.contenido as Busqueda) : null;
  exigir(t?.reportes?.length === 3, 'lista solo los tres enviados y activos de su obra', t?.reportes?.length);
  exigir(
    t !== null && t.totales === undefined,
    'y no trae totales: contar es de consultar_reportes, para que haya una sola manera de contar',
  );

  // ── buscar por palabra ──────────────────────────────────────────────────
  const tuberias = await buscarReportes(ingeniero, { palabras: ['tuberia', 'tubo'] });
  const b = tuberias.ok ? (tuberias.contenido as Busqueda) : null;
  exigir(
    b?.aparece_en?.primer_dia === '2025-03-03' && b.aparece_en.ultimo_dia === '2026-09-21' && b.aparece_en.reportes === 3,
    '«tubería» aparece del 3 de marzo de 2025 al 21 de septiembre de 2026, en los tres',
    b?.aparece_en,
  );
  const donde = new Set((b?.frases ?? []).map((f) => f.donde.split(' ·')[0]));
  exigir(
    donde.has('trabajo') && donde.has('foto') && (b?.frases ?? []).some((f) => f.frase.includes('TUBERIA')),
    'la encuentra sin tildes, en el trabajo viejo y nuevo y en la leyenda de una foto',
    b?.frases,
  );
  exigir(
    !(b?.frases ?? []).some((f) => /borrador|borrado|ajena/.test(f.frase)),
    'no aparecen el borrador, el dado de baja ni la obra ajena',
  );
  const ajena = await buscarReportes(ingeniero, { proyecto_ids: [2], palabras: ['tuberia'] });
  exigir(!ajena.ok, 'pedir los reportes de una obra ajena se rechaza');

  // ── el tope de la lista ─────────────────────────────────────────────────
  await query(
    `INSERT INTO proyecto_reportes (proyecto_id, numero, fecha, creado_por, completo, activo, clima)
     SELECT 1, 'RD-PRU1-TOPE-' || g, DATE '2026-01-01' + g, $1, true, true, 'Soleado'
       FROM generate_series(1, 70) g`,
    [ingeniero.id],
  );
  const muchos = await buscarReportes(ingeniero, {});
  const m = muchos.ok ? (muchos.contenido as Busqueda) : null;
  exigir(
    m?.reportes?.length === 60 && Boolean(m.ojo?.includes('73')),
    'con 73 reportes, la lista lleva 60 y avisa de que son 73',
    m && [m.reportes?.length, m.ojo],
  );
  const siguenTodos = await buscarReportes(ingeniero, { palabras: ['tuberia'] });
  exigir(
    siguenTodos.ok && (siguenTodos.contenido as Busqueda).aparece_en?.primer_dia === '2025-03-03',
    'y buscar por palabra sigue mirando todos, también el de hace año y medio',
  );

  // ── un reporte entero ───────────────────────────────────────────────────
  const elViejo = await verReporte(ingeniero, { numero: viejo.numero });
  const v = JSON.stringify(elViejo);
  exigir(
    elViejo.ok && v.includes('carcamo 3') && v.includes('"calificados":6') && v.includes('Retroexcavadora vieja'),
    'el reporte viejo se ve entero, con su gente y sus máquinas de antes',
  );
  const elNuevo = await verReporte(ingeniero, { proyecto_id: 1, fecha: '2026-09-20' });
  const w = JSON.stringify(elNuevo);
  exigir(
    elNuevo.ok && w.includes('Se terminó la instalación') && w.includes('"horas":6') && w.includes('Llovió de 2 a 4'),
    'el nuevo, por obra y fecha, con su trabajo por área, la retro y los atrasos',
  );

  await pool.end();
  console.log(fallos === 0 ? '\nTodo bien' : `\n${fallos} fallo(s)`);
  process.exit(fallos === 0 ? 0 : 1);
};

main().catch(async (e) => {
  console.error(e);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
