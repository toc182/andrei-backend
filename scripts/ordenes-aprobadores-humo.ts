// Prueba de humo: cuando cambian los aprobadores de un proyecto, sus órdenes de
// compra vuelven a esperar todas sus firmas, igual que las solicitudes de pago.
// cd andrei-backend && npm run pruebas -- ordenes-aprobadores
//
// Por qué (Ivan, 2026-10-26): OC-PBR-002 tenía 1 de 2 firmas; después el
// proyecto quedó con un solo aprobador, el que ya había firmado, y la orden se
// quedó esperando una segunda firma de alguien que ya no estaba en la lista. La
// pantalla decía «1 de 1 firmas» y no ofrecía nada. Cambiar los aprobadores
// devolvía a cero las solicitudes, pero no las órdenes.
//
// También prueba la migración 188, que destraba las que ya quedaron así: se
// corre su SQL contra órdenes trabadas a propósito (en la base de prueba ya
// corrió una vez al crearla, sin órdenes, sin hacer nada).
//
// Usa el proyecto 3, que en la semilla no tiene aprobadores ni órdenes.
import { readFileSync } from 'node:fs';
import { API } from './pruebas/contexto.js';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { query, pool } from '../src/database/config.js';

const P = 3;
const MIGRACION = new URL('../database/migrations/188_orden_compra_firmas_trabadas.sql', import.meta.url);

interface Usuario {
  id: number;
  email: string;
  rol: string;
}

const main = async () => {
  const admin = (
    await query<Usuario>(
      "SELECT id, email, rol FROM users WHERE rol='admin' AND activo=true ORDER BY id LIMIT 1",
    )
  ).rows[0];
  const [a, b, otro] = (
    await query<Usuario>(
      'SELECT id, email, rol FROM users WHERE activo = true AND id <> $1 ORDER BY id LIMIT 3',
      [admin.id],
    )
  ).rows;

  const firmar = (u: Usuario) =>
    jwt.sign({ userId: u.id, email: u.email, rol: u.rol }, process.env.JWT_SECRET!, {
      expiresIn: '10m',
    });
  const pedir = async (metodo: string, ruta: string, cuerpo?: unknown, quien: Usuario = admin) => {
    const res = await fetch(`${API}${ruta}`, {
      method: metodo,
      headers: {
        Authorization: `Bearer ${firmar(quien)}`,
        ...(cuerpo ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(cuerpo ? { body: JSON.stringify(cuerpo) } : {}),
    });
    return { estado: res.status, cuerpo: await res.json().catch(() => null) };
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

  const previo = await query<{ oc: string; ap: string }>(
    `SELECT (SELECT count(*) FROM ordenes_compra WHERE proyecto_id = $1) oc,
            (SELECT count(*) FROM proyecto_ajustes_aprobacion WHERE proyecto_id = $1) ap`,
    [P],
  );
  if (previo.rows[0].oc !== '0' || previo.rows[0].ap !== '0') {
    console.log(`el proyecto ${P} ya tiene ordenes o aprobadores; la prueba no lo toca`);
    await pool.end();
    process.exit(1);
  }

  const cadena = async (ids: number[]) => {
    await query('DELETE FROM proyecto_ajustes_aprobacion WHERE proyecto_id = $1', [P]);
    for (const [i, id] of ids.entries()) {
      await query(
        'INSERT INTO proyecto_ajustes_aprobacion (proyecto_id, user_id, orden) VALUES ($1, $2, $3)',
        [P, id, i + 1],
      );
    }
  };
  await cadena([a.id, b.id]);

  const CLAVE = randomUUID();
  await query('UPDATE users SET password = $1 WHERE id = $2', [await bcrypt.hash(CLAVE, 4), a.id]);

  const ORDEN = {
    proyecto_id: P,
    fecha: '2026-10-15',
    proveedor: 'Tubería de pruebas, S.A.',
    termino_dias: 30,
    entrega: 'sitio',
    items: [{ cantidad: 10, unidad: 'tubo', descripcion: 'Tubo PVC 4"', precio_unitario: 12 }],
  };
  const nueva = async () => {
    const r = await pedir('POST', '/ordenes-compra', ORDEN);
    if (r.estado !== 201) throw new Error(`crear orden dio ${r.estado}`);
    return r.cuerpo.data.id as number;
  };
  // Las firmas van directo a la tabla: lo que se prueba es qué pasa con ellas
  // después, no el botón de aprobar (eso lo prueba ordenes-humo).
  const firma = (orden: number, u: Usuario, n: number, accion = 'aprobado') =>
    query(
      `INSERT INTO orden_compra_aprobaciones (orden_compra_id, user_id, orden, accion, comentario)
       VALUES ($1, $2, $3, $4, $5)`,
      [orden, u.id, n, accion, accion === 'rechazado' ? 'Falta la cotización' : null],
    );
  const estadoDe = async (orden: number) =>
    (
      await query<{ estado: string; firmas: string }>(
        `SELECT o.estado,
                (SELECT count(*) FROM orden_compra_aprobaciones WHERE orden_compra_id = o.id) firmas
           FROM ordenes_compra o WHERE o.id = $1`,
        [orden],
      )
    ).rows[0];

  // ----------------------------------------- cambiar los aprobadores
  // Como OC-PBR-002: firmó el primero de dos.
  const aMedias = await nueva();
  await firma(aMedias, a, 1);
  // Aprobada entera, todavía sin mandar al proveedor.
  const porEnviar = await nueva();
  await firma(porEnviar, a, 1);
  await firma(porEnviar, b, 2);
  await query("UPDATE ordenes_compra SET estado = 'por_enviar' WHERE id = $1", [porEnviar]);
  // Las que ya no están en la cadena: no se tocan.
  const enviada = await nueva();
  await firma(enviada, a, 1);
  await firma(enviada, b, 2);
  await query(
    "UPDATE ordenes_compra SET estado = 'enviada', enviada_at = CURRENT_TIMESTAMP, enviada_por = $2 WHERE id = $1",
    [enviada, admin.id],
  );
  const rechazada = await nueva();
  await firma(rechazada, a, 1, 'rechazado');
  await query("UPDATE ordenes_compra SET estado = 'rechazada' WHERE id = $1", [rechazada]);
  // Una que nadie ha firmado no pierde nada: no se anota.
  const limpia = await nueva();

  // El segundo sale de la lista: queda solo el que ya había firmado.
  const cambio = await pedir('PUT', `/approval-settings/project/${P}`, {
    approvers: [{ user_id: a.id, orden: 1 }],
  });
  c(cambio.estado === 200, `cambiar los aprobadores responde 200 (dio ${cambio.estado})`);

  const e1 = await estadoDe(aMedias);
  c(e1.estado === 'pendiente' && e1.firmas === '0',
    `la que iba a medias vuelve a esperar todas sus firmas (está ${e1.estado}, ${e1.firmas} firmas)`);
  const e2 = await estadoDe(porEnviar);
  c(e2.estado === 'pendiente' && e2.firmas === '0',
    `la aprobada sin mandar vuelve a pendiente, sin firmas (está ${e2.estado}, ${e2.firmas} firmas)`);
  const e3 = await estadoDe(enviada);
  c(e3.estado === 'enviada' && e3.firmas === '2',
    `la ya enviada al proveedor no se toca (está ${e3.estado}, ${e3.firmas} firmas)`);
  const e4 = await estadoDe(rechazada);
  c(e4.estado === 'rechazada' && e4.firmas === '1',
    `la rechazada no se toca (está ${e4.estado}, ${e4.firmas} firmas)`);

  // Y ahora sí le toca a alguien: la pantalla ofrece la firma y la orden avanza.
  const vista = (await pedir('GET', `/ordenes-compra/${aMedias}`)).cuerpo?.data;
  c(vista?.aprobaciones?.length === 0 && vista?.aprobadores?.length === 1,
    `la orden muestra 0 de 1 firmas (muestra ${vista?.aprobaciones?.length} de ${vista?.aprobadores?.length})`);
  const aprobar = await pedir('POST', `/ordenes-compra/${aMedias}/aprobar`, { password: CLAVE }, a);
  c(aprobar.estado === 200, `el aprobador que queda la puede firmar (dio ${aprobar.estado})`);
  c((await estadoDe(aMedias)).estado === 'por_enviar', 'y con esa firma queda lista para enviar');

  const rastro = await query<{
    detalles: {
      ordenes_reiniciadas: {
        id: number;
        numero: string;
        estado_antes: string;
        aprobaciones: { user_id: number; accion: string }[];
      }[];
    };
  }>(
    `SELECT detalles FROM audit_log
      WHERE accion = 'editar_aprobadores' AND entidad = 'proyecto' AND entidad_id = $1
      ORDER BY id`,
    [P],
  );
  const anotadas = rastro.rows[0]?.detalles?.ordenes_reiniciadas ?? [];
  c(
    JSON.stringify(anotadas.map((o) => o.id)) === JSON.stringify([aMedias, porEnviar]),
    `el rastro anota las dos órdenes que perdieron firmas, no la limpia (anotó ${JSON.stringify(anotadas.map((o) => o.id))}, limpia=${limpia})`,
  );
  const deMedias = anotadas.find((o) => o.id === aMedias);
  const dePorEnviar = anotadas.find((o) => o.id === porEnviar);
  c(deMedias?.estado_antes === 'pendiente' && deMedias.aprobaciones.length === 1 &&
      deMedias.aprobaciones[0].user_id === a.id,
    'con la firma que perdió la de a medias');
  c(dePorEnviar?.estado_antes === 'por_enviar' && dePorEnviar.aprobaciones.length === 2,
    'y las dos de la aprobada, con el estado que tenía');

  // Guardar la misma lista no es un cambio: no toca las órdenes.
  const firmadaAntes = await estadoDe(aMedias);
  const igual = await pedir('PUT', `/approval-settings/project/${P}`, {
    approvers: [{ user_id: a.id, orden: 1 }],
  });
  const firmadaDespues = await estadoDe(aMedias);
  c(igual.estado === 200 && firmadaDespues.estado === firmadaAntes.estado &&
      firmadaDespues.firmas === firmadaAntes.firmas,
    'guardar la misma lista no le quita la firma a nadie');

  // ------------------------------------------ la migración 188
  // Las que ya quedaron trabadas antes del arreglo: la cadena cambió por
  // debajo, sin pasar por la ruta.
  await cadena([a.id, b.id]);
  const trabada = await nueva(); // firmó el primero de dos…
  await firma(trabada, a, 1);
  const ajena = await nueva(); // firmó alguien que no está en la cadena
  await firma(ajena, otro, 1);
  const sinFirmas = await nueva();
  // …y el segundo sale de la lista sin pasar por la ruta, como antes del arreglo.
  await cadena([a.id]);
  const aprobadaVieja = await nueva();
  await firma(aprobadaVieja, otro, 1);
  await query("UPDATE ordenes_compra SET estado = 'por_enviar' WHERE id = $1", [aprobadaVieja]);

  // Otra orden en otro proyecto, a medias y en regla: la migración no la toca.
  await query(
    'INSERT INTO proyecto_ajustes_aprobacion (proyecto_id, user_id, orden) VALUES (1, $1, 1), (1, $2, 2)',
    [a.id, b.id],
  );
  const r1 = await pedir('POST', '/ordenes-compra', { ...ORDEN, proyecto_id: 1 });
  const enRegla = r1.cuerpo?.data?.id as number;
  await firma(enRegla, a, 1);

  const sql = readFileSync(MIGRACION, 'utf8');
  await query(sql);

  const m1 = await estadoDe(trabada);
  c(m1.estado === 'pendiente' && m1.firmas === '0',
    `migración: la que esperaba a alguien que ya no está vuelve a cero (tiene ${m1.firmas} firmas)`);
  const m2 = await estadoDe(ajena);
  c(m2.firmas === '0', `migración: la firmada por alguien de fuera de la cadena, también (tiene ${m2.firmas})`);
  const m4 = await estadoDe(sinFirmas);
  c(m4.estado === 'pendiente' && m4.firmas === '0', 'migración: la que nadie firmó sigue igual');
  const m5 = await estadoDe(aprobadaVieja);
  c(m5.estado === 'por_enviar' && m5.firmas === '1', 'migración: la ya aprobada no se toca');
  const m6 = await estadoDe(enRegla);
  c(m6.firmas === '1', `migración: la que va a medias y en regla no se toca (tiene ${m6.firmas})`);
  const mFirmada = await estadoDe(aMedias);
  c(mFirmada.estado === 'por_enviar' && mFirmada.firmas === '1',
    'migración: la que ya se firmó con la cadena nueva no se toca');

  const notas = await query<{ entidad_id: number; user_id: number; detalles: { numero: string; firmas: { user_id: number }[] } }>(
    "SELECT entidad_id, user_id, detalles FROM audit_log WHERE accion = 'reiniciar_firmas' AND entidad = 'orden_compra' ORDER BY entidad_id",
  );
  c(
    JSON.stringify(notas.rows.map((n) => n.entidad_id)) === JSON.stringify([trabada, ajena]),
    `migración: cada orden destrabada queda en el rastro (anotó ${JSON.stringify(notas.rows.map((n) => n.entidad_id))})`,
  );
  const deTrabada = notas.rows.find((n) => n.entidad_id === trabada);
  // El rastro exige una persona: quien cambió por última vez los aprobadores.
  c(deTrabada?.user_id === admin.id && deTrabada?.detalles?.firmas?.[0]?.user_id === a.id && !!deTrabada?.detalles?.numero,
    `con su número y la firma que perdió, a nombre de quien cambió los aprobadores (anotó ${deTrabada?.user_id})`);

  await query(sql);
  const otraVez = await query<{ n: string }>(
    "SELECT count(*) n FROM audit_log WHERE accion = 'reiniciar_firmas'",
  );
  c(otraVez.rows[0].n === String(notas.rows.length), 'correrla otra vez no hace nada');

  console.log(`${ok} pasaron, ${fallo} fallaron`);
  await pool.end();
  process.exit(fallo ? 1 : 0);
};

main();
