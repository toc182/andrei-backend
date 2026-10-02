// Prueba de humo: las consultas que el asistente le escribe a la base.
// npm run pruebas -- whatsapp-consultas
//
// Se exige:
// - la cuenta del asistente solo lee las vistas del esquema `asistente`: ni las
//   tablas del sistema, ni la de quien ve que, ni escribir nada;
// - cada persona ve las obras que ve en la pantalla, escriba lo que escriba en
//   su consulta; sin permiso de reportes, nada;
// - una segunda orden detras de un «;» no corre, y una consulta lenta se corta;
// - las cuentas salen bien: dias-persona por puesto (lo que Ivan pregunto el
//   2026-10-01), mezclando reportes nuevos y del formato anterior, sin
//   borradores ni reportes dados de baja;
// - las fechas llegan como AAAA-MM-DD y los totales como numeros;
// - con mas de 200 filas, llegan 200 y el aviso de que hay mas;
// - los semanales (migracion 180): solo los enviados y no eliminados de sus
//   obras; lo que se marco en un semanal que sigue en borrador no se ve, y el
//   dia de envio es el de Panama;
// - la herramienta consultar_reportes: el asistente recibe la descripcion de
//   las tablas sacada de la base, cada consulta queda guardada con lo que
//   salio, y tras dos que fallan en un turno no se le deja seguir probando.
import { query, pool } from '../src/database/config.js';
import {
  consultarBase,
  describirVistas,
  TOPE_FILAS,
  type ResultadoConsulta,
} from '../src/services/whatsapp/consultas.js';
import { ejecutarHerramienta, herramientas, type Usuario } from '../src/services/whatsapp/herramientas.js';
import { conversacionViva } from '../src/services/whatsapp/conversacion.js';
import type { ListasProyecto } from '../src/services/whatsapp/datosReporte.js';

let fallos = 0;
const exigir = (bien: boolean, que: string, visto?: unknown): void => {
  console.log(`${bien ? '  ok  ' : 'FALLA '} ${que}${bien || visto === undefined ? '' : ` → ${JSON.stringify(visto)}`}`);
  if (!bien) fallos += 1;
};
const falla = (r: ResultadoConsulta): string => (r.ok ? '' : r.error);

const main = async () => {
  const admin = (await query<Usuario>("SELECT id, nombre, rol FROM users WHERE rol = 'admin' AND activo ORDER BY id LIMIT 1")).rows[0];
  const usuario = (rol: string) => query<Usuario>('SELECT id, nombre, rol FROM users WHERE email = $1', [rol]).then((r) => r.rows[0]);
  const ingeniero = await usuario('aprobador1@pruebas.local');
  const sinPermiso = await usuario('aprobador2@pruebas.local');
  await query(
    `INSERT INTO user_permissions (user_id, reportes) VALUES ($1, true)
     ON CONFLICT (user_id) DO UPDATE SET reportes = true`,
    [ingeniero.id],
  );
  await query('INSERT INTO user_project_access (user_id, proyecto_id) VALUES ($1, 1) ON CONFLICT DO NOTHING', [ingeniero.id]);
  await query('INSERT INTO user_project_access (user_id, proyecto_id) VALUES ($1, 1) ON CONFLICT DO NOTHING', [sinPermiso.id]);

  let n = 0;
  const reporte = async (
    proyecto: number,
    fecha: string,
    campos: Record<string, unknown> = {},
    estado: { completo?: boolean; activo?: boolean } = {},
  ): Promise<number> => {
    const cols = ['proyecto_id', 'numero', 'fecha', 'creado_por', 'completo', 'activo', ...Object.keys(campos)];
    const vals = [
      proyecto, `RD-PRU${proyecto}-${fecha.replace(/-/g, '').slice(2)}-${(n += 1)}`, fecha, ingeniero.id,
      estado.completo ?? true, estado.activo ?? true, ...Object.values(campos),
    ];
    const r = await query<{ id: number }>(
      `INSERT INTO proyecto_reportes (${cols.join(', ')})
       VALUES (${vals.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
      vals,
    );
    return r.rows[0].id;
  };
  const puesto = async (proyecto: number, nombre: string): Promise<number> =>
    (await query<{ id: number }>('SELECT id FROM proyecto_puestos WHERE proyecto_id = $1 AND nombre = $2', [proyecto, nombre])).rows[0].id;
  const gente = async (reporteId: number, filas: [number, number][]): Promise<void> => {
    for (const [puestoId, cantidad] of filas) {
      await query('INSERT INTO proyecto_reporte_personal (reporte_id, puesto_id, cantidad) VALUES ($1, $2, $3)', [reporteId, puestoId, cantidad]);
    }
  };

  const cal1 = await puesto(1, 'Calificados');
  const ayu1 = await puesto(1, 'Ayudantes');
  const ing1 = await puesto(1, 'Ingenieros');
  const cal2 = await puesto(2, 'Calificados');

  // Obra 1: uno del formato anterior y dos de ahora. Los que no cuentan: un
  // borrador, uno dado de baja. Obra 2: uno, que el ingeniero no ve.
  await reporte(1, '2026-09-08', { clima: 'Soleado', personal_calificado: 6, ayudantes: 4, equipo: ['Retro vieja'] });
  const a = await reporte(1, '2026-09-09', { clima: 'Lluvia parcial', horas_perdidas: 2 });
  const b = await reporte(1, '2026-09-10', { clima: 'Soleado' });
  await gente(a, [[cal1, 4], [ayu1, 2], [ing1, 1]]);
  await gente(b, [[cal1, 3], [ayu1, 5], [ing1, 1]]);
  await gente(await reporte(1, '2026-09-11', { clima: 'Soleado' }, { completo: false }), [[cal1, 50]]);
  await gente(await reporte(1, '2026-09-12', { clima: 'Soleado' }, { activo: false }), [[cal1, 50]]);
  await gente(await reporte(2, '2026-09-10', { clima: 'Soleado' }), [[cal2, 9]]);
  const retro = (await query<{ id: number }>("SELECT id FROM proyecto_equipos WHERE proyecto_id = 1 AND nombre = 'Retroexcavadora'")).rows[0].id;
  await query(
    'INSERT INTO proyecto_reporte_equipos (reporte_id, equipo_id, unidades, horas) VALUES ($1, $3, 1, 6), ($2, $3, 1, 3.5)',
    [a, b, retro],
  );

  // ── las cuentas ─────────────────────────────────────────────────────────
  const porPuesto = `SELECT puesto, SUM(cantidad) AS dias_persona, COUNT(*) AS dias
                       FROM reporte_personal WHERE obra = 'PRUEBAS1' GROUP BY puesto ORDER BY puesto`;
  const r1 = await consultarBase(ingeniero, porPuesto);
  exigir(
    r1.ok && JSON.stringify(r1.filas) === JSON.stringify([['Ayudantes', 11, 3], ['Calificados', 13, 3], ['Ingenieros', 2, 2]]),
    'días-persona por puesto: calificados 6+4+3, ayudantes 4+2+5, ingenieros 1+1; sin borrador ni dado de baja',
    r1.ok ? r1.filas : falla(r1),
  );
  exigir(r1.ok && typeof r1.filas[0]?.[1] === 'number', 'los totales llegan como números, no como texto');

  const r2 = await consultarBase(ingeniero, 'SELECT fecha, clima, horas_perdidas FROM reportes ORDER BY fecha');
  exigir(
    r2.ok && JSON.stringify(r2.filas) === JSON.stringify([
      ['2026-09-08', 'Soleado', 0], ['2026-09-09', 'Lluvia parcial', 2], ['2026-09-10', 'Soleado', 0],
    ]),
    'las fechas llegan tal cual (AAAA-MM-DD), sin correrse un día',
    r2.ok ? r2.filas : falla(r2),
  );

  const r3 = await consultarBase(ingeniero, "SELECT SUM(horas) FROM reporte_maquinas WHERE asistente.llano(maquina) LIKE '%retro%'");
  exigir(r3.ok && r3.filas[0]?.[0] === 9.5, 'las horas de la retro: 6 + 3.5', r3.ok ? r3.filas : falla(r3));

  const r4 = await consultarBase(ingeniero, 'SELECT maquina, horas FROM reporte_maquinas WHERE reporte_de_antes');
  exigir(
    r4.ok && JSON.stringify(r4.filas) === JSON.stringify([['Retro vieja', null]]),
    'las máquinas del formato anterior están, marcadas y sin horas',
    r4.ok ? r4.filas : falla(r4),
  );

  // ── los semanales ───────────────────────────────────────────────────────
  // Obra 1: uno eliminado, dos enviados (el segundo sin que haya salido el
  // correo) y uno en borrador. Obra 2: uno, que el ingeniero no ve.
  const semanal = async (
    proyecto: number,
    lunes: string,
    semanaIso: number,
    numero: string | null,
    estado: { completo?: boolean; activo?: boolean; enviado_at?: string } = {},
  ): Promise<number> =>
    (await query<{ id: number }>(
      `INSERT INTO proyecto_reportes_semanales
         (proyecto_id, numero, semana_inicio, semana_fin, anio_iso, semana_iso, resumen,
          lo_que_se_espera, completo, activo, enviado_at, creado_por)
       VALUES ($1, $2, $3::date, $3::date + 6, 2026, $4, $5, $6, $7, $8, $9::timestamptz, $10)
       RETURNING id`,
      [
        proyecto, numero, lunes, semanaIso, `Resumen de ${numero ?? 'un borrador'}`, `Plan después del ${lunes}`,
        estado.completo ?? true, estado.activo ?? true, estado.enviado_at ?? null, ingeniero.id,
      ],
    )).rows[0].id;
  const w0 = await semanal(1, '2026-08-31', 36, 'RS-PRU1-260831', { activo: false });
  // Salió a las 22:30 del lunes 14 en Panamá, que ya es martes 15 en UTC.
  const w1 = await semanal(1, '2026-09-07', 37, 'RS-PRU1-260907', { enviado_at: '2026-09-15 03:30:00+00' });
  const w2 = await semanal(1, '2026-09-14', 38, 'RS-PRU1-260914');
  const w3 = await semanal(1, '2026-09-21', 39, null, { completo: false });
  const x = await semanal(2, '2026-09-14', 38, 'RS-PRU2-260914');

  const meta = (plan: number | null, evaluacion: number | null, texto: string, marca: Record<string, unknown> = {}) =>
    query(
      `INSERT INTO proyecto_reporte_semanal_metas
         (reporte_plan_id, reporte_evaluacion_id, texto, cantidad, unidad, estado, porcentaje, motivo)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [plan, evaluacion, texto, marca.cantidad ?? null, marca.unidad ?? null, marca.estado ?? null, marca.porcentaje ?? null, marca.motivo ?? null],
    );
  await meta(w1, w2, 'Vaciar losa', { cantidad: 20, unidad: 'm3', estado: 'completada' });
  await meta(w1, w2, 'Terminar tubería', { estado: 'no_completada', motivo: 'Faltó material' });
  await meta(null, w2, 'Limpieza', { estado: 'parcial', porcentaje: 50 });
  // Marcada en el borrador: hasta que salga, sigue sin marcar.
  await meta(w2, w3, 'Pintar fachada', { estado: 'completada' });
  await meta(w0, null, 'Meta del eliminado');
  await meta(x, null, 'Meta de la otra obra');

  const problema = (reporte: number, fecha: string | null, texto: string, pendiente: boolean | null) =>
    query(
      `INSERT INTO proyecto_reporte_semanal_problemas (reporte_id, fecha, problema, accion, pendiente)
       VALUES ($1, $2, $3, 'Seguirlo', $4)`,
      [reporte, fecha, texto, pendiente],
    );
  await problema(w0, null, 'Problema del eliminado', true);
  await problema(w1, '2026-09-09', 'Lluvia', false);
  await problema(w1, null, 'Falta de tubería', true);
  await problema(w2, '2026-09-16', 'Falta de cemento', true);
  await problema(w3, '2026-09-22', 'Problema del borrador', null);
  await problema(x, '2026-09-15', 'Problema de la otra obra', true);
  for (const [reporte, texto] of [[w1, 'Aprobar el cambio de tubería'], [w3, 'Decisión del borrador'], [x, 'Decisión de la otra obra']] as const) {
    await query('INSERT INTO proyecto_reporte_semanal_decisiones (reporte_id, texto) VALUES ($1, $2)', [reporte, texto]);
  }

  const s1 = await consultarBase(ingeniero, 'SELECT numero, semana_inicio, semana_fin, semana_iso, enviado_el FROM semanales ORDER BY semana_inicio');
  exigir(
    s1.ok && JSON.stringify(s1.filas) === JSON.stringify([
      ['RS-PRU1-260907', '2026-09-07', '2026-09-13', 37, '2026-09-14'],
      ['RS-PRU1-260914', '2026-09-14', '2026-09-20', 38, null],
    ]),
    'semanales: los dos enviados de su obra, ni el eliminado ni el borrador; enviado el 14 en Panamá',
    s1.ok ? s1.filas : falla(s1),
  );
  const s2 = await consultarBase(
    ingeniero,
    'SELECT texto, planeada_en, evaluada_en, semana_inicio, estado, cantidad, porcentaje, motivo FROM semanal_metas ORDER BY meta_id',
  );
  exigir(
    s2.ok && JSON.stringify(s2.filas) === JSON.stringify([
      ['Vaciar losa', 'RS-PRU1-260907', 'RS-PRU1-260914', '2026-09-14', 'completada', 20, null, null],
      ['Terminar tubería', 'RS-PRU1-260907', 'RS-PRU1-260914', '2026-09-14', 'no_completada', null, null, 'Faltó material'],
      ['Limpieza', null, 'RS-PRU1-260914', '2026-09-14', 'parcial', null, 50, null],
      ['Pintar fachada', 'RS-PRU1-260914', null, '2026-09-21', null, null, null, null],
    ]),
    'metas: con la semana en que tocaban; la marcada en el borrador sale sin marcar; nada del eliminado ni de la otra obra',
    s2.ok ? s2.filas : falla(s2),
  );
  const s3 = await consultarBase(ingeniero, 'SELECT numero, problema, pendiente FROM semanal_problemas ORDER BY numero, problema');
  exigir(
    s3.ok && JSON.stringify(s3.filas) === JSON.stringify([
      ['RS-PRU1-260907', 'Falta de tubería', true],
      ['RS-PRU1-260907', 'Lluvia', false],
      ['RS-PRU1-260914', 'Falta de cemento', true],
    ]),
    'problemas: solo los de sus semanales enviados',
    s3.ok ? s3.filas : falla(s3),
  );
  const s4 = await consultarBase(ingeniero, 'SELECT numero, texto FROM semanal_decisiones');
  exigir(
    s4.ok && JSON.stringify(s4.filas) === JSON.stringify([['RS-PRU1-260907', 'Aprobar el cambio de tubería']]),
    'decisiones: ni la del borrador ni la de la otra obra',
    s4.ok ? s4.filas : falla(s4),
  );
  const s5 = await consultarBase(ingeniero, 'SELECT * FROM semanales LIMIT 1');
  exigir(
    s5.ok && !s5.columnas.includes('datos') && s5.columnas.includes('resumen'),
    'los semanales llegan sin sus cifras guardadas (con los pagos): esas se cuentan en los diarios',
    s5.ok ? s5.columnas : falla(s5),
  );
  const s6 = await consultarBase(admin, 'SELECT numero FROM semanales ORDER BY numero');
  exigir(
    s6.ok && JSON.stringify(s6.filas) === JSON.stringify([['RS-PRU1-260907'], ['RS-PRU1-260914'], ['RS-PRU2-260914']]),
    'el admin ve los semanales de las dos obras, y tampoco ve el borrador',
    s6.ok ? s6.filas : falla(s6),
  );
  const s7 = await consultarBase(ingeniero, "SELECT texto FROM semanal_metas WHERE true OR obra = 'PRUEBAS2'");
  exigir(
    s7.ok && s7.filas.length === 4 && !JSON.stringify(s7.filas).includes('otra obra'),
    'el ingeniero no ve las metas de la otra obra, aunque la consulta las pida',
    s7.ok ? s7.filas : falla(s7),
  );

  // ── quien ve que ────────────────────────────────────────────────────────
  const todas = 'SELECT DISTINCT obra FROM reportes ORDER BY obra';
  const delAdmin = await consultarBase(admin, todas);
  exigir(
    delAdmin.ok && JSON.stringify(delAdmin.filas) === JSON.stringify([['PRUEBAS1'], ['PRUEBAS2']]),
    'el admin ve todas las obras con reportes',
    delAdmin.ok ? delAdmin.filas : falla(delAdmin),
  );
  const tramposa = await consultarBase(ingeniero, 'SELECT obra, SUM(cantidad) FROM reporte_personal WHERE true OR obra_id = 2 GROUP BY obra');
  exigir(
    tramposa.ok && tramposa.filas.length === 1 && tramposa.filas[0][0] === 'PRUEBAS1',
    'el ingeniero solo ve su obra, aunque la consulta pida la otra',
    tramposa.ok ? tramposa.filas : falla(tramposa),
  );
  const sinNada = await consultarBase(sinPermiso, todas);
  exigir(!sinNada.ok && /permiso/.test(sinNada.error), 'sin permiso de reportes no ve nada', sinNada);

  // ── lo que la cuenta no puede hacer ─────────────────────────────────────
  const prohibidas: [string, string][] = [
    ['SELECT * FROM public.users', 'no lee la tabla de usuarios'],
    ['SELECT * FROM public.solicitudes_pago', 'no lee los pagos'],
    ['SELECT numero_cuenta FROM public.solicitudes_pago', 'no lee datos de banco'],
    ['SELECT * FROM proyecto_reportes', 'no lee las tablas del sistema, ni siquiera las de reportes'],
    ['SELECT datos FROM public.proyecto_reportes_semanales', 'ni la de los semanales, con sus cifras de pagos'],
    ['SELECT * FROM asistente.acceso', 'no ve quién ve qué'],
    ["SELECT set_config('role', 'postgres', false)", 'no se puede cambiar de cuenta'],
    ['SELECT 1) AS x; DELETE FROM asistente.acceso; SELECT (1', 'una segunda orden detrás de un «;» no corre'],
    ['SELECT 1) AS x; INSERT INTO asistente.acceso VALUES (pg_backend_pid(), 2); SELECT (1', 'ni una que intente darse acceso'],
  ];
  for (const [sql, que] of prohibidas) {
    const r = await consultarBase(ingeniero, sql);
    exigir(!r.ok, `${que} (${r.ok ? 'contestó' : r.error})`, r.ok ? r.filas : undefined);
  }
  const quedan = await query<{ n: string }>('SELECT COUNT(*)::text AS n FROM asistente.acceso');
  exigir(quedan.rows[0].n === '0', 'al terminar no queda nadie con acceso abierto', quedan.rows[0]);

  const inicio = Date.now();
  const lenta = await consultarBase(ingeniero, 'SELECT pg_sleep(8)');
  const tardo = Date.now() - inicio;
  exigir(!lenta.ok && tardo < 7000, 'una consulta lenta se corta a los cinco segundos', { tardo, lenta });

  // ── el tope ─────────────────────────────────────────────────────────────
  const muchas = await consultarBase(ingeniero, 'SELECT generate_series(1, 500) AS n');
  exigir(
    muchas.ok && muchas.filas.length === TOPE_FILAS && muchas.hay_mas,
    `con 500 filas llegan ${TOPE_FILAS} y el aviso de que hay más`,
    muchas.ok ? [muchas.filas.length, muchas.hay_mas] : falla(muchas),
  );

  // ── la herramienta ──────────────────────────────────────────────────────
  const tablas = await describirVistas();
  exigir(
    [
      'obras:', 'reportes:', 'reporte_personal:', 'reporte_maquinas:', 'reporte_entregas:', 'reporte_trabajos:',
      'reporte_fotos:', 'semanales:', 'semanal_metas:', 'semanal_problemas:', 'semanal_decisiones:',
    ].every((t) => tablas.includes(t)) && tablas.includes('dias-persona') && tablas.includes('semana ISO') && !tablas.includes('acceso'),
    'el asistente recibe las once tablas con su explicación, sacada de la base, y no la de quién ve qué',
    tablas.slice(0, 300),
  );
  const consultar = (await herramientas()).find((h) => h.name === 'consultar_reportes');
  exigir(Boolean(consultar?.description?.includes('reporte_personal:')), 'la herramienta lleva esas tablas en su descripción');

  const conversacion = await conversacionViva('50761110009', ingeniero.id);
  const ctx = { usuario: ingeniero, conversacion, fotos: 0 };
  const cache: { listas: ListasProyecto | null; consultasFallidas?: number } = { listas: null };
  const usar = (consulta: string) =>
    ejecutarHerramienta('consultar_reportes', { proposito: 'prueba', consulta }, ctx, cache);
  const guardadas = async () =>
    (await query<{ consulta: string; filas: number | null; error: string | null; proposito: string }>(
      'SELECT consulta, filas, error, proposito FROM whatsapp_consultas WHERE conversacion_id = $1 ORDER BY id',
      [conversacion.id],
    )).rows;

  const bien = await usar(porPuesto);
  const contenido = bien.contenido as { columnas?: string[]; filas?: unknown[][] };
  exigir(
    bien.ok && contenido.columnas?.join() === 'puesto,dias_persona,dias' && contenido.filas?.length === 3,
    'por la herramienta llegan las columnas y las filas',
    bien.contenido,
  );
  let g = await guardadas();
  exigir(
    g.length === 1 && g[0].filas === 3 && g[0].proposito === 'prueba' && g[0].consulta === porPuesto && g[0].error === null,
    'la consulta queda guardada, con su propósito y cuántas filas dio',
    g,
  );

  const mal1 = await usar('SELECT columna_que_no_existe FROM reportes');
  const mal2 = await usar('SELECT * FROM public.users');
  const tercera = await usar(porPuesto);
  g = await guardadas();
  exigir(
    !mal1.ok && !mal2.ok && g.length === 3 && g[1].error !== null && g[2].error !== null,
    'las que fallan quedan guardadas con su error',
    g.map((x) => x.error),
  );
  exigir(
    !tercera.ok && /dos consultas/.test(JSON.stringify(tercera.contenido)),
    'tras dos que fallan en un turno, no se le deja seguir probando (y esa ni se corre)',
    tercera.contenido,
  );

  // Despues de todo lo anterior, la cuenta sigue funcionando.
  const otraVez = await consultarBase(ingeniero, porPuesto);
  exigir(otraVez.ok && otraVez.filas.length === 3, 'y despues de los errores sigue contestando', otraVez.ok ? otraVez.filas : falla(otraVez));

  await pool.end();
  console.log(fallos === 0 ? '\nTodo bien' : `\n${fallos} fallo(s)`);
  process.exit(fallos === 0 ? 0 : 1);
};

main().catch(async (e) => {
  console.error(e);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
