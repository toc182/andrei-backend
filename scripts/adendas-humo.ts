// Prueba de humo: las adendas de un proyecto (migración 184).
// cd andrei-backend && npm run pruebas -- adendas
//
// Ivan, 2026-10-03 al 2026-10-07: una adenda lleva UN monto, con ITBMS y en
// negativo si reduce el contrato; borrarla la esconde; cada cambio queda en la
// historia; solo quien tiene acceso al proyecto ve y toca sus adendas. Se exige:
// - crear de cada tipo, y que cada tipo guarde solo lo suyo;
// - rechazar con 400 lo que no cuadra (sin tipo, sin monto, monto cero, fecha
//   inexistente);
// - la fecha de aprobación es la de hoy en Panamá al pasar a aprobada, se va al
//   dejar de estarlo, y una aprobada de antes sin fecha no se fecha al editarla;
// - editar cambia solo lo que vino;
// - borrar esconde, la lista no la trae y el número no se vuelve a usar;
// - cinco creadas a la vez salen con cinco números distintos;
// - alguien con acceso solo al proyecto 1 no ve ni toca las del proyecto 3;
// - la migración 184 pasa bien las adendas escritas con las dos casillas viejas.
import { API } from './pruebas/contexto.js';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { query, pool } from '../src/database/config.js';

interface Usuario {
  id: number;
  email: string;
  rol: string;
}
interface Adenda {
  id: number;
  numero_adenda: number;
  tipo: string;
  estado: string;
  nueva_fecha_fin: string | null;
  dias_extension: number | null;
  monto: string | null;
  observaciones: string | null;
  fecha_aprobacion: string | null;
}

const main = async () => {
  const admin = (
    await query<Usuario>("SELECT id, email, rol FROM users WHERE rol='admin' AND activo=true ORDER BY id LIMIT 1")
  ).rows[0];
  const ingeniero = (
    await query<Usuario>("SELECT id, email, rol FROM users WHERE email = 'aprobador1@pruebas.local'")
  ).rows[0];
  await query('INSERT INTO user_project_access (user_id, proyecto_id) VALUES ($1, 1) ON CONFLICT DO NOTHING', [ingeniero.id]);
  const hoy = (await query<{ d: string }>(
    "SELECT to_char((now() AT TIME ZONE 'America/Panama')::date, 'YYYY-MM-DD') AS d",
  )).rows[0].d;

  const firmar = (u: Usuario) =>
    jwt.sign({ userId: u.id, email: u.email, rol: u.rol }, process.env.JWT_SECRET!, { expiresIn: '10m' });
  const pedir = async (u: Usuario, metodo: string, ruta: string, cuerpo?: unknown) => {
    const res = await fetch(`${API}${ruta}`, {
      method: metodo,
      headers: { Authorization: `Bearer ${firmar(u)}`, 'Content-Type': 'application/json' },
      body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
    });
    const texto = await res.text();
    let json: { data?: unknown; message?: string } = {};
    try {
      json = JSON.parse(texto);
    } catch {
      /* no era JSON */
    }
    return { estado: res.status, json, texto };
  };

  let ok = 0;
  let fallo = 0;
  const c = (cond: boolean, etq: string) => {
    if (cond) ok += 1;
    else {
      fallo += 1;
      console.log('FALLA ', etq);
    }
  };

  // --- Crear, de cada tipo
  const costo = await pedir(admin, 'POST', '/adendas/project/1', {
    tipo: 'costo', monto: '-25000.50', nueva_fecha_fin: '2027-01-01', dias_extension: 30, observaciones: '  Quita la caseta  ',
  });
  const aCosto = costo.json.data as Adenda;
  c(costo.estado === 201, `crea una de costo (dio ${costo.estado} ${costo.texto})`);
  c(aCosto?.numero_adenda === 1, 'la primera del proyecto es la 1');
  c(aCosto?.monto === '-25000.50', `el monto va con signo y dos decimales (dio ${aCosto?.monto})`);
  c(aCosto?.nueva_fecha_fin === null && aCosto?.dias_extension === null, 'una de costo no guarda fecha ni días');
  c(aCosto?.observaciones === 'Quita la caseta', 'las observaciones van sin espacios de sobra');
  c(aCosto?.estado === 'en_proceso' && aCosto?.fecha_aprobacion === null, 'nace en proceso y sin fecha de aprobación');

  const tiempo = await pedir(admin, 'POST', '/adendas/project/1', {
    tipo: 'tiempo', nueva_fecha_fin: '2027-07-31', dias_extension: 563, monto: 1000,
  });
  const aTiempo = tiempo.json.data as Adenda;
  c(tiempo.estado === 201 && aTiempo.numero_adenda === 2, `crea una de tiempo, la 2 (dio ${tiempo.estado})`);
  c(aTiempo?.monto === null, 'una de tiempo no guarda monto aunque venga');
  c(aTiempo?.dias_extension === 563 && aTiempo?.nueva_fecha_fin === '2027-07-31', 'guarda los días como se escribieron y la fecha');

  const mixta = await pedir(admin, 'POST', '/adendas/project/1', {
    tipo: 'mixta', estado: 'aprobada', nueva_fecha_fin: '2027-08-31', monto: 150000,
  });
  const aMixta = mixta.json.data as Adenda;
  c(mixta.estado === 201 && aMixta.numero_adenda === 3, `crea una de tiempo y costo, la 3 (dio ${mixta.estado})`);
  c(aMixta?.monto === '150000.00', `con su monto (dio ${aMixta?.monto})`);
  c(aMixta?.fecha_aprobacion === hoy, `creada aprobada lleva la fecha de hoy en Panamá (dio ${aMixta?.fecha_aprobacion}, hoy ${hoy})`);

  // --- Lo que no cuadra
  for (const [cuerpo, que] of [
    [{ monto: 100 }, 'sin tipo'],
    [{ tipo: 'costo' }, 'de costo sin monto'],
    [{ tipo: 'costo', monto: 0 }, 'con monto cero'],
    [{ tipo: 'costo', monto: 'abc' }, 'con monto que no es número'],
    [{ tipo: 'mixta', monto: 10 }, 'de tiempo y costo sin fecha'],
    [{ tipo: 'tiempo', nueva_fecha_fin: '2026-02-30' }, 'con una fecha que no existe'],
    [{ tipo: 'tiempo', nueva_fecha_fin: '2026-03-01', dias_extension: 2.5 }, 'con días que no son enteros'],
    [{ tipo: 'otra', monto: 10 }, 'de un tipo que no existe'],
  ] as const) {
    const r = await pedir(admin, 'POST', '/adendas/project/1', cuerpo);
    c(r.estado === 400, `${que}: 400 (dio ${r.estado})`);
  }
  const cuantas = await query<{ n: string }>('SELECT COUNT(*)::text AS n FROM adendas WHERE proyecto_id = 1');
  c(cuantas.rows[0].n === '3', 'y ninguna de esas quedó guardada');

  // --- Editar solo lo que vino
  const obs = await pedir(admin, 'PUT', `/adendas/project/1/${aCosto.id}`, { observaciones: 'Caseta de vigilancia' });
  const trasObs = obs.json.data as Adenda;
  c(obs.estado === 200 && trasObs.observaciones === 'Caseta de vigilancia', `edita las observaciones (dio ${obs.estado})`);
  c(trasObs?.monto === '-25000.50' && trasObs?.tipo === 'costo', 'y el resto se queda como estaba');
  const historia = await query<{ detalles: { antes: Adenda; despues: Adenda } }>(
    "SELECT detalles FROM audit_log WHERE entidad = 'adenda' AND entidad_id = $1 AND accion = 'editar'",
    [aCosto.id],
  );
  c(
    historia.rows.length === 1 &&
      historia.rows[0].detalles.antes.observaciones === 'Quita la caseta' &&
      historia.rows[0].detalles.despues.observaciones === 'Caseta de vigilancia',
    'el cambio queda en la historia con el antes y el después',
  );
  const igual = await pedir(admin, 'PUT', `/adendas/project/1/${aCosto.id}`, { monto: '-25000.5' });
  c(igual.estado === 200, 'guardar el mismo monto escrito de otra forma no falla');
  const historia2 = await query('SELECT 1 FROM audit_log WHERE entidad = $1 AND entidad_id = $2 AND accion = $3', ['adenda', aCosto.id, 'editar']);
  c(historia2.rows.length === 1, 'y no deja una línea en la historia porque no cambió nada');

  const aTiempoSolo = await pedir(admin, 'PUT', `/adendas/project/1/${aMixta.id}`, { tipo: 'tiempo' });
  c((aTiempoSolo.json.data as Adenda)?.monto === null, 'pasar de tiempo y costo a tiempo suelta el monto');
  const sinFecha = await pedir(admin, 'PUT', `/adendas/project/1/${aTiempo.id}`, { tipo: 'costo' });
  c(sinFecha.estado === 400, `pasar a costo sin poner monto: 400 (dio ${sinFecha.estado})`);

  // --- Fecha de aprobación
  const aprobar = await pedir(admin, 'PUT', `/adendas/project/1/${aCosto.id}`, { estado: 'aprobada' });
  c((aprobar.json.data as Adenda)?.fecha_aprobacion === hoy, 'al aprobarla queda con la fecha de hoy en Panamá');
  const conFecha = await pedir(admin, 'PUT', `/adendas/project/1/${aTiempo.id}`, { estado: 'aprobada', fecha_aprobacion: '2026-07-02' });
  c((conFecha.json.data as Adenda)?.fecha_aprobacion === '2026-07-02', 'o con la que se diga');
  const desaprobar = await pedir(admin, 'PUT', `/adendas/project/1/${aCosto.id}`, { estado: 'en_proceso' });
  c((desaprobar.json.data as Adenda)?.fecha_aprobacion === null, 'al dejar de estar aprobada pierde la fecha');
  const vieja = (await query<{ id: number }>(
    `INSERT INTO adendas (proyecto_id, numero_adenda, tipo, estado, nueva_fecha_fin, fecha_solicitud)
     VALUES (1, 50, 'tiempo', 'aprobada', '2026-05-22', '2026-05-27') RETURNING id`,
  )).rows[0].id;
  const editarVieja = await pedir(admin, 'PUT', `/adendas/project/1/${vieja}`, { observaciones: 'De antes' });
  c(
    editarVieja.estado === 200 && (editarVieja.json.data as Adenda).fecha_aprobacion === null,
    'una aprobada de antes, sin fecha, no se fecha al editarla',
  );

  // --- Borrar esconde
  const borrar = await pedir(admin, 'DELETE', `/adendas/project/1/${vieja}`);
  c(borrar.estado === 200, `borra (dio ${borrar.estado})`);
  const sigue = await query<{ activo: boolean }>('SELECT activo FROM adendas WHERE id = $1', [vieja]);
  c(sigue.rows.length === 1 && sigue.rows[0].activo === false, 'la adenda sigue en la base, escondida');
  const lista = await pedir(admin, 'GET', '/adendas/project/1');
  const nums = ((lista.json.data as Adenda[]) ?? []).map((a) => a.numero_adenda);
  c(lista.estado === 200 && !nums.includes(50) && nums.join(',') === '1,2,3', `la lista no la trae (trae ${nums.join(',')})`);
  const otraVez = await pedir(admin, 'DELETE', `/adendas/project/1/${vieja}`);
  c(otraVez.estado === 404, `borrarla otra vez: 404 (dio ${otraVez.estado})`);
  const editarBorrada = await pedir(admin, 'PUT', `/adendas/project/1/${vieja}`, { observaciones: 'x' });
  c(editarBorrada.estado === 404, `editar una borrada: 404 (dio ${editarBorrada.estado})`);
  const borroEnHistoria = await query('SELECT 1 FROM audit_log WHERE entidad = $1 AND entidad_id = $2 AND accion = $3', ['adenda', vieja, 'eliminar']);
  c(borroEnHistoria.rows.length === 1, 'el borrado queda en la historia');
  const siguiente = await pedir(admin, 'POST', '/adendas/project/1', { tipo: 'costo', monto: 1 });
  c((siguiente.json.data as Adenda)?.numero_adenda === 51, 'la siguiente no reusa el número de la borrada');

  // --- Cinco a la vez
  const aLaVez = await Promise.all(
    [1, 2, 3, 4, 5].map((i) => pedir(admin, 'POST', '/adendas/project/2', { tipo: 'costo', monto: i })),
  );
  const numeros = aLaVez.map((r) => (r.json.data as Adenda)?.numero_adenda).sort((a, b) => a - b);
  c(aLaVez.every((r) => r.estado === 201) && numeros.join(',') === '1,2,3,4,5', `cinco a la vez: 1 a 5 (dio ${numeros.join(',')})`);

  // --- El contrato vigente, igual en todas las pantallas (migración 185)
  // Proyecto 2: contrato de 1,000,000.00 hasta el 31/1/2027, con las cinco de
  // costo de arriba (montos 1 a 5) en proceso.
  await query("UPDATE proyectos SET monto_total = 1000000, fecha_fin_estimada = '2027-01-31' WHERE id = 2");
  const delDos = ((await pedir(admin, 'GET', '/adendas/project/2')).json.data as Adenda[]) ?? [];
  const sinAdendas = (await pedir(admin, 'GET', '/projects/2')).json as { proyecto?: Record<string, unknown> };
  c(
    sinAdendas.proyecto?.monto_vigente === '1000000.00' && sinAdendas.proyecto?.fecha_fin_vigente === '2027-01-31' &&
      sinAdendas.proyecto?.adenda_fecha_numero === null,
    'sin adendas aprobadas, el vigente es el contrato y su terminación',
  );
  for (const a of delDos.filter((x) => x.monto === '1.00' || x.monto === '2.00')) {
    await pedir(admin, 'PUT', `/adendas/project/2/${a.id}`, { estado: 'aprobada' });
  }
  await pedir(admin, 'POST', '/adendas/project/2', { tipo: 'tiempo', estado: 'aprobada', nueva_fecha_fin: '2027-03-31' });
  const corta = await pedir(admin, 'POST', '/adendas/project/2', { tipo: 'tiempo', estado: 'aprobada', nueva_fecha_fin: '2027-02-28' });
  await pedir(admin, 'POST', '/adendas/project/2', { tipo: 'tiempo', nueva_fecha_fin: '2028-01-01' });
  const reducir = await pedir(admin, 'POST', '/adendas/project/2', { tipo: 'mixta', estado: 'aprobada', nueva_fecha_fin: '2027-02-28', monto: '-0.50' });
  const numCorta = (corta.json.data as Adenda).numero_adenda;
  await pedir(admin, 'DELETE', `/adendas/project/2/${(reducir.json.data as Adenda).id}`);

  const proyecto = (await pedir(admin, 'GET', '/projects/2')).json as { proyecto?: Record<string, unknown> };
  const pv = proyecto.proyecto ?? {};
  c(pv.monto_vigente === '1000003.00', `monto vigente = contrato + las aprobadas, sin las en proceso ni la borrada (dio ${pv.monto_vigente})`);
  c(pv.monto_adendas === '3.00' && pv.adendas_con_monto === 2, `lo que suman y cuántas (dio ${pv.monto_adendas}, ${pv.adendas_con_monto})`);
  c(pv.fecha_fin_vigente === '2027-02-28', `la terminación es la de la ÚLTIMA aprobada, aunque acorte (dio ${pv.fecha_fin_vigente})`);
  c(pv.adenda_fecha_numero === numCorta, `y dice qué adenda la fijó (dio ${pv.adenda_fecha_numero}, esperaba ${numCorta})`);
  c(pv.monto_total === '1000000.00' && pv.fecha_fin_estimada === '2027-01-31', 'el contrato original no se toca');

  const listaProyectos = (await pedir(admin, 'GET', '/projects?limit=50')).json as { proyectos?: Record<string, unknown>[] };
  const enLista = listaProyectos.proyectos?.find((x) => x.id === 2);
  c(enLista?.monto_vigente === '1000003.00' && enLista?.fecha_fin_vigente === '2027-02-28', 'la lista de proyectos trae lo mismo');

  const costos = (await pedir(admin, 'GET', '/costs/projects/2/resumen')).json as {
    data?: { contrato: number | null; fechas: { fin: string | null } };
  };
  c(costos.data?.contrato === 1000003 && costos.data?.fechas.fin === '2027-02-28', `Control de Costos usa el vigente (dio ${costos.data?.contrato}, ${costos.data?.fechas.fin})`);

  const cuentaId = (await query<{ id: number }>(
    'INSERT INTO cuentas (proyecto_id, numero, monto_total, creado_por) VALUES (2, 1, 1000, $1) RETURNING id',
    [admin.id],
  )).rows[0].id;
  const cuenta = (await pedir(admin, 'GET', `/cuentas/${cuentaId}`)).json as { data?: { proyecto_monto_total: string | null } };
  c(cuenta.data?.proyecto_monto_total === '1000003.00', `Cuentas usa el vigente (dio ${cuenta.data?.proyecto_monto_total})`);
  const cuentas = (await pedir(admin, 'GET', '/cuentas?proyecto_id=2')).json as { data?: { proyecto_monto_total: string | null }[] };
  c(cuentas.data?.[0]?.proyecto_monto_total === '1000003.00', 'y su lista también');

  // --- Acceso
  const delTres = await pedir(admin, 'POST', '/adendas/project/3', { tipo: 'costo', monto: 10 });
  const aDelTres = delTres.json.data as Adenda;
  for (const [metodo, ruta, cuerpo, que] of [
    ['GET', '/adendas/project/3', undefined, 'verlas'],
    ['POST', '/adendas/project/3', { tipo: 'costo', monto: 5 }, 'crear una'],
    ['PUT', `/adendas/project/3/${aDelTres.id}`, { observaciones: 'x' }, 'editar una'],
    ['DELETE', `/adendas/project/3/${aDelTres.id}`, undefined, 'borrar una'],
  ] as const) {
    const r = await pedir(ingeniero, metodo, ruta, cuerpo);
    c(r.estado === 403, `sin acceso al proyecto 3, ${que}: 403 (dio ${r.estado})`);
  }
  const porOtroLado = await pedir(ingeniero, 'PUT', `/adendas/project/1/${aDelTres.id}`, { observaciones: 'x' });
  c(porOtroLado.estado === 404, `la del proyecto 3 pedida por el proyecto 1: 404 (dio ${porOtroLado.estado})`);
  const intacta = await query<{ observaciones: string | null; activo: boolean }>('SELECT observaciones, activo FROM adendas WHERE id = $1', [aDelTres.id]);
  c(intacta.rows[0].observaciones === null && intacta.rows[0].activo, 'y quedó intacta');
  const lasSuyas = await pedir(ingeniero, 'GET', '/adendas/project/1');
  c(lasSuyas.estado === 200 && (lasSuyas.json.data as Adenda[]).length === 4, `las del proyecto 1 sí las ve (dio ${lasSuyas.estado})`);

  // --- La migración 184 sobre adendas escritas a la manera de antes
  // Se devuelve la tabla a la forma de la 183, se escriben adendas como las
  // dejaba el formulario viejo y se corre el archivo de la migración tal cual.
  // Las de arriba se quitan primero: con la forma de la 183 no se pueden
  // escribir (ya no tienen dónde guardar su monto). Todo se deshace al final.
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query(`
      DELETE FROM adendas;
      DROP VIEW proyecto_contrato_vigente;
      ALTER TABLE adendas DROP CONSTRAINT adendas_campos_por_tipo;
      ALTER TABLE adendas ADD COLUMN nuevo_monto DECIMAL(15,2), ADD COLUMN monto_adicional DECIMAL(15,2);
      ALTER TABLE adendas DROP COLUMN monto, DROP COLUMN activo;
      UPDATE proyectos SET monto_total = 3000000 WHERE id = 3;
      INSERT INTO adendas (proyecto_id, numero_adenda, tipo, estado, nueva_fecha_fin, dias_extension, nuevo_monto, monto_adicional, fecha_solicitud) VALUES
        (3, 1, 'costo',  'aprobada',   NULL,         NULL, 3150000, 150000, '2026-01-01'),
        (3, 2, 'costo',  'aprobada',   NULL,         NULL, 3100000, NULL,   '2026-02-01'),
        (3, 3, 'mixta',  'en_proceso', '2027-01-01', 30,   NULL,    NULL,   '2026-03-01'),
        (3, 4, 'mixta',  'en_proceso', NULL,         NULL, NULL,    500,    '2026-04-01'),
        (3, 5, 'tiempo', 'aprobada',   '2027-02-01', 31,   NULL,    700,    '2026-05-01'),
        (3, 6, 'tiempo', 'aprobada',   '2027-03-01', 28,   NULL,    NULL,   '2026-06-01');
    `);
    const raiz = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
    await db.query(fs.readFileSync(path.join(raiz, 'database/migrations/184_adendas_monto.sql'), 'utf8'));
    // La vista del contrato vigente (185) depende de las columnas nuevas: se
    // quitó para volver a la 183 y se vuelve a crear con su propio archivo.
    await db.query(fs.readFileSync(path.join(raiz, 'database/migrations/185_proyecto_contrato_vigente.sql'), 'utf8'));
    const r = await db.query<{ numero_adenda: number; tipo: string; monto: string | null; nueva_fecha_fin: string | null; dias_extension: number | null; activo: boolean }>(
      `SELECT numero_adenda, tipo, monto::text AS monto, to_char(nueva_fecha_fin, 'YYYY-MM-DD') AS nueva_fecha_fin, dias_extension, activo
         FROM adendas WHERE proyecto_id = 3 ORDER BY numero_adenda`,
    );
    const por = new Map(r.rows.map((x) => [x.numero_adenda, x]));
    c(por.get(1)?.monto === '150000.00', `con las dos casillas, vale el adicional (dio ${por.get(1)?.monto})`);
    c(por.get(2)?.monto === '-50000.00', `solo con nuevo total, la diferencia con contrato + aprobadas de antes (dio ${por.get(2)?.monto})`);
    c(por.get(3)?.tipo === 'tiempo' && por.get(3)?.monto === null && por.get(3)?.dias_extension === 30, 'tiempo y costo sin monto queda de tiempo');
    c(por.get(4)?.tipo === 'costo' && por.get(4)?.monto === '500.00', 'tiempo y costo sin fecha queda de costo');
    c(por.get(5)?.tipo === 'mixta' && por.get(5)?.monto === '700.00' && por.get(5)?.nueva_fecha_fin === '2027-02-01', 'de tiempo con monto queda de tiempo y costo, sin perder nada');
    c(por.get(6)?.tipo === 'tiempo' && por.get(6)?.monto === null, 'la de tiempo normal se queda igual');
    c(r.rows.every((x) => x.activo), 'todas quedan visibles');
    const cols = await db.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'adendas' AND column_name IN ('nuevo_monto', 'monto_adicional')");
    c(cols.rows.length === 0, 'las dos casillas viejas ya no existen');
    const vig = await db.query<{ monto_vigente: string; fecha: string; numero: number }>(
      `SELECT monto_vigente::text, to_char(fecha_fin_vigente, 'YYYY-MM-DD') AS fecha, adenda_fecha_numero AS numero
         FROM proyecto_contrato_vigente WHERE proyecto_id = 3`,
    );
    c(
      vig.rows[0]?.monto_vigente === '3100700.00' && vig.rows[0]?.fecha === '2027-03-01' && vig.rows[0]?.numero === 6,
      `y el contrato vigente cuadra con lo pasado (dio ${JSON.stringify(vig.rows[0])})`,
    );
  } catch (e) {
    c(false, `la migración 184 corrió sin error (${(e as Error).message})`);
  } finally {
    await db.query('ROLLBACK');
    db.release();
  }

  console.log(`${ok} pasaron, ${fallo} fallaron`);
  await pool.end();
  // Sin process.exit: ver aprobar-clave-humo.ts (Node en Windows revienta si se
  // corta con las conexiones cerrándose).
  process.exitCode = fallo ? 1 : 0;
};

main();
