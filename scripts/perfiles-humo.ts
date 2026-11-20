// Prueba de humo: perfiles de permisos (migración 190), paso 1 de la
// Administración nueva. cd andrei-backend && npm run pruebas -- perfiles
//
// La regla de Ivan (2026-11-18): cómo se ven y se asignan los permisos no
// cambia lo que nadie puede hacer. Un perfil solo llena las llaves de la
// persona en user_permissions, que es lo que el sistema revisa siempre. Se
// prueba que:
//   * solo admin y co-admin manejan perfiles;
//   * un perfil solo da llaves de perfil (ni acceso_global ni inventadas);
//   * asignarlo deja las llaves de la persona IGUALES a las del perfil y no toca
//     acceso_global, proyectos_eliminar ni oportunidades_ver;
//   * cambiar el perfil lo cambia para todos los que lo tienen;
//   * guardar como la pantalla vieja (todas las llaves) da lo mismo que antes, y
//     cambiar una llave pasa a la persona a «Personalizado»;
//   * guardar solo algunas llaves no toca las demás;
//   * Gerencia y el dueño no llevan perfil;
//   * quitar un perfil deja a sus personas con las mismas llaves.
//
// Crea sus propios usuarios y datos: la semilla es de todas las pruebas.
import { API } from './pruebas/contexto.js';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { query, pool } from '../src/database/config.js';
import { LLAVES_DE_PERFIL } from '../src/services/perfiles.js';
import { VALID_PERMISSIONS } from '../src/middleware/auth.js';

interface Usuario {
  id: number;
  email: string;
  rol: string;
}

type Llaves = Record<string, boolean | null>;

const main = async () => {
  let ok = 0;
  let fallo = 0;
  const c = (cond: boolean, etq: string) => {
    if (cond) ok += 1;
    else {
      fallo += 1;
      console.log('FALLA ', etq);
    }
  };

  const firmar = (u: Usuario) =>
    jwt.sign({ userId: u.id, email: u.email, rol: u.rol }, process.env.JWT_SECRET!, {
      expiresIn: '10m',
    });

  const pedir = async (metodo: string, ruta: string, quien: Usuario, cuerpo?: unknown) => {
    const res = await fetch(`${API}${ruta}`, {
      method: metodo,
      headers: {
        Authorization: `Bearer ${firmar(quien)}`,
        ...(cuerpo !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(cuerpo !== undefined ? { body: JSON.stringify(cuerpo) } : {}),
    });
    return { estado: res.status, cuerpo: await res.json().catch(() => null) };
  };

  const marca = randomUUID().slice(0, 8);
  const crearUsuario = async (nombre: string, rol: string): Promise<Usuario> =>
    (
      await query<Usuario>(
        `INSERT INTO users (nombre, email, rol, tipo_usuario)
         VALUES ($1, $2, $3, 'interno') RETURNING id, email, rol`,
        [nombre, `${nombre.toLowerCase().replace(/\s+/g, '.')}.${marca}@pruebas.local`, rol],
      )
    ).rows[0];

  const darPermisos = async (u: Usuario, permisos: string[]) => {
    const columnas = ['user_id', ...permisos];
    await query(
      `INSERT INTO user_permissions (${columnas.join(', ')})
       VALUES ($1${permisos.map(() => ', true').join('')})
       ON CONFLICT (user_id) DO UPDATE SET ${permisos.map((p) => `${p} = true`).join(', ')}`,
      [u.id],
    );
  };

  const llavesDe = async (u: Usuario): Promise<Llaves> =>
    (await query<Llaves>(`SELECT ${VALID_PERMISSIONS.join(', ')} FROM user_permissions WHERE user_id = $1`, [u.id]))
      .rows[0];
  const perfilDe = async (u: Usuario): Promise<number | null> =>
    (await query<{ p: number | null }>('SELECT permission_profile_id AS p FROM users WHERE id = $1', [u.id])).rows[0].p;
  // Lo que manda la pantalla vieja: todas las llaves, como booleanos.
  const comoPantallaVieja = (ll: Llaves) =>
    Object.fromEntries(VALID_PERMISSIONS.map((k) => [k, ll[k] ?? (k === 'equipos_ver')]));
  // ¿Las llaves de perfil son exactamente estas?
  const soloEstas = (ll: Llaves, dadas: string[]) =>
    LLAVES_DE_PERFIL.every((k) => (ll[k] ?? false) === dadas.includes(k));

  const admin = await crearUsuario('Dueño Perfiles', 'admin');
  const coadmin = await crearUsuario('Gerencia Perfiles', 'co-admin');
  const comun = await crearUsuario('Comun Perfiles', 'usuario');
  const martina = await crearUsuario('Martina Perfiles', 'usuario');
  const lisbeth = await crearUsuario('Lisbeth Perfiles', 'usuario');
  const daniel = await crearUsuario('Daniel Perfiles', 'usuario');
  await darPermisos(comun, ['reportes']);
  // Martina trae llaves de antes, incluidas las tres que un perfil no toca.
  await darPermisos(martina, ['reportes', 'cuentas', 'acceso_global', 'proyectos_eliminar', 'oportunidades_ver']);
  await darPermisos(lisbeth, ['cotizaciones']);
  await darPermisos(daniel, ['caja_menuda', 'cuentas']);

  // --- quién maneja perfiles
  const nombreCompras = `Compras ${marca}`;
  c((await pedir('GET', '/permission-profiles', comun)).estado === 403, 'un usuario no ve los perfiles');
  c((await pedir('POST', '/permission-profiles', comun, { nombre: 'X', llaves: [] })).estado === 403,
    'un usuario no crea perfiles');

  // --- crear: solo llaves de perfil, nombre único
  const malas = [
    { nombre: `Malo ${marca}`, llaves: ['acceso_global'] },
    { nombre: `Malo ${marca}`, llaves: ['inventada'] },
    { nombre: `Malo ${marca}`, llaves: 'reportes' },
    { nombre: 'X', llaves: [] },
  ];
  for (const m of malas) {
    const r = await pedir('POST', '/permission-profiles', admin, m);
    c(r.estado === 400, `perfil inválido rechazado: ${JSON.stringify(m.llaves)} / «${m.nombre}» (dio ${r.estado})`);
  }
  const creado = await pedir('POST', '/permission-profiles', admin, {
    nombre: nombreCompras,
    descripcion: 'Cotiza y compra',
    llaves: ['solicitudes_ver', 'ordenes_ver'],
  });
  c(creado.estado === 201, `admin crea un perfil (dio ${creado.estado})`);
  const compras = creado.cuerpo?.data?.id as number;
  const repetido = await pedir('POST', '/permission-profiles', coadmin, {
    nombre: nombreCompras.toUpperCase(),
    llaves: [],
  });
  c(repetido.estado === 400, `no hay dos perfiles con el mismo nombre (dio ${repetido.estado})`);
  const deGerencia = await pedir('POST', '/permission-profiles', coadmin, { nombre: `Asistente ${marca}`, llaves: ['caja_menuda'] });
  c(deGerencia.estado === 201, `co-admin crea perfiles (dio ${deGerencia.estado})`);
  const asistente = deGerencia.cuerpo?.data?.id as number;
  const rastroCrear = await query(
    "SELECT 1 FROM audit_log WHERE accion = 'crear' AND entidad = 'perfil_permisos' AND entidad_id = $1",
    [compras],
  );
  c(rastroCrear.rows.length === 1, 'crear un perfil deja rastro');

  // --- asignar: las llaves de la persona = las del perfil; las otras tres, igual
  const asignar = await pedir('PUT', `/permissions/${martina.id}`, admin, { permission_profile_id: compras });
  c(asignar.estado === 200, `asignar el perfil (dio ${asignar.estado})`);
  let m = await llavesDe(martina);
  c(soloEstas(m, ['solicitudes_ver', 'ordenes_ver']), 'Martina queda con exactamente las llaves del perfil');
  c(m.acceso_global === true && m.proyectos_eliminar === true && m.oportunidades_ver === true,
    'asignar un perfil no toca acceso_global, proyectos_eliminar ni oportunidades_ver');
  c((await perfilDe(martina)) === compras, 'Martina queda con el perfil');
  const rastroAsignar = await query<{ d: { cambios_del_perfil?: { llave: string }[] } }>(
    "SELECT detalles AS d FROM audit_log WHERE accion = 'editar_permisos' AND entidad = 'user' AND entidad_id = $1",
    [martina.id],
  );
  const cambiadas = (rastroAsignar.rows[0]?.d.cambios_del_perfil ?? []).map((x) => x.llave).sort().join();
  // equipos_ver nace en true para todos; el perfil no lo da, así que se apaga.
  c(cambiadas === 'cuentas,equipos_ver,ordenes_ver,reportes,solicitudes_ver',
    `el rastro dice qué llaves cambió el perfil (dice «${cambiadas}»)`);
  // Las llaves que lleguen junto con el perfil no ganan: manda el perfil.
  await pedir('PUT', `/permissions/${lisbeth.id}`, admin, { permission_profile_id: compras, reportes: true });
  c(soloEstas(await llavesDe(lisbeth), ['solicitudes_ver', 'ordenes_ver']), 'con perfil, manda el perfil');

  const lista = await pedir('GET', '/permission-profiles', admin);
  const enLista = (lista.cuerpo?.data ?? []).find((p: { id: number }) => p.id === compras);
  c(lista.estado === 200 && enLista && enLista.llaves.join() === 'ordenes_ver,solicitudes_ver',
    'la lista trae las llaves del perfil');
  c(enLista && enLista.personas.length === 2, 'la lista trae quiénes lo tienen');

  // --- cambiar el perfil lo cambia para todos los que lo tienen
  const cambiar = await pedir('PUT', `/permission-profiles/${compras}`, admin, {
    llaves: ['solicitudes_ver', 'cotizaciones'],
  });
  c(cambiar.estado === 200 && cambiar.cuerpo?.data?.personas === 2, `cambiar el perfil (dio ${cambiar.estado})`);
  m = await llavesDe(martina);
  c(soloEstas(m, ['solicitudes_ver', 'cotizaciones']), 'a Martina le cambia');
  c(soloEstas(await llavesDe(lisbeth), ['solicitudes_ver', 'cotizaciones']), 'a Lisbeth le cambia');
  c(m.acceso_global === true && m.proyectos_eliminar === true, 'cambiar el perfil tampoco toca las otras tres');
  const rastroAplicar = await query(
    "SELECT 1 FROM audit_log WHERE accion = 'aplicar_perfil' AND entidad = 'user' AND entidad_id = $1",
    [martina.id],
  );
  c(rastroAplicar.rows.length === 1, 'el cambio a cada persona deja rastro');
  const soloNombre = await pedir('PUT', `/permission-profiles/${compras}`, admin, { nombre: `${nombreCompras} B` });
  c(soloNombre.estado === 200 && soloEstas(await llavesDe(martina), ['solicitudes_ver', 'cotizaciones']),
    'cambiar solo el nombre no toca las llaves');
  const renombrarMal = await pedir('PUT', `/permission-profiles/${compras}`, admin, { nombre: `asistente ${marca}` });
  c(renombrarMal.estado === 400, `no se renombra a un nombre ocupado (dio ${renombrarMal.estado})`);

  // --- guardar como la pantalla vieja
  const igual = await pedir('PUT', `/permissions/${martina.id}`, admin, comoPantallaVieja(await llavesDe(martina)));
  c(igual.estado === 200 && (await perfilDe(martina)) === compras,
    'guardar sin cambiar nada (pantalla vieja) deja el perfil');
  const conCambio = { ...comoPantallaVieja(await llavesDe(martina)), reportes: true };
  await pedir('PUT', `/permissions/${martina.id}`, admin, conCambio);
  c((await perfilDe(martina)) === null, 'cambiar una llave pasa a «Personalizado»');
  m = await llavesDe(martina);
  c(m.reportes === true && m.solicitudes_ver === true && m.cotizaciones === true, 'y se queda con lo que se guardó');

  // --- solo las llaves que llegan
  await pedir('PUT', `/permissions/${daniel.id}`, admin, { reportes: true });
  const d = await llavesDe(daniel);
  c(d.reportes === true && d.caja_menuda === true && d.cuentas === true, 'guardar una llave no toca las demás');
  // Una «llave» que no es columna no llega al SQL.
  const rara = await pedir('PUT', `/permissions/${daniel.id}`, admin, { 'reportes = false, cuentas': false });
  const d2 = await llavesDe(daniel);
  c(rara.estado === 200 && d2.reportes === true && d2.cuentas === true, 'una llave inventada se ignora');
  // Una persona sin fila nace con los valores de siempre.
  const nuevo = await crearUsuario('Nuevo Perfiles', 'usuario');
  await pedir('PUT', `/permissions/${nuevo.id}`, admin, { reportes: true });
  const n = await llavesDe(nuevo);
  c(n.reportes === true && n.equipos_ver === true && n.cuentas === false, 'una fila nueva nace con los valores de siempre');

  // --- perfil que no existe: no cambia nada
  const antesDaniel = await llavesDe(daniel);
  const fantasma = await pedir('PUT', `/permissions/${daniel.id}`, admin, { permission_profile_id: 999999, cuentas: false });
  c(fantasma.estado === 400, `un perfil que no existe se rechaza (dio ${fantasma.estado})`);
  c(JSON.stringify(await llavesDe(daniel)) === JSON.stringify(antesDaniel), 'y no se guarda nada a medias');

  // --- Gerencia y el dueño no llevan perfil
  const aGerencia = await pedir('PUT', `/permissions/${coadmin.id}`, admin, { permission_profile_id: compras });
  c(aGerencia.estado === 400, `Gerencia no lleva perfil (dio ${aGerencia.estado})`);
  await pedir('PUT', `/permissions/${daniel.id}`, admin, { permission_profile_id: asistente });
  c((await perfilDe(daniel)) === asistente, 'Daniel toma Asistente');
  const subir = await pedir('PUT', `/users/${daniel.id}`, admin, { rol: 'co-admin' });
  c(subir.estado === 200 && (await perfilDe(daniel)) === null, 'pasar a Gerencia le quita el perfil');

  // --- «Personalizado» a propósito
  await pedir('PUT', `/permissions/${lisbeth.id}`, admin, { permission_profile_id: asistente });
  const antesLisbeth = await llavesDe(lisbeth);
  await pedir('PUT', `/permissions/${lisbeth.id}`, admin, { permission_profile_id: null });
  c((await perfilDe(lisbeth)) === null, 'null = «Personalizado»');
  c(JSON.stringify(await llavesDe(lisbeth)) === JSON.stringify(antesLisbeth), 'y conserva sus llaves');

  // --- quitar un perfil
  await pedir('PUT', `/permissions/${lisbeth.id}`, admin, { permission_profile_id: asistente });
  const antesQuitar = await llavesDe(lisbeth);
  const quitar = await pedir('DELETE', `/permission-profiles/${asistente}`, coadmin);
  c(quitar.estado === 200 && quitar.cuerpo?.data?.personas === 1, `quitar el perfil (dio ${quitar.estado})`);
  c((await perfilDe(lisbeth)) === null, 'sus personas pasan a «Personalizado»');
  c(JSON.stringify(await llavesDe(lisbeth)) === JSON.stringify(antesQuitar), 'con exactamente las mismas llaves');
  const despues = await pedir('GET', '/permission-profiles', admin);
  c(!(despues.cuerpo?.data ?? []).some((p: { id: number }) => p.id === asistente), 'el perfil quitado ya no sale');
  c((await pedir('PUT', `/permission-profiles/${asistente}`, admin, { nombre: 'Otra vez' })).estado === 404,
    'un perfil quitado no se edita');
  c((await pedir('PUT', `/permissions/${lisbeth.id}`, admin, { permission_profile_id: asistente })).estado === 400,
    'ni se asigna');
  const otraVez = await pedir('POST', '/permission-profiles', admin, { nombre: `Asistente ${marca}`, llaves: [] });
  c(otraVez.estado === 201, `su nombre queda libre (dio ${otraVez.estado})`);

  console.log(`${ok} pasaron, ${fallo} fallaron`);
  await pool.end();
  process.exitCode = fallo ? 1 : 0;
};

main().catch(async (e) => {
  console.error(e);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
