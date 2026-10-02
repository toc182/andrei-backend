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
// - un reporte se ve entero por su numero, nuevo o viejo;
// - un semanal se ve entero (ver_semanal) por su numero, por una fecha de su
//   semana, por su numero de semana o, con la obra sola, el ultimo enviado;
//   nunca un borrador ni uno de una obra ajena, y sin la seccion de pagos;
//   ver_reporte con un numero de semanal lo manda a ver_semanal.
import { query, pool } from '../src/database/config.js';
import { buscarReportes, verReporte } from '../src/services/whatsapp/reportes.js';
import { verSemanal } from '../src/services/whatsapp/semanales.js';
import { ejecutarHerramienta, type Usuario } from '../src/services/whatsapp/herramientas.js';
import { conversacionViva } from '../src/services/whatsapp/conversacion.js';

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

  // ── un semanal entero ───────────────────────────────────────────────────
  const dias = ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-19', '2026-09-20'];
  const datos = {
    dias: dias.map((fecha, i) => ({ fecha, numero: i === 6 ? nuevo1.numero : null })),
    personal: [{ empresa: null, filas: [{ nombre: 'Calificados', por_dia: [null, null, null, null, null, null, 8], total: 8 }] }],
    personal_total: [null, null, null, null, null, null, 8],
    personal_promedio: 8,
    horas_perdidas: { por_dia: [null, null, null, null, null, null, 2], total: 2, motivos: [{ fecha: '2026-09-20', horas: 2, motivo: 'Lluvia' }] },
    equipos: [{ nombre: 'Retroexcavadora', por_dia: [null, null, null, null, null, null, 6], total: 6 }],
    materiales: [],
    pagos: { filas: [{ categoria: 'Materiales', solicitudes: 2, monto: 12345.67 }], solicitudes: 2, monto: 12345.67 },
    comparacion: { semana_anterior: { inicio: '2026-09-07', fin: '2026-09-13' }, filas: [] },
  };
  const semanal = async (
    proyecto: number, lunes: string, semanaIso: number, numero: string | null, completo = true,
  ): Promise<number> =>
    (await query<{ id: number }>(
      `INSERT INTO proyecto_reportes_semanales
         (proyecto_id, numero, semana_inicio, semana_fin, anio_iso, semana_iso, resumen, lo_que_se_espera,
          datos, completo, enviado_at, creado_por)
       VALUES ($1, $2, $3::date, $3::date + 6, 2026, $4, $5, 'Seguir con los pedestales.', $6, $7,
               $8::timestamptz, $9)
       RETURNING id`,
      [
        proyecto, numero, lunes, semanaIso, `Resumen de ${numero ?? 'un borrador'}`,
        completo ? JSON.stringify(datos) : null, completo, completo ? '2026-09-22 02:00:00+00' : null, ingeniero.id,
      ],
    )).rows[0].id;
  const s37 = await semanal(1, '2026-09-07', 37, 'RS-PRU1-260907');
  const s38 = await semanal(1, '2026-09-14', 38, 'RS-PRU1-260914');
  await semanal(1, '2026-09-21', 39, null, false);
  await semanal(2, '2026-09-14', 38, 'RS-PRU2-260914');
  await query(
    `INSERT INTO proyecto_reporte_semanal_metas
       (reporte_plan_id, reporte_evaluacion_id, texto, cantidad, unidad, estado, cantidad_hecha, motivo, orden) VALUES
       ($1, $2, 'Vaciar zapatas', 13, 'ud', 'parcial', 9, 'Faltó concreto', 1),
       ($1, $2, 'Instalar tubería del carcamo 3', NULL, NULL, 'completada', NULL, NULL, 2),
       ($2, NULL, 'Vaciar pedestales', 6, 'ud', NULL, NULL, NULL, 1)`,
    [s37, s38],
  );
  await query(
    `INSERT INTO proyecto_reporte_semanal_problemas (reporte_id, fecha, problema, accion, pendiente, orden) VALUES
       ($1, '2026-09-20', 'Lluvia de 2 a 4', NULL, false, 1),
       ($1, NULL, 'Falta de concreto', 'Cambiar de proveedor', true, 2)`,
    [s38],
  );
  await query("INSERT INTO proyecto_reporte_semanal_decisiones (reporte_id, texto) VALUES ($1, 'Aprobar otro proveedor de concreto')", [s38]);
  await query(
    `INSERT INTO proyecto_reporte_semanal_correcciones (reporte_id, creado_por, cambios)
     VALUES ($1, $2, $3)`,
    [s38, ingeniero.id, JSON.stringify([
      { etiqueta: 'Decisiones', renglones: [[{ tipo: 'agregado', texto: 'Aprobar otro proveedor de concreto' }]] },
    ])],
  );

  interface Semanal {
    numero?: string;
    enviado_el?: string;
    metas_de_la_semana?: { meta: string; como_quedo: string; cantidad_hecha?: number; motivo?: string }[];
    plan_de_la_semana_siguiente?: { metas: { meta: string }[] };
    problemas?: { problema: string; sigue_pendiente: boolean }[];
    decisiones_que_pide?: string[];
    cifras_de_la_semana?: { gente: { empresa: string }[]; maquinas: { total: number }[] } | null;
    correcciones?: { quien: string; cambios: { seccion: string; lineas: string[] }[] }[];
  }
  const ver = async (pedido: Parameters<typeof verSemanal>[1]): Promise<Semanal | null> => {
    const r = await verSemanal(ingeniero, pedido);
    return r.ok ? (r.contenido as Semanal) : null;
  };

  const s = await ver({ numero: 'rs-pru1-260914' });
  exigir(
    s?.numero === 'RS-PRU1-260914' && s.enviado_el === '2026-09-21'
      && JSON.stringify(s.metas_de_la_semana?.map((m) => [m.meta, m.como_quedo])) ===
        JSON.stringify([['Instalar tubería del carcamo 3', 'completada'], ['Vaciar zapatas', 'parcial']])
      && s.metas_de_la_semana?.[1].cantidad_hecha === 9 && s.metas_de_la_semana?.[1].motivo === 'Faltó concreto'
      && s.plan_de_la_semana_siguiente?.metas[0]?.meta === 'Vaciar pedestales',
    'un semanal por su número: enviado el 21 en Panamá, metas en el orden del papel, con lo hecho y el motivo, y el plan',
    s,
  );
  exigir(
    s?.problemas?.[0]?.problema === 'Falta de concreto' && s.problemas[0].sigue_pendiente
      && s.decisiones_que_pide?.[0] === 'Aprobar otro proveedor de concreto'
      && s.correcciones?.[0]?.cambios[0]?.lineas[0] === '[agregado: Aprobar otro proveedor de concreto]',
    'lo pendiente primero, las decisiones y las correcciones',
    s && [s.problemas, s.decisiones_que_pide, s.correcciones],
  );
  const texto = JSON.stringify(s);
  exigir(
    Boolean(s?.cifras_de_la_semana?.gente[0]?.empresa) && s?.cifras_de_la_semana?.maquinas[0]?.total === 6
      && !texto.includes('12345') && !texto.includes('pagos'),
    'con las cifras del papel (la gente con el nombre de la cuadrilla propia) y sin la sección de pagos',
    s?.cifras_de_la_semana,
  );
  exigir((await ver({ proyecto_id: 1, fecha: '2026-09-17' }))?.numero === 'RS-PRU1-260914', 'por una fecha de su semana');
  exigir((await ver({ proyecto_id: 1, semana_iso: 37, anio: 2026 }))?.numero === 'RS-PRU1-260907', 'por su número de semana');
  exigir((await ver({ proyecto_id: 1 }))?.numero === 'RS-PRU1-260914', 'con la obra sola, el último enviado y no el borrador de después');
  exigir((await ver({ numero: 'RS-PRU2-260914' })) === null, 'el de una obra ajena no se ve por su número');
  exigir((await ver({ proyecto_id: 2 })) === null, 'ni pidiendo esa obra');
  const noHay = await verSemanal(ingeniero, { proyecto_id: 1, fecha: '2026-08-03' });
  exigir(
    !noHay.ok && JSON.stringify(noHay.extra ?? '').includes('RS-PRU1-260907'),
    'una semana sin semanal dice cuáles hay de esa obra',
    noHay,
  );

  const conversacion = await conversacionViva('50761110010', ingeniero.id);
  const porVerReporte = await ejecutarHerramienta(
    'ver_reporte', { numero: 'RS-PRU1-260914' }, { usuario: ingeniero, conversacion, fotos: 0 }, { listas: null },
  );
  exigir(
    porVerReporte.ok && (porVerReporte.contenido as Semanal).numero === 'RS-PRU1-260914',
    'ver_reporte con un número de semanal lo abre como semanal',
    porVerReporte,
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
