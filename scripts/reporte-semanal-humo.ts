// Prueba de humo del reporte semanal, contra la base desechable.
// cd andrei-backend && npm run pruebas -- reporte-semanal
//
// Cubre el camino entero de la etapa 2: empezar el reporte de una semana,
// guardarlo, enviarlo y que la semana siguiente reciba las metas que este dejó
// planeadas. Y las dos reglas que no se ven pero mandan:
//
//   * hay UN reporte por proyecto y semana —volver a empezarlo sigue el mismo
//     borrador—, y
//   * al enviarlo los números se congelan: corregir después un diario de esa
//     semana ya no cambia lo que dice el reporte.
import { API } from './pruebas/contexto.js';
import jwt from 'jsonwebtoken';
import { query, pool } from '../src/database/config.js';

const P = 1;

// Dos semanas seguidas de 2026 que ninguna otra prueba toca.
const S1 = '2026-10-05'; // lunes, semana 41
const S2 = '2026-10-12'; // lunes, semana 42

const main = async () => {
  const admin = await query<{ id: number; email: string; rol: string }>(
    "SELECT id, email, rol FROM users WHERE rol='admin' AND activo=true ORDER BY id LIMIT 1");
  const token = jwt.sign(
    { userId: admin.rows[0].id, email: admin.rows[0].email, rol: admin.rows[0].rol },
    process.env.JWT_SECRET!, { expiresIn: '10m' },
  );

  const pedir = async (m: string, r: string, b?: unknown) => {
    const res = await fetch(`${API}${r}`, {
      method: m,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(b ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(b ? { body: JSON.stringify(b) } : {}),
    });
    return { estado: res.status, cuerpo: await res.json().catch(() => null) };
  };

  let ok = 0; let fallo = 0;
  const c = (cond: boolean, etq: string) => {
    if (cond) ok += 1; else { fallo += 1; console.log('FALLA ', etq); }
  };

  // ---- dos días de obra en la semana 41 ----
  const listas = await pedir('GET', `/proyecto-listas/${P}`);
  const puesto = listas.cuerpo.data.puestos[0];
  const crearDiario = async (fecha: string, gente: number, texto: string, horas?: number) => {
    const creado = await pedir('POST', `/proyecto-reportes/${P}`, {
      fecha, clima: 'Soleado', que_se_hizo: texto,
      horas_perdidas: horas ?? null, motivo: horas ? 'Lluvia' : null,
      personal: [{ puesto_id: puesto.id, cantidad: gente }],
    });
    const id = creado.cuerpo.data.id as number;
    await pedir('POST', `/proyecto-reportes/${P}/${id}/emitir`);
    return id;
  };
  const lunes41 = await crearDiario('2026-10-05', 10, 'Colado de losa');
  await crearDiario('2026-10-06', 14, 'Encofrado de columnas', 3);

  // ---- la semana aparece como reportable ----
  const semanas = await pedir('GET', `/proyecto-reportes-semanales/${P}/semanas`);
  const semana41 = (semanas.cuerpo.data ?? []).find(
    (s: { semana_inicio: string }) => s.semana_inicio === S1);
  c(!!semana41, 'la semana con diarios se ofrece para reportar');
  c(semana41?.semana_iso === 41 && semana41?.anio_iso === 2026, 'con su numero ISO, la 41 de 2026');
  c(semana41?.diarios === 2, 'y diciendo cuantos diarios tiene');

  // ---- se empieza el reporte ----
  const creado = await pedir('POST', `/proyecto-reportes-semanales/${P}`, { fecha: '2026-10-07' });
  c(creado.estado === 201, `empezar el reporte de la semana da 201 (dio ${creado.estado})`);
  const id = creado.cuerpo.data.id as number;

  const otra = await pedir('POST', `/proyecto-reportes-semanales/${P}`, { fecha: S1 });
  c(otra.cuerpo?.data?.id === id && otra.cuerpo?.data?.seguido === true,
    'volver a empezarlo sigue el mismo borrador, no abre otro');

  const enLista = async () => {
    const l = await pedir('GET', `/proyecto-reportes-semanales/${P}`);
    return (l.cuerpo?.data ?? []).some((r: { id: number }) => r.id === id);
  };
  c(!(await enLista()), 'el borrador no sale en la lista');

  // ---- los números salen solos de los diarios ----
  const borrador = await pedir('GET', `/proyecto-reportes-semanales/${P}/${id}`);
  c(borrador.estado === 200, 'el borrador se abre');
  const datos = borrador.cuerpo.data.datos;
  c(datos.dias.length === 7, 'la semana trae sus siete dias');
  c(datos.dias[0].numero !== null && datos.dias[2].numero === null,
    'los dias con diario se distinguen de los que no lo tienen');
  c(datos.personal_total[0] === 10 && datos.personal_total[1] === 14,
    'el personal de cada dia sale de su diario');
  c(datos.personal_total[2] === null, 'un dia sin diario no vale cero, vale nada');
  c(datos.personal_promedio === 12, 'el promedio se saca solo con los dias reportados');
  c(datos.horas_perdidas.total === 3, 'las horas perdidas se suman');
  c(datos.horas_perdidas.motivos.length === 1, 'y se dice de que dia fueron');
  c(borrador.cuerpo.data.metas.length === 0, 'el primer reporte del proyecto no tiene metas que marcar');

  // ---- se escribe ----
  const guardado = await pedir('PUT', `/proyecto-reportes-semanales/${P}/${id}`, {
    resumen: 'Semana de estructura en el bloque B.',
    lo_que_se_espera: 'Cerrar el nivel 3.',
    metas_plan: [
      { texto: 'Colar la rampa del nivel 3', cantidad: 7, unidad: 'm3' },
      { texto: 'Terminar la tuberia sanitaria' },
      { texto: '   ' },
    ],
    problemas: [{ fecha: '2026-10-06', problema: 'Lluvia por la tarde', accion: 'Se cubrio el acero', pendiente: false }],
    decisiones: [{ texto: 'Aprobar la madera adicional' }],
  });
  c(guardado.estado === 200, `guardar da 200 (dio ${guardado.estado})`);

  const escrito = await pedir('GET', `/proyecto-reportes-semanales/${P}/${id}`);
  c(escrito.cuerpo.data.metas_plan.length === 2, 'la meta en blanco no se guarda');
  c(escrito.cuerpo.data.metas_plan[0].texto === 'Colar la rampa del nivel 3',
    'las metas del plan quedan en su orden');
  c(escrito.cuerpo.data.problemas.length === 1 && escrito.cuerpo.data.decisiones.length === 1,
    'problemas y decisiones quedan guardados');

  // Lo que no viene en el cuerpo no se toca: la regla de todo PUT del proyecto.
  await pedir('PUT', `/proyecto-reportes-semanales/${P}/${id}`, { resumen: 'Resumen corregido.' });
  const tocado = await pedir('GET', `/proyecto-reportes-semanales/${P}/${id}`);
  c(tocado.cuerpo.data.metas_plan.length === 2 && tocado.cuerpo.data.problemas.length === 1,
    'guardar solo el resumen no borra las demas secciones');

  // ---- un problema sin contestar no deja salir el reporte ----
  //
  // Ivan, 2026-09-22, leyendo el primero de verdad: la seccion listaba cuatro
  // problemas sin decir cual seguia vivo, «me toca preguntar a Cesar que paso».
  // El borrador si lo guarda a medias; lo que no sale es el papel.
  await pedir('PUT', `/proyecto-reportes-semanales/${P}/${id}`, {
    problemas: [
      { fecha: '2026-10-06', problema: 'Lluvia por la tarde', accion: 'Se cubrio el acero', pendiente: false },
      { fecha: '2026-10-07', problema: 'Falto el vibrador', accion: null },
    ],
  });
  const aMedias = await pedir('GET', `/proyecto-reportes-semanales/${P}/${id}`);
  const enBorrador = aMedias.cuerpo.data.problemas as { pendiente: boolean | null }[];
  c(enBorrador.some((p) => p.pendiente === null),
    'el borrador guarda un problema sin contestar');
  c(enBorrador[enBorrador.length - 1]?.pendiente === null,
    'y el que falta se queda donde estaba, no salta al principio');

  const frenado = await pedir('POST', `/proyecto-reportes-semanales/${P}/${id}/emitir`);
  c(frenado.estado === 400, `sin contestar no se envia (dio ${frenado.estado})`);
  c(String(frenado.cuerpo?.message ?? '').includes('sigue pendiente'),
    'y el mensaje dice que hay que contestarlo o quitarlo');

  await pedir('PUT', `/proyecto-reportes-semanales/${P}/${id}`, {
    problemas: [{ fecha: '2026-10-06', problema: 'Lluvia por la tarde', accion: 'Se cubrio el acero', pendiente: false }],
  });

  // ---- se envía ----
  const emitido = await pedir('POST', `/proyecto-reportes-semanales/${P}/${id}/emitir`);
  c(emitido.estado === 200, `enviarlo da 200 (dio ${emitido.estado})`);
  c(emitido.cuerpo.data.numero?.startsWith('RS-') && emitido.cuerpo.data.numero.endsWith('261005'),
    `el numero lleva el lunes de la semana (dio ${emitido.cuerpo?.data?.numero})`);
  c(await enLista(), 'ya sale en la lista');

  // ---- la semana queda cerrada y los números, congelados ----
  const correccion = await pedir('PUT', `/proyecto-reportes/${P}/${lunes41}`, {
    personal: [{ puesto_id: puesto.id, cantidad: 99 }],
  });
  c(correccion.estado === 409, `el diario de esa semana ya no se corrige (dio ${correccion.estado})`);

  // Y aunque se cambie por debajo, el reporte sigue diciendo lo que dijo.
  await query(
    `UPDATE proyecto_reporte_personal SET cantidad = 99
      WHERE reporte_id = $1`, [lunes41]);
  const congelado = await pedir('GET', `/proyecto-reportes-semanales/${P}/${id}`);
  c(congelado.cuerpo.data.datos.personal_total[0] === 10,
    'el reporte enviado sigue con los numeros que tenia al salir');

  // ---- la semana siguiente recibe las metas planeadas ----
  await crearDiario('2026-10-13', 12, 'Armado de acero');
  const siguiente = await pedir('POST', `/proyecto-reportes-semanales/${P}`, { fecha: S2 });
  const id2 = siguiente.cuerpo.data.id as number;
  const detalle2 = await pedir('GET', `/proyecto-reportes-semanales/${P}/${id2}`);
  c(detalle2.cuerpo.data.metas.length === 2,
    `la semana siguiente hereda las dos metas del plan (heredo ${detalle2.cuerpo?.data?.metas?.length})`);
  c(detalle2.cuerpo.data.metas.every((m: { estado: string | null }) => m.estado === null),
    'y llegan sin marcar');

  const marcadas = await pedir('PUT', `/proyecto-reportes-semanales/${P}/${id2}`, {
    resumen: 'Segunda semana.',
    metas_evaluadas: [
      { id: detalle2.cuerpo.data.metas[0].id, estado: 'parcial', cantidad_hecha: 4, motivo: 'La planta no despacho' },
      { id: detalle2.cuerpo.data.metas[1].id, estado: 'completada' },
      { fuera_del_plan: true, texto: 'Prueba de carga del montacargas', estado: 'no_completada', motivo: 'El tecnico no llego' },
    ],
  });
  c(marcadas.estado === 200, 'se marcan las metas');

  const marcado = await pedir('GET', `/proyecto-reportes-semanales/${P}/${id2}`);
  const metas = marcado.cuerpo.data.metas as {
    texto: string; estado: string; cantidad_hecha: string | null; motivo: string | null;
    fuera_del_plan: boolean;
  }[];
  c(metas.length === 3, 'la meta fuera del plan se agrega a las heredadas');
  c(metas[0].estado === 'completada', 'las completadas salen primero');
  c(metas[2].estado === 'no_completada' && metas[2].fuera_del_plan === true,
    'y la no completada, al final, marcada como fuera del plan');
  const parcial = metas.find((m) => m.estado === 'parcial')!;
  c(Number(parcial.cantidad_hecha) === 4 && parcial.motivo === 'La planta no despacho',
    'la parcial guarda cuanto se hizo y por que');

  // Guardar otra vez no duplica la meta fuera del plan.
  await pedir('PUT', `/proyecto-reportes-semanales/${P}/${id2}`, {
    metas_evaluadas: metas.map((m) => ({ ...m, id: (m as unknown as { id: number }).id })),
  });
  const otraVez = await pedir('GET', `/proyecto-reportes-semanales/${P}/${id2}`);
  c(otraVez.cuerpo.data.metas.length === 3, 'guardar dos veces no duplica la meta fuera del plan');

  // ---- «sigue pendiente»: lo que hay que seguir sale primero ----
  //
  // No todo atraso se resuelve: la lluvia de un martes es el comentario de ese
  // día y nada más. Solo lo que queda abierto se marca, y eso es lo que sube.
  await pedir('PUT', `/proyecto-reportes-semanales/${P}/${id2}`, {
    problemas: [
      { fecha: '2026-10-13', problema: 'Lluvia por la tarde', accion: 'Se cubrio el acero', pendiente: false },
      { fecha: '2026-10-14', problema: 'Falto material selecto', accion: null, pendiente: true },
    ],
  });
  const conPendiente = await pedir('GET', `/proyecto-reportes-semanales/${P}/${id2}`);
  const probs = conPendiente.cuerpo.data.problemas as { problema: string; pendiente: boolean }[];
  c(probs[0]?.pendiente === true && probs[0]?.problema.includes('material'),
    'lo que sigue pendiente sale primero');
  c(probs[1]?.pendiente === false, 'y lo que fue solo el comentario del dia se queda como estaba');
  // ---- «Redactar con IA» solo escribe borradores y solo si hay de qué ----
  //
  // Sin llamar a la IA de verdad: los dos caminos que se comprueban cortan
  // antes de salir a la red, a propósito. Que el borrador de verdad salga bien
  // es cosa de mirarlo, no de una prueba que cueste dinero en cada corrida.
  const enviadoYa = await pedir('POST', `/proyecto-reportes-semanales/${P}/${id}/redactar`);
  c(enviadoYa.estado === 409,
    `la IA no reescribe un reporte ya enviado (dio ${enviadoYa.estado})`);

  const vacia = await pedir('POST', `/proyecto-reportes-semanales/${P}`, { fecha: '2026-11-23' });
  const sinDiarios = await pedir(
    'POST', `/proyecto-reportes-semanales/${P}/${vacia.cuerpo.data.id}/redactar`);
  c(sinDiarios.estado === 400 || sinDiarios.estado === 503,
    `una semana sin diarios no se manda a la IA (dio ${sinDiarios.estado})`);
  await pedir('DELETE', `/proyecto-reportes-semanales/${P}/${vacia.cuerpo.data.id}/borrador`);

  // ---- descartar el borrador devuelve las metas heredadas ----
  const descartado = await pedir('DELETE', `/proyecto-reportes-semanales/${P}/${id2}/borrador`);
  c(descartado.estado === 200, 'el borrador se descarta');
  const tercero = await pedir('POST', `/proyecto-reportes-semanales/${P}`, { fecha: S2 });
  const detalle3 = await pedir('GET', `/proyecto-reportes-semanales/${P}/${tercero.cuerpo.data.id}`);
  c(detalle3.cuerpo.data.metas.length === 2,
    'las metas vuelven a quedar pendientes para el siguiente reporte');
  c(detalle3.cuerpo.data.metas.every((m: { estado: string | null }) => m.estado === null),
    'y sin lo que se habia marcado en el borrador descartado');

  console.log(`${ok} pasaron, ${fallo} fallaron`);
  await pool.end();
  process.exit(fallo ? 1 : 0);
};
main();
