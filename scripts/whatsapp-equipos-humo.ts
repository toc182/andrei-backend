// Prueba de humo: el asistente de WhatsApp y el dueño de cada máquina.
// npm run pruebas -- whatsapp-equipos
//
// Desde la migración 176 cada máquina es de la cuadrilla propia (empresa null)
// o de una empresa de la obra, y puede haber dos con el mismo nombre. Se exige:
// - las listas que ve el asistente dicen de quién es cada máquina, qué
//   empresas tiene la obra y cómo se llama la cuadrilla propia;
// - una máquina nueva va de la empresa que dijo la persona, encontrada a su
//   manera («rodsa»); sin empresa, o nombrando a la propia, va de la propia;
// - una empresa que no es de la obra se rechaza para que el modelo pregunte;
// - «ya está» y «se parece» solo miran las máquinas del mismo dueño;
// - lo anotado dice de quién es la máquina cuando no es de la propia.
import { query, pool } from '../src/database/config.js';
import { conversacionViva } from '../src/services/whatsapp/conversacion.js';
import {
  ejecutarHerramienta,
  fijarObra,
  listasDe,
  type Usuario,
} from '../src/services/whatsapp/herramientas.js';
import { resumen, type ListasProyecto } from '../src/services/whatsapp/datosReporte.js';

let fallos = 0;
const exigir = (bien: boolean, que: string, visto?: unknown): void => {
  console.log(`${bien ? '  ok  ' : 'FALLA '} ${que}${bien || visto === undefined ? '' : ` → ${JSON.stringify(visto)}`}`);
  if (!bien) fallos += 1;
};

const main = async () => {
  const usuario = (
    await query<Usuario>(
      "SELECT id, nombre, rol FROM users WHERE email = 'aprobador1@pruebas.local'",
    )
  ).rows[0];
  await query(
    `INSERT INTO user_permissions (user_id, reportes) VALUES ($1, true)
     ON CONFLICT (user_id) DO UPDATE SET reportes = true`,
    [usuario.id],
  );
  await query(
    'INSERT INTO user_project_access (user_id, proyecto_id) VALUES ($1, 1) ON CONFLICT DO NOTHING',
    [usuario.id],
  );

  // Un subcontratista con su propia retro, además de la retro de la propia.
  const rodsa = (
    await query<{ id: number }>(
      "INSERT INTO proyecto_empresas (proyecto_id, nombre, orden) VALUES (1, 'RODSA', 1) RETURNING id",
    )
  ).rows[0].id;
  await query(
    "INSERT INTO proyecto_equipos (proyecto_id, nombre, empresa_id, orden) VALUES (1, 'Retroexcavadora', $1, 9)",
    [rodsa],
  );

  const conversacion = await conversacionViva('50761110003', usuario.id);
  await fijarObra(conversacion, 1);
  const ctx = { usuario, conversacion, fotos: 0 };
  const cache: { listas: ListasProyecto | null } = { listas: null };
  const usar = (nombre: string, input: unknown) => ejecutarHerramienta(nombre, input, ctx, cache);

  // ── lo que ve el asistente ──────────────────────────────────────────────
  const listas = await listasDe(1);
  const retros = listas.equipos.filter((e) => e.nombre === 'Retroexcavadora');
  exigir(
    retros.length === 2 && retros.some((e) => e.empresa === null) && retros.some((e) => e.empresa === 'RODSA'),
    'las dos retros salen en la lista, cada una con su dueño',
    retros,
  );
  exigir(
    listas.propio === 'Pinellas' && (listas.empresas ?? []).some((e) => e.nombre === 'RODSA'),
    'y la lista trae las empresas de la obra y el nombre de la cuadrilla propia',
    { propio: listas.propio, empresas: listas.empresas },
  );

  // ── máquinas nuevas ─────────────────────────────────────────────────────
  const duena = async (nombre: string): Promise<(number | null)[]> =>
    (
      await query<{ empresa_id: number | null }>(
        'SELECT empresa_id FROM proyecto_equipos WHERE proyecto_id = 1 AND nombre = $1 AND activo ORDER BY id',
        [nombre],
      )
    ).rows.map((r) => r.empresa_id);

  const deRodsa = await usar('agregar_equipo', { nombre: 'Minicargador', empresa: 'rodsa' });
  exigir(deRodsa.ok && JSON.stringify(await duena('Minicargador')) === JSON.stringify([rodsa]), '«el minicargador de rodsa» entra como de RODSA');
  const propio = await usar('agregar_equipo', { nombre: 'Minicargador' });
  exigir(
    propio.ok && JSON.stringify(await duena('Minicargador')) === JSON.stringify([rodsa, null]),
    'sin decir de quién es, va de la propia, aunque RODSA tenga uno igual',
  );
  const dePinellas = await usar('agregar_equipo', { nombre: 'Compresor', empresa: 'Pinellas' });
  exigir(dePinellas.ok && JSON.stringify(await duena('Compresor')) === JSON.stringify([null]), 'nombrando a la propia, va de la propia');

  const ajena = await usar('agregar_equipo', { nombre: 'Grúa torre', empresa: 'Constructora Pérez' });
  exigir(!ajena.ok && JSON.stringify(ajena.contenido).includes('no es una de las empresas'), 'una empresa que no es de la obra se rechaza para que pregunte');

  const repetida = await usar('agregar_equipo', { nombre: 'Retroexcavadora', empresa: 'RODSA' });
  exigir(!repetida.ok && JSON.stringify(repetida.contenido).includes('ya está en la lista'), 'la retro de RODSA ya está: no se agrega otra');

  // ── lo anotado dice de quién es ─────────────────────────────────────────
  const listasAhora = await listasDe(1);
  const retroRodsa = listasAhora.equipos.find((e) => e.nombre === 'Retroexcavadora' && e.empresa === 'RODSA')!;
  const retroPropia = listasAhora.equipos.find((e) => e.nombre === 'Retroexcavadora' && e.empresa === null)!;
  const anotado = await usar('anotar', {
    equipos: [
      { equipo_id: retroRodsa.id, horas: 6 },
      { equipo_id: retroPropia.id, horas: 3 },
    ],
  });
  const texto = resumen(conversacion.datos, listasAhora, 0);
  exigir(
    anotado.ok && texto.includes('Retroexcavadora (RODSA) 6 h') && texto.includes('Retroexcavadora 3 h'),
    'lo anotado dice de quién es la retro que no es de la propia',
    texto,
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
