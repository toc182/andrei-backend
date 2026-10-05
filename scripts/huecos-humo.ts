// Prueba de humo: los huecos de permisos que encontro la revision del 2026-10-02.
// cd andrei-backend && npm run pruebas -- huecos
//
// Cada regla se prueba por los dos lados: quien debe pasar pasa, y quien no
// debe, no. Un hueco cerrado de mas deja a alguien sin hacer su trabajo; uno
// cerrado de menos sigue abierto.
//
//   * Hueco 20: no hay registro publico. /auth/register dejaba a cualquiera en
//     internet crearse una cuenta de admin.
//   * Hueco 5: un co-admin no crea admins, no sube a nadie a admin y nadie se
//     cambia su propio rol. Editarse el nombre o el WhatsApp sigue igual.
//   * Hueco 6: guardar una asignacion de equipo escribe solo sus columnas; una
//     llave inventada en el cuerpo ya no llega al SQL. Y lo que la pantalla
//     manda vacio ('' en responsable o tipo de cobro) se guarda, no revienta.
//
// Crea sus propios usuarios y datos: la semilla es de todas las pruebas.
import { API } from './pruebas/contexto.js';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { query, pool } from '../src/database/config.js';

interface Usuario {
  id: number;
  email: string;
  rol: string;
}

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

  const pedir = async (metodo: string, ruta: string, quien: Usuario | null, cuerpo?: unknown) => {
    const res = await fetch(`${API}${ruta}`, {
      method: metodo,
      headers: {
        ...(quien ? { Authorization: `Bearer ${firmar(quien)}` } : {}),
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

  const admin = (
    await query<Usuario>(
      "SELECT id, email, rol FROM users WHERE rol='admin' AND activo=true ORDER BY id LIMIT 1",
    )
  ).rows[0];

  // ------------------------------------------------------- hueco 20: registro
  {
    const r = await pedir('POST', '/auth/register', null, {
      nombre: 'Intruso',
      email: `intruso.${marca}@pruebas.local`,
      password: 'cualquiera123',
      rol: 'admin',
    });
    c(r.estado === 404, `el registro publico ya no existe (dio ${r.estado})`);
    const creado = await query('SELECT 1 FROM users WHERE email = $1', [`intruso.${marca}@pruebas.local`]);
    c(creado.rows.length === 0, 'y no se creo ninguna cuenta');

    const login = await pedir('POST', '/auth/login', null, {});
    c(login.estado === 400, `el login sigue en su sitio (dio ${login.estado})`);
  }

  // ------------------------------------------------------- hueco 5: roles
  {
    const coadmin = await crearUsuario('Coadmin Pruebas', 'co-admin');
    const empleado = await crearUsuario('Empleado Pruebas', 'usuario');

    const comoAdmin = await pedir('POST', '/users', coadmin, {
      nombre: 'Nuevo Admin',
      email: `nuevo.admin.${marca}@pruebas.local`,
      password: 'secreta123',
      rol: 'admin',
      tipo_usuario: 'interno',
    });
    c(comoAdmin.estado === 403, `un co-admin no crea un admin (dio ${comoAdmin.estado})`);

    const comoUsuario = await pedir('POST', '/users', coadmin, {
      nombre: 'Nuevo Usuario',
      email: `nuevo.usuario.${marca}@pruebas.local`,
      password: 'secreta123',
      rol: 'usuario',
      tipo_usuario: 'interno',
    });
    c(comoUsuario.estado === 201, `un co-admin si crea un usuario (dio ${comoUsuario.estado})`);
    const nuevoId = comoUsuario.cuerpo?.user?.id as number | undefined;
    const rastroCrear = await query(
      "SELECT 1 FROM audit_log WHERE accion = 'crear' AND entidad = 'usuario' AND entidad_id = $1 AND user_id = $2",
      [nuevoId ?? -1, coadmin.id],
    );
    c(rastroCrear.rows.length === 1, 'crear un usuario deja rastro');

    const externo = await pedir('POST', '/users', coadmin, {
      nombre: 'Proveedor Externo',
      tipo_usuario: 'externo',
    });
    c(externo.estado === 201, `un co-admin crea un externo (dio ${externo.estado})`);
    const rastroExterno = await query(
      "SELECT 1 FROM audit_log WHERE accion = 'crear' AND entidad = 'usuario' AND entidad_id = $1",
      [externo.cuerpo?.user?.id ?? -1],
    );
    c(rastroExterno.rows.length === 1, 'crear un externo deja rastro');

    // La pantalla manda siempre los cuatro campos, con el rol que ya tiene.
    const editarseNombre = await pedir('PUT', `/users/${coadmin.id}`, coadmin, {
      nombre: 'Coadmin Renombrado',
      email: coadmin.email,
      rol: 'co-admin',
      whatsapp: '',
    });
    c(editarseNombre.estado === 200, `un co-admin se edita el nombre (dio ${editarseNombre.estado})`);

    const subirse = await pedir('PUT', `/users/${coadmin.id}`, coadmin, {
      nombre: 'Coadmin Renombrado',
      email: coadmin.email,
      rol: 'admin',
      whatsapp: '',
    });
    c(subirse.estado === 403, `un co-admin no se sube a admin (dio ${subirse.estado})`);
    const rolCoadmin = await query<{ rol: string }>('SELECT rol FROM users WHERE id = $1', [coadmin.id]);
    c(rolCoadmin.rows[0].rol === 'co-admin', 'y sigue siendo co-admin');

    const subirOtro = await pedir('PUT', `/users/${empleado.id}`, coadmin, { rol: 'admin' });
    c(subirOtro.estado === 403, `un co-admin no sube a otro a admin (dio ${subirOtro.estado})`);
    const rolEmpleado = await query<{ rol: string }>('SELECT rol FROM users WHERE id = $1', [empleado.id]);
    c(rolEmpleado.rows[0].rol === 'usuario', 'y el otro sigue siendo usuario');

    const hacerCoadmin = await pedir('PUT', `/users/${empleado.id}`, coadmin, { rol: 'co-admin' });
    c(hacerCoadmin.estado === 200, `un co-admin si hace co-admin a otro (dio ${hacerCoadmin.estado})`);

    const bajarse = await pedir('PUT', `/users/${admin.id}`, admin, { rol: 'usuario' });
    c(bajarse.estado === 403, `nadie se cambia su propio rol, ni el admin (dio ${bajarse.estado})`);
    const rolAdmin = await query<{ rol: string }>('SELECT rol FROM users WHERE id = $1', [admin.id]);
    c(rolAdmin.rows[0].rol === 'admin', 'y el admin sigue siendo admin');

    const adminSube = await pedir('PUT', `/users/${empleado.id}`, admin, { rol: 'admin' });
    c(adminSube.estado === 200, `el admin si sube a alguien a admin (dio ${adminSube.estado})`);

    const adminCrea = await pedir('POST', '/users', admin, {
      nombre: 'Otro Admin',
      email: `otro.admin.${marca}@pruebas.local`,
      password: 'secreta123',
      rol: 'admin',
      tipo_usuario: 'interno',
    });
    c(adminCrea.estado === 201, `el admin si crea un admin (dio ${adminCrea.estado})`);

    const soloWhatsapp = await pedir('PUT', `/users/${coadmin.id}`, admin, { whatsapp: '6612-3456' });
    c(soloWhatsapp.estado === 200, `cambiar solo el WhatsApp sigue igual (dio ${soloWhatsapp.estado})`);
  }

  // ------------------------------------------------- hueco 6: asignaciones
  {
    const operador = await crearUsuario('Operador Equipos', 'usuario');
    await darPermisos(operador, ['equipos_ver', 'equipos_asignacion', 'equipos_editar_asignacion']);
    const curioso = await crearUsuario('Curioso Equipos', 'usuario');
    await darPermisos(curioso, ['equipos_ver']);

    const equipo = (
      await query<{ id: number }>(
        `INSERT INTO equipos (codigo, descripcion, marca, modelo, ano)
         VALUES ($1, 'Retroexcavadora de pruebas', 'CAT', '416F', 2020) RETURNING id`,
        [`PRU-${marca}`],
      )
    ).rows[0];

    const crearAsignacion = async (tipoUso: string, tipoCobro: string | null) =>
      (
        await query<{ id: number }>(
          `INSERT INTO asignaciones_equipos
             (equipo_id, cliente_id, proyecto_id, fecha_inicio, tipo_uso, tipo_cobro, observaciones)
           VALUES ($1, 1, 1, DATE '2026-09-01', $2, $3, 'original') RETURNING id`,
          [equipo.id, tipoUso, tipoCobro],
        )
      ).rows[0].id;

    const leer = async (id: number) =>
      (
        await query<{ observaciones: string; estado: string; tipo_cobro: string | null; tarifa: string | null }>(
          'SELECT observaciones, estado, tipo_cobro, tarifa FROM asignaciones_equipos WHERE id = $1',
          [id],
        )
      ).rows[0];
    const historial = async (id: number) =>
      (
        await query<{ campo_modificado: string }>(
          'SELECT campo_modificado FROM asignaciones_historial WHERE asignacion_id = $1',
          [id],
        )
      ).rows.map((f) => f.campo_modificado);

    // Lo que manda la pantalla al guardar una de uso propio sin responsable:
    // los catorce campos, con '' donde no hay valor.
    const propia = await crearAsignacion('propio', null);
    const comoPantalla = {
      equipo_id: String(equipo.id),
      cliente_id: '1',
      proyecto_id: '1',
      responsable_id: '',
      fecha_inicio: '2026-09-01',
      fecha_fin: '',
      tipo_uso: 'propio',
      tipo_cobro: '',
      tarifa: '',
      incluye_operador: false,
      costo_operador: '',
      incluye_combustible: false,
      costo_combustible: '',
      observaciones: 'editada desde la pantalla',
    };
    const guardar = await pedir('PUT', `/asignaciones/${propia}`, operador, comoPantalla);
    c(guardar.estado === 200, `una de uso propio sin responsable se guarda (dio ${guardar.estado})`);
    c((await leer(propia)).observaciones === 'editada desde la pantalla', 'y el cambio queda');
    const anotados = await historial(propia);
    c(
      !anotados.some((campo) => ['responsable_id', 'tipo_cobro', 'fecha_fin', 'tarifa'].includes(campo)),
      `un vacio contra un null no cuenta como cambio (anoto: ${anotados.join(', ')})`,
    );
    const rastro = await query(
      "SELECT 1 FROM audit_log WHERE accion = 'editar' AND entidad = 'asignacion_equipo' AND entidad_id = $1",
      [propia],
    );
    c(rastro.rows.length === 1, 'guardar una asignacion deja rastro');

    // Una llave inventada no llega al SQL: se ignora.
    const inyectada = await pedir('PUT', `/asignaciones/${propia}`, operador, {
      observaciones: 'limpia',
      "observaciones = 'METIDO', tarifa": 1,
      estado: 'facturada',
    });
    c(inyectada.estado === 200, `una llave inventada se ignora (dio ${inyectada.estado})`);
    const trasInyeccion = await leer(propia);
    c(trasInyeccion.observaciones === 'limpia', `no se escribe lo metido (quedo «${trasInyeccion.observaciones}»)`);
    c(trasInyeccion.estado !== 'facturada', 'y el estado no se toca desde aqui');

    const nada = await pedir('PUT', `/asignaciones/${propia}`, operador, { inventado: 1 });
    c(nada.estado === 400, `sin ningun campo de verdad no hay nada que guardar (dio ${nada.estado})`);

    const sinPermiso = await pedir('PUT', `/asignaciones/${propia}`, curioso, { observaciones: 'x' });
    c(sinPermiso.estado === 403, `sin «Editar asignaciones» no se guarda (dio ${sinPermiso.estado})`);

    // Con registros de uso, el tipo de cobro no cambia: ni a otro ni a ninguno.
    const alquilada = await crearAsignacion('alquiler', 'hora');
    await query(
      "INSERT INTO registro_uso_equipos (asignacion_id, fecha_inicio, cantidad) VALUES ($1, DATE '2026-09-02', 8)",
      [alquilada],
    );
    const otroCobro = await pedir('PUT', `/asignaciones/${alquilada}`, operador, { tipo_cobro: 'dia' });
    c(otroCobro.estado === 400, `con uso registrado no se cambia el tipo de cobro (dio ${otroCobro.estado})`);
    const sinCobro = await pedir('PUT', `/asignaciones/${alquilada}`, operador, { tipo_cobro: '' });
    c(sinCobro.estado === 400, `ni se borra (dio ${sinCobro.estado})`);
    c((await leer(alquilada)).tipo_cobro === 'hora', 'y sigue por hora');
    const mismoCobro = await pedir('PUT', `/asignaciones/${alquilada}`, operador, {
      tipo_cobro: 'hora',
      tarifa: '150',
    });
    c(mismoCobro.estado === 200, `con el mismo tipo de cobro si se guarda (dio ${mismoCobro.estado})`);

    // Si el guardado falla, no queda historial de un cambio que no paso.
    const antes = (await historial(alquilada)).length;
    const roto = await pedir('PUT', `/asignaciones/${alquilada}`, operador, {
      observaciones: 'no deberia quedar',
      tipo_uso: 'inventado',
    });
    c(roto.estado >= 400, `un valor que la base rechaza no se guarda (dio ${roto.estado})`);
    c((await historial(alquilada)).length === antes, 'y no deja historial falso');
    c((await leer(alquilada)).observaciones === 'original', 'ni cambia nada');
  }

  console.log(`${ok} pasaron, ${fallo} fallaron`);
  await pool.end();
  process.exitCode = fallo ? 1 : 0;
};

main().catch(async (e) => {
  console.error(e);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
