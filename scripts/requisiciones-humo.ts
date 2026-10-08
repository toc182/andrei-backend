// Prueba de humo: la requisición de punta a punta, del proyecto a Compras.
// cd andrei-backend && npm run pruebas -- requisiciones
//
// Lo que se comprueba, y por qué cada cosa importa:
//
//   * Nace POR APROBAR y hasta aprobarse solo la ven quien la escribió, quien la
//     aprueba y los admins. Compras no la ve (Ivan: «no se deben mezclar»).
//   * El número sigue la cuenta del proyecto desde su número inicial (Santa
//     Isabel arranca en 175) y no se reusa.
//   * Quien la escribió la corrige y lo que cambió queda anotado; si la corrige
//     quien aprueba, queda aprobada al guardar, con su contraseña.
//   * Por aprobar la anula quien aprueba; aprobada ya no se anula.
//   * Aprobada, Compras marca las líneas y sube cotizaciones, y cada cotización
//     queda en Cotizaciones UNA ENTRADA POR LÍNEA, sin que desde ahí se pueda
//     cambiar.
//   * Los globitos cuentan lo que le toca a cada quien.
//   * La solicitud de pago que Compras crea desde la requisición queda amarrada
//     a sus líneas, las marca, recuerda a qué cotización le compró y lleva los
//     archivos y el papel; editarla no la desamarra.
//
// Usa el proyecto 3 (PRU3), que en la semilla no tiene nada.
import { API } from './pruebas/contexto.js';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { query, pool } from '../src/database/config.js';

const P = 3;

interface Usuario {
  id: number;
  email: string;
  rol: string;
}

const main = async () => {
  const admin = (
    await query<Usuario>("SELECT id, email, rol FROM users WHERE rol='admin' AND activo=true ORDER BY id LIMIT 1")
  ).rows[0];
  const [cecilia, hilario, martina, intruso] = (
    await query<Usuario>('SELECT id, email, rol FROM users WHERE activo = true AND id <> $1 ORDER BY id LIMIT 4', [admin.id])
  ).rows;

  const firmar = (u: Usuario) =>
    jwt.sign({ userId: u.id, email: u.email, rol: u.rol }, process.env.JWT_SECRET!, { expiresIn: '10m' });
  const tk = {
    admin: firmar(admin),
    cecilia: firmar(cecilia),
    hilario: firmar(hilario),
    martina: firmar(martina),
    intruso: firmar(intruso),
  };

  const pedir = async (metodo: string, ruta: string, cuerpo?: unknown, token = tk.admin) => {
    const res = await fetch(`${API}${ruta}`, {
      method: metodo,
      headers: { Authorization: `Bearer ${token}`, ...(cuerpo ? { 'Content-Type': 'application/json' } : {}) },
      ...(cuerpo ? { body: JSON.stringify(cuerpo) } : {}),
    });
    return { estado: res.status, cuerpo: await res.json().catch(() => null) };
  };

  // Un PDF de mentira basta: el servidor solo mira el tipo y el tamaño.
  const PDF = Buffer.from('%PDF-1.4\n%prueba\n');
  const subir = async (ruta: string, campos: Record<string, string>, token: string, nombre = 'cotizacion.pdf') => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(campos)) fd.append(k, v);
    fd.append('archivo', new Blob([PDF], { type: 'application/pdf' }), nombre);
    const res = await fetch(`${API}${ruta}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
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

  const previo = await query<{ n: string }>('SELECT count(*) n FROM requisiciones WHERE proyecto_id = $1', [P]);
  if (previo.rows[0].n !== '0') {
    console.log(`el proyecto ${P} ya tiene requisiciones; la prueba no lo toca`);
    await pool.end();
    process.exit(1);
  }

  // Las llaves: Cecilia escribe, Martina atiende (todas las obras), el intruso
  // solo ve y no tiene acceso al proyecto. Hilario no necesita llave para
  // aprobar: lo nombra el proyecto.
  const llaves = async (u: Usuario, cols: Record<string, boolean>) => {
    const nombres = Object.keys(cols);
    await query(
      `INSERT INTO user_permissions (user_id, ${nombres.join(', ')}) VALUES ($1, ${nombres.map((_, i) => `$${i + 2}`).join(', ')})
       ON CONFLICT (user_id) DO UPDATE SET ${nombres.map((n) => `${n} = EXCLUDED.${n}`).join(', ')}`,
      [u.id, ...Object.values(cols)],
    );
  };
  await llaves(cecilia, { requisiciones_crear: true });
  await llaves(martina, { requisiciones_atender: true, acceso_global: true });
  await llaves(intruso, { requisiciones_ver: true });

  const CLAVE = randomUUID();
  await query('UPDATE users SET password = $1 WHERE id = $2', [await bcrypt.hash(CLAVE, 4), hilario.id]);

  const NUEVA = {
    proyecto_id: P,
    descripcion: 'Vaciado de la losa del tanque de reserva',
    fecha_requerida: '2026-10-08',
    prioridad: 'urgente',
    notas: 'Se vacía el viernes 9.',
    lineas: [
      { cantidad: 20, unidad: 'sacos', descripcion: 'Cemento gris tipo I, saco de 42.5 kg', renglon_desglose: '3.10' },
      { cantidad: 40, unidad: 'unidades', descripcion: 'Varilla corrugada 1/2 x 30', renglon_desglose: '3.10, 3.12' },
      { cantidad: 10, unidad: 'unidades', descripcion: 'Codo de PVC 6 a 90' },
    ],
  };

  // ------------------------------------------------------------ los ajustes
  const sinAprobador = await pedir('POST', '/requisiciones', NUEVA, tk.cecilia);
  c(sinAprobador.estado === 403, `sin acceso al proyecto no escribe (dio ${sinAprobador.estado})`);
  await query('INSERT INTO user_project_access (user_id, proyecto_id) VALUES ($1, $2)', [cecilia.id, P]);
  const sinAprobador2 = await pedir('POST', '/requisiciones', NUEVA, tk.cecilia);
  c(
    sinAprobador2.estado === 400 && /aprueba/.test(sinAprobador2.cuerpo?.error ?? ''),
    `sin quién apruebe no se crea (dio ${sinAprobador2.estado})`,
  );
  const ajusteAjeno = await pedir('PUT', `/requisiciones/proyecto/${P}/ajustes`, { aprobador_id: hilario.id }, tk.cecilia);
  c(ajusteAjeno.estado === 403, 'los ajustes los cambia un admin');
  const ajuste = await pedir('PUT', `/requisiciones/proyecto/${P}/ajustes`, { aprobador_id: hilario.id, numero_inicial: 175 });
  c(ajuste.estado === 200, `el admin nombra al que aprueba y el número inicial (dio ${ajuste.estado})`);
  const verAjustes = await pedir('GET', `/requisiciones/proyecto/${P}/ajustes`, undefined, tk.cecilia);
  c(verAjustes.cuerpo?.data?.siguiente === 'REQ-PRU3-175', `la siguiente es REQ-PRU3-175 (dio ${verAjustes.cuerpo?.data?.siguiente})`);
  c(verAjustes.cuerpo?.data?.aprobador_id === hilario.id, 'y la aprueba Hilario');

  // ---------------------------------------------------------------- crear
  const sinLlave = await pedir('POST', '/requisiciones', NUEVA, tk.intruso);
  c(sinLlave.estado === 403, 'sin la llave Crear no se escribe');
  for (const [malo, etq] of [
    [{ ...NUEVA, lineas: [] }, 'sin líneas'],
    [{ ...NUEVA, fecha_requerida: '2026-13-40' }, 'con una fecha que no existe'],
    [{ ...NUEVA, prioridad: 'altisima' }, 'con una prioridad que no existe'],
    [{ ...NUEVA, descripcion: '  ' }, 'sin descripción'],
    [{ ...NUEVA, lineas: [{ cantidad: 0, descripcion: 'Cemento' }] }, 'con una cantidad de cero'],
    [{ ...NUEVA, tipo_cuenta: 'plazo fijo' }, 'con un tipo de cuenta que no existe'],
  ] as [unknown, string][]) {
    const r = await pedir('POST', '/requisiciones', malo, tk.cecilia);
    c(r.estado === 400, `${etq} se rechaza (dio ${r.estado})`);
  }

  const alta = await pedir('POST', '/requisiciones', NUEVA, tk.cecilia);
  c(alta.estado === 201, `crear responde 201 (dio ${alta.estado})`);
  const id1 = alta.cuerpo?.data?.id as number;
  c(alta.cuerpo?.data?.numero === 'REQ-PRU3-175', `arranca en REQ-PRU3-175 (dio ${alta.cuerpo?.data?.numero})`);
  c(alta.cuerpo?.data?.estado === 'por_aprobar', 'nace por aprobar');
  const id2 = (await pedir('POST', '/requisiciones', { ...NUEVA, descripcion: 'Alquiler de planta eléctrica', prioridad: 'normal' }, tk.cecilia)).cuerpo.data.id as number;
  const id3 = (await pedir('POST', '/requisiciones', { ...NUEVA, descripcion: 'Andamios que al final no hacen falta' }, tk.cecilia)).cuerpo.data.id as number;
  const numeros = await query<{ numero: string }>('SELECT numero FROM requisiciones WHERE proyecto_id = $1 ORDER BY id', [P]);
  c(numeros.rows.map((r) => r.numero).join() === 'REQ-PRU3-175,REQ-PRU3-176,REQ-PRU3-177', 'y sigue la cuenta');

  // -------------------------------------------- quién la ve mientras espera
  const lista = async (token: string, extra = '') =>
    ((await pedir('GET', `/requisiciones?proyecto_id=${P}${extra}`, undefined, token)).cuerpo?.data ?? []) as { id: number }[];
  const ids = (filas: { id: number }[]) => filas.map((f) => f.id).sort((a, b) => a - b).join();
  c(ids(await lista(tk.cecilia, '&vista=por_aprobar')) === [id1, id2, id3].join(), 'Cecilia ve sus tres por aprobar');
  c(ids(await lista(tk.hilario, '&vista=por_aprobar')) === [id1, id2, id3].join(), 'Hilario ve las tres que le toca aprobar');
  c((await lista(tk.martina, '&vista=por_aprobar')).length === 0, 'Compras no ve las que esperan aprobación');
  c((await pedir('GET', `/requisiciones/${id1}`, undefined, tk.martina)).estado === 404, 'ni abriéndola por su número');
  c((await lista(tk.admin, '&vista=por_aprobar')).length === 3, 'el admin las ve');
  c((await lista(tk.cecilia)).length === 0, 'y en Aprobadas todavía no hay ninguna');
  const globitoH = (await pedir('GET', '/requisiciones/pendientes', undefined, tk.hilario)).cuerpo?.data;
  c(globitoH?.por_aprobar === 3 && globitoH?.por_proyecto?.[P] === 3, `el globito de Hilario dice 3 (dio ${JSON.stringify(globitoH)})`);
  c(JSON.stringify(globitoH?.aprueba_en) === JSON.stringify([P]), 'y sabe en qué proyectos aprueba');

  // ------------------------------------------------------------- corregir
  const correccion = await pedir(
    'PUT',
    `/requisiciones/${id1}`,
    { lineas: [{ ...NUEVA.lineas[0], cantidad: 200 }, NUEVA.lineas[1], NUEVA.lineas[2]] },
    tk.cecilia,
  );
  c(correccion.estado === 200 && correccion.cuerpo?.data?.estado === 'por_aprobar', 'Cecilia corrige y sigue por aprobar');
  const cambios1 = await query<{ cambios: { campo: string; antes: unknown; despues: unknown }[] }>(
    'SELECT cambios FROM requisicion_cambios WHERE requisicion_id = $1 ORDER BY id',
    [id1],
  );
  c(
    cambios1.rows.length === 1 && cambios1.rows[0].cambios[0].campo === 'Línea 1 · Cantidad' && cambios1.rows[0].cambios[0].despues === 200,
    `queda anotado que la línea 1 pasó de 20 a 200 (dio ${JSON.stringify(cambios1.rows)})`,
  );
  const nada = await pedir('PUT', `/requisiciones/${id1}`, { descripcion: NUEVA.descripcion }, tk.cecilia);
  c(nada.cuerpo?.data?.cambios === 0, 'guardar lo mismo no anota nada');
  c((await pedir('PUT', `/requisiciones/${id1}`, { notas: 'x' }, tk.martina)).estado === 404, 'Compras no la corrige: ni la ve');

  const sinClave = await pedir('PUT', `/requisiciones/${id1}`, { prioridad: 'normal' }, tk.hilario);
  c(sinClave.estado === 403, 'Hilario corrige solo con su contraseña');
  const hilarioCorrige = await pedir('PUT', `/requisiciones/${id1}`, { prioridad: 'urgente', notas: 'Se vacía el viernes 9 temprano.', password: CLAVE }, tk.hilario);
  c(hilarioCorrige.cuerpo?.data?.estado === 'aprobada', `si la corrige Hilario, queda aprobada (dio ${JSON.stringify(hilarioCorrige.cuerpo)})`);
  const r1 = (await pedir('GET', `/requisiciones/${id1}`, undefined, tk.cecilia)).cuerpo?.data;
  c(r1?.estado === 'aprobada' && r1?.aprobada_por === hilario.id, 'aprobada por Hilario');
  c(r1?.cambios?.length === 2, 'con sus dos correcciones a la vista');
  c(r1?.fecha_requerida === '2026-10-08', `la fecha requerida no se corre de día (dio ${r1?.fecha_requerida})`);
  const tarde = await pedir('PUT', `/requisiciones/${id1}`, { notas: 'otra' }, tk.cecilia);
  c(tarde.estado === 400, 'aprobada ya no se corrige');

  // -------------------------------------------------------------- aprobar
  c((await pedir('POST', `/requisiciones/${id2}/aprobar`, { password: CLAVE }, tk.cecilia)).estado === 403, 'quien la escribió no la aprueba');
  c((await pedir('POST', `/requisiciones/${id2}/aprobar`, { password: 'otra' }, tk.hilario)).estado === 403, 'con otra contraseña no se aprueba');
  c((await pedir('POST', `/requisiciones/${id2}/aprobar`, { password: CLAVE }, tk.hilario)).estado === 200, 'Hilario la aprueba');
  c((await pedir('POST', `/requisiciones/${id2}/aprobar`, { password: CLAVE }, tk.hilario)).estado === 400, 'dos veces no');

  // --------------------------------------------------------------- anular
  c((await pedir('POST', `/requisiciones/${id3}/anular`, undefined, tk.cecilia)).estado === 403, 'quien la escribió no la anula');
  c((await pedir('POST', `/requisiciones/${id3}/anular`, undefined, tk.hilario)).estado === 200, 'Hilario la anula');
  c((await lista(tk.hilario, '&vista=por_aprobar')).length === 0, 'y sale de Por aprobar');
  c((await pedir('POST', `/requisiciones/${id2}/anular`, undefined, tk.hilario)).estado === 400, 'aprobada ya no se anula');

  // ------------------------------------------------ quién ve las aprobadas
  c(ids(await lista(tk.martina)) === [id1, id2].join(), 'Compras ve las dos aprobadas');
  c((await lista(tk.intruso)).length === 0, 'con la llave Ver pero sin acceso al proyecto, nada');
  await query('INSERT INTO user_project_access (user_id, proyecto_id) VALUES ($1, $2)', [intruso.id, P]);
  c(ids(await lista(tk.intruso)) === [id1, id2].join(), 'con acceso al proyecto, las ve');
  c(ids(await lista(tk.cecilia, '&buscar=varilla')) === [id1, id2].join(), 'se busca por lo que dicen las líneas');
  const pag = await pedir('GET', `/requisiciones?proyecto_id=${P}&tamano=1&pagina=2`, undefined, tk.martina);
  c(pag.cuerpo?.data?.length === 1 && pag.cuerpo?.total === 2, 'pagina en el servidor');
  c((await pedir('GET', '/requisiciones/pendientes', undefined, tk.martina)).cuerpo?.data?.por_atender === 2, 'el globito de Martina dice 2');
  c((await pedir('GET', '/requisiciones/pendientes', undefined, tk.admin)).cuerpo?.data?.por_atender === 0, 'al admin no le sale el de Compras');

  // ---------------------------------------------------------------- marcas
  const lineas1 = r1.lineas as { id: number }[];
  const lineas2 = ((await pedir('GET', `/requisiciones/${id2}`, undefined, tk.martina)).cuerpo.data.lineas) as { id: number }[];
  c((await pedir('PATCH', `/requisiciones/${id1}/marcas`, { lineas: [{ id: lineas1[0].id, marca: 'atendida' }] }, tk.cecilia)).estado === 403, 'las marcas las pone Compras');
  c((await pedir('PATCH', `/requisiciones/${id1}/marcas`, { lineas: [{ id: lineas1[0].id, marca: 'comprada' }] }, tk.martina)).estado === 400, 'una marca que no existe se rechaza');
  c((await pedir('PATCH', `/requisiciones/${id1}/marcas`, { lineas: [{ id: lineas2[0].id, marca: 'atendida' }] }, tk.martina)).estado === 400, 'una línea de otra requisición, también');
  c((await pedir('PATCH', `/requisiciones/${id1}/marcas`, { lineas: [{ id: lineas1[0].id, marca: 'atendida' }] }, tk.martina)).estado === 200, 'Martina marca la línea 1 como atendida');
  c((await pedir('PATCH', `/requisiciones/${id2}/marcas`, { todas: 'cancelada' }, tk.martina)).estado === 200, 'y cancela la otra entera');
  c((await pedir('GET', '/requisiciones/pendientes', undefined, tk.martina)).cuerpo?.data?.por_atender === 1, 'el globito baja a 1');
  c(ids(await lista(tk.martina, '&solo_pendientes=true')) === String(id1), 'y el filtro de pendientes deja solo la primera');

  // ---------------------------------------------------------- cotizaciones
  c((await subir(`/requisiciones/${id1}/cotizaciones`, { proveedor: 'Ferretería Costa Arriba', lineas: JSON.stringify([lineas1[0].id]) }, tk.cecilia)).estado === 403, 'las cotizaciones las agrega Compras');
  c((await subir(`/requisiciones/${id1}/cotizaciones`, { proveedor: 'Ferretería Costa Arriba' }, tk.martina)).estado === 400, 'una cotización sin líneas se rechaza');
  c((await subir(`/requisiciones/${id1}/cotizaciones`, { lineas: JSON.stringify([lineas1[0].id]) }, tk.martina)).estado === 400, 'y sin proveedor');
  const cot1 = await subir(
    `/requisiciones/${id1}/cotizaciones`,
    { proveedor: 'Ferretería Costa Arriba', monto: '3240', lineas: JSON.stringify([lineas1[0].id, lineas1[1].id, lineas1[2].id]) },
    tk.martina,
  );
  c(cot1.estado === 201, `Martina agrega una cotización de las tres líneas (dio ${cot1.estado} ${JSON.stringify(cot1.cuerpo)})`);
  const cot2 = await subir(
    `/requisiciones/${id1}/cotizaciones`,
    { proveedor: 'Cemento del Pacífico', monto: '1860', lineas: JSON.stringify([lineas1[0].id]) },
    tk.martina,
  );
  c(cot2.estado === 201, 'y otra solo del cemento');

  const entradas = await query<{ id: number; descripcion: string; descripcion_larga: string; creado_por: number; ofertas: number }>(
    `SELECT c.id, c.descripcion, c.descripcion_larga, c.creado_por,
            (SELECT count(*)::int FROM cotizacion_ofertas o WHERE o.cotizacion_id = c.id AND o.activo) AS ofertas
       FROM cotizaciones c JOIN requisicion_lineas l ON l.id = c.requisicion_linea_id
      WHERE l.requisicion_id = $1 AND c.activo ORDER BY l.orden`,
    [id1],
  );
  c(entradas.rows.length === 3, `en Cotizaciones queda una entrada por línea (dio ${entradas.rows.length})`);
  c(entradas.rows.map((e) => e.ofertas).join() === '2,1,1', `el cemento con dos ofertas, las otras con una (dio ${entradas.rows.map((e) => e.ofertas)})`);
  c(entradas.rows[0].descripcion === 'Cemento gris tipo I, saco de 42.5 kg — 200 sacos', `la entrada se llama como la línea (dio ${entradas.rows[0].descripcion})`);
  c(entradas.rows[0].descripcion_larga === `REQ-PRU3-175 · ${NUEVA.descripcion}`, 'y dice de qué requisición viene');
  c(entradas.rows[0].creado_por === cecilia.id, '«Pedido por» es quien escribió la requisición');
  const notas = await query<{ nota: string; monto: string; archivos: string }>(
    `SELECT o.nota, o.monto, (SELECT string_agg(a.r2_key, ',') FROM cotizacion_archivos a WHERE a.oferta_id = o.id) AS archivos
       FROM cotizacion_ofertas o WHERE o.requisicion_cotizacion_id = $1 ORDER BY o.id`,
    [cot1.cuerpo.data.id],
  );
  c(notas.rows.length === 3 && notas.rows.every((n) => n.nota === 'Cubre las líneas 1, 2 y 3; el monto es por todas'), `la cotización de las tres dice que cubre las tres (dio ${notas.rows[0]?.nota})`);
  c(notas.rows.every((n) => Number(n.monto) === 3240), 'con su total entero en cada entrada');
  c(new Set(notas.rows.map((n) => n.archivos)).size === 1, 'y el mismo archivo en las tres');
  const detalle = (await pedir('GET', `/requisiciones/${id1}`, undefined, tk.martina)).cuerpo.data;
  const cubre = (detalle.cotizaciones as { id: number; lineas: number[] }[]).find((x) => x.id === cot1.cuerpo.data.id)?.lineas ?? [];
  c(cubre.length === 3, 'la requisición sabe qué líneas cubre cada cotización');
  c(detalle.puede?.atender === true && detalle.puede?.editar === false, 'y a Compras le deja atender, no corregir');

  // ------------------------------------------- Cotizaciones no las deja tocar
  const oferta = (await query<{ id: number }>('SELECT id FROM cotizacion_ofertas WHERE requisicion_cotizacion_id = $1 LIMIT 1', [cot2.cuerpo.data.id])).rows[0].id;
  const entrada = entradas.rows[0].id;
  c((await pedir('PUT', `/cotizaciones/ofertas/${oferta}`, { proveedor: 'Otro' })).estado === 409, 'en Cotizaciones la oferta no se edita');
  c((await pedir('PUT', `/cotizaciones/ofertas/${oferta}/eleccion`, { elegida: true })).estado === 409, 'ni se elige a mano');
  c((await pedir('DELETE', `/cotizaciones/ofertas/${oferta}`)).estado === 409, 'ni se quita');
  c((await pedir('POST', `/cotizaciones/${entrada}/ofertas`, { proveedor: 'Otro' })).estado === 409, 'a la entrada no se le agregan ofertas a mano');
  c((await pedir('DELETE', `/cotizaciones/${entrada}`)).estado === 409, 'ni se borra');
  const listaCot = ((await pedir('GET', '/cotizaciones')).cuerpo.data) as { id: number; requisicion_numero: string | null }[];
  c(listaCot.find((x) => x.id === entrada)?.requisicion_numero === 'REQ-PRU3-175', 'la lista de Cotizaciones dice de qué requisición viene');

  // Quitar la de las tres: la entrada de la línea 1 sigue (le queda la del
  // cemento) y las de las líneas 2 y 3 salen de la lista.
  c((await pedir('DELETE', `/requisiciones/${id1}/cotizaciones/${cot1.cuerpo.data.id}`, undefined, tk.martina)).estado === 200, 'Martina quita la cotización de las tres');
  const quedan = await query<{ n: string }>(
    `SELECT count(*) n FROM cotizaciones c JOIN requisicion_lineas l ON l.id = c.requisicion_linea_id
      WHERE l.requisicion_id = $1 AND c.activo`,
    [id1],
  );
  c(quedan.rows[0].n === '1', `queda solo la entrada del cemento (dio ${quedan.rows[0].n})`);

  // ---------------------------------------------------------------- archivos
  const id4 = (await pedir('POST', '/requisiciones', NUEVA, tk.cecilia)).cuerpo.data.id as number;
  c((await subir(`/requisiciones/${id4}/adjuntos`, { descripcion: 'Plano de la losa' }, tk.cecilia, 'plano.pdf')).estado === 201, 'Cecilia adjunta un plano mientras está por aprobar');
  c((await subir(`/requisiciones/${id1}/adjuntos`, {}, tk.cecilia, 'tarde.pdf')).estado === 403, 'aprobada, el proyecto ya no adjunta');
  c((await subir(`/requisiciones/${id1}/adjuntos`, { tipo: 'cuadro_comparativo' }, tk.martina, 'cuadro.pdf')).estado === 400, 'un cuadro comparativo sin líneas se rechaza');
  const cuadro = await subir(`/requisiciones/${id1}/adjuntos`, { tipo: 'cuadro_comparativo', lineas: JSON.stringify([lineas1[0].id, lineas1[1].id]) }, tk.martina, 'cuadro.pdf');
  c(cuadro.estado === 201, 'Martina sube el cuadro comparativo de dos líneas');
  const urls = await pedir('GET', `/requisiciones/${id1}/archivos/urls`, undefined, tk.martina);
  c(urls.cuerpo?.adjuntos?.length === 1 && urls.cuerpo?.cotizaciones?.length === 1, 'los enlaces de los archivos salen');
  c((await pedir('DELETE', `/requisiciones/${id1}/adjuntos/${cuadro.cuerpo.data.id}`, undefined, tk.martina)).estado === 200, 'y el cuadro se puede quitar');

  // ------------------------------------------------------------------ el papel
  const papel = await fetch(`${API}/requisiciones/${id1}/pdf`, { headers: { Authorization: `Bearer ${tk.martina}` } });
  const bytes = Buffer.from(await papel.arrayBuffer());
  c(papel.status === 200 && bytes.subarray(0, 5).toString() === '%PDF-', `el PDF sale (dio ${papel.status})`);
  c((papel.headers.get('content-disposition') ?? '').includes('REQ-PRU3-175.pdf'), 'con el número por nombre');

  // ------------------------------------------- Hilario escribe la suya
  await llaves(hilario, { requisiciones_crear: true });
  await query('INSERT INTO user_project_access (user_id, proyecto_id) VALUES ($1, $2)', [hilario.id, P]);
  const propia = await pedir('POST', '/requisiciones', { ...NUEVA, aprobar: true, password: CLAVE }, tk.hilario);
  c(propia.cuerpo?.data?.estado === 'aprobada', 'la que escribe Hilario puede salir ya aprobada');
  c((await pedir('POST', '/requisiciones', { ...NUEVA, aprobar: true, password: CLAVE }, tk.cecilia)).estado === 403, 'la de Cecilia no');

  // ------------------------------------------------------ el número inicial
  const tardeInicial = await pedir('PUT', `/requisiciones/proyecto/${P}/ajustes`, { numero_inicial: 100 });
  c(tardeInicial.estado === 400, 'con requisiciones ya hechas, el número inicial no se baja');

  // ------------------------------- la solicitud de pago desde la requisición
  // Compras escoge líneas y a qué cotización le compra; la solicitud se crea
  // por la ruta de siempre con `desde_requisicion` y queda amarrada, con sus
  // marcas, la cotización comprada y los archivos copiados.
  await query('INSERT INTO proyecto_ajustes_aprobacion (proyecto_id, user_id, orden) VALUES ($1, $2, 1)', [P, hilario.id]);
  const cot3 = await subir(
    `/requisiciones/${id1}/cotizaciones`,
    { proveedor: 'Aceros del Istmo', monto: '1120', lineas: JSON.stringify([lineas1[0].id, lineas1[1].id]) },
    tk.martina,
    'aceros.pdf',
  );
  const cuadro2 = await subir(`/requisiciones/${id1}/adjuntos`, { tipo: 'cuadro_comparativo', lineas: JSON.stringify([lineas1[0].id, lineas1[1].id]) }, tk.martina, 'comparativo.pdf');
  const SOL = {
    proyecto_id: P,
    proveedor: 'Aceros del Istmo',
    solicitado_por: martina.id,
    urgente: true,
    items: [{ cantidad: 40, unidad: 'unidad', descripcion: 'Varilla corrugada', precio_unitario: 28 }],
    ajustes: [],
  };
  const desde = {
    requisicion_id: id1,
    lineas: [{ id: lineas1[0].id, marca: 'parcial' }, { id: lineas1[1].id }],
    cotizacion_id: cot3.cuerpo.data.id,
    adjuntar: { cotizaciones: [cot2.cuerpo.data.id, cot3.cuerpo.data.id], cuadros: [cuadro2.cuerpo.data.id], papel: true },
  };
  const lineas4 = ((await pedir('GET', `/requisiciones/${id4}`, undefined, tk.cecilia)).cuerpo.data.lineas) as { id: number }[];
  c((await pedir('POST', '/solicitudes-pago', { ...SOL, desde_requisicion: desde }, tk.cecilia)).estado === 403, 'desde la requisición, la solicitud la crea Compras');
  c((await pedir('POST', '/solicitudes-pago', { ...SOL, desde_requisicion: { ...desde, lineas: [{ id: lineas4[0].id }] } }, tk.martina)).estado === 400, 'una línea de otra requisición se rechaza');
  c((await pedir('POST', '/solicitudes-pago', { ...SOL, desde_requisicion: { ...desde, requisicion_id: id4, lineas: [{ id: lineas4[0].id }], cotizacion_id: null, adjuntar: {} } }, tk.martina)).estado === 400, 'de una requisición por aprobar no se compra');
  c((await pedir('POST', '/solicitudes-pago', { ...SOL, desde_requisicion: { ...desde, lineas: [{ id: lineas1[1].id }], cotizacion_id: cot2.cuerpo.data.id } }, tk.martina)).estado === 400, 'una cotización que no cubre esas líneas se rechaza');
  c((await pedir('POST', '/solicitudes-pago', { ...SOL, desde_requisicion: { ...desde, lineas: [{ id: lineas1[1].id, marca: 'cancelada' }] } }, tk.martina)).estado === 400, 'lo que se compra queda Atendida o Parcial, no Cancelada');
  const antesDeComprar = await query<{ n: string }>('SELECT count(*) n FROM solicitudes_pago WHERE proyecto_id = $1', [P]);
  c(antesDeComprar.rows[0].n === '0', 'ninguna de las rechazadas dejó una solicitud a medias');

  const sp = await pedir('POST', '/solicitudes-pago', { ...SOL, desde_requisicion: desde }, tk.martina);
  c(sp.estado === 201, `Martina crea la solicitud desde la requisición (dio ${sp.estado} ${JSON.stringify(sp.cuerpo?.message ?? '')})`);
  const sid = sp.cuerpo?.solicitud?.id as number;
  const sNumero = sp.cuerpo?.solicitud?.numero as string;
  c(Array.isArray(sp.cuerpo?.adjuntos_fallidos) && sp.cuerpo.adjuntos_fallidos.length === 0, `todos los archivos se adjuntaron (faltó ${JSON.stringify(sp.cuerpo?.adjuntos_fallidos)})`);
  const fila = (await query<{ requisicion_id: number; requisicion_cotizacion_id: number }>('SELECT requisicion_id, requisicion_cotizacion_id FROM solicitudes_pago WHERE id = $1', [sid])).rows[0];
  c(fila?.requisicion_id === id1 && fila?.requisicion_cotizacion_id === cot3.cuerpo.data.id, 'la solicitud sabe de qué requisición sale y a qué cotización le compra');
  const adjSol = await query<{ nombre_original: string; r2_key: string }>('SELECT nombre_original, r2_key FROM solicitud_pago_adjuntos WHERE solicitud_pago_id = $1 ORDER BY id', [sid]);
  c(adjSol.rows.map((a) => a.nombre_original).join() === 'cotizacion.pdf,aceros.pdf,comparativo.pdf,REQ-PRU3-175.pdf', `lleva las dos cotizaciones, el cuadro y el papel (dio ${adjSol.rows.map((a) => a.nombre_original)})`);
  c(adjSol.rows.every((a) => a.r2_key.startsWith(`solicitudes-pago/${sid}/`)), 'copiados a la carpeta de la solicitud');
  const { downloadFile, deleteFile } = await import('../src/services/storage.js');
  const papelSol = adjSol.rows.find((a) => a.nombre_original === 'REQ-PRU3-175.pdf');
  const bytesPapel = papelSol ? await downloadFile(papelSol.r2_key).catch(() => null) : null;
  c(!!bytesPapel && bytesPapel.subarray(0, 5).toString() === '%PDF-', 'el papel adjunto es un PDF de verdad');
  const copia = adjSol.rows.find((a) => a.nombre_original === 'aceros.pdf');
  const bytesCopia = copia ? await downloadFile(copia.r2_key).catch(() => null) : null;
  c(!!bytesCopia && bytesCopia.equals(PDF), 'y la cotización copiada es el mismo archivo');

  const tras = (await pedir('GET', `/requisiciones/${id1}`, undefined, tk.martina)).cuerpo.data;
  c(tras.lineas[0].marca === 'parcial' && tras.lineas[1].marca === 'atendida', `las líneas quedan Parcial y Atendida (dio ${tras.lineas[0].marca}, ${tras.lineas[1].marca})`);
  c(tras.lineas[0].compras?.[0]?.numero === sNumero && tras.lineas[2].compras?.length === 0, 'cada línea dice en qué solicitud va');
  c(tras.compras?.length === 1 && tras.compras[0].lineas?.length === 2 && tras.compras[0].tipo === 'solicitud', 'y la requisición la cuenta una vez, con sus dos líneas');
  const vistaCecilia = (await pedir('GET', `/requisiciones/${id1}`, undefined, tk.cecilia)).cuerpo.data;
  c(vistaCecilia.lineas[0].compras?.[0]?.numero === sNumero, 'quien la escribió también lo ve');

  const entradaCemento = (await pedir('GET', `/cotizaciones/${entradas.rows[0].id}`)).cuerpo.data;
  const ofertasCemento = entradaCemento.ofertas as { requisicion_cotizacion_id: number; comprada_en: string[] }[];
  c(ofertasCemento.find((o) => o.requisicion_cotizacion_id === cot3.cuerpo.data.id)?.comprada_en?.join() === sNumero, 'en Cotizaciones, la de Aceros sale comprada en esa solicitud');
  c(ofertasCemento.find((o) => o.requisicion_cotizacion_id === cot2.cuerpo.data.id)?.comprada_en?.length === 0, 'y la del cemento no');

  // Editarla con el formulario no le borra la requisición (antes sí).
  const editada = await pedir('PUT', `/solicitudes-pago/${sid}`, { ...SOL, observaciones: 'Entrega el jueves' }, tk.martina);
  c(editada.estado === 200, `la solicitud se edita (dio ${editada.estado})`);
  const trasEditar = (await query<{ requisicion_id: number }>('SELECT requisicion_id FROM solicitudes_pago WHERE id = $1', [sid])).rows[0];
  c(trasEditar.requisicion_id === id1, 'y sigue amarrada a la requisición');
  // Y por la puerta de siempre no se amarra nada: el enlace sale solo de aquí.
  const suelta = await pedir('POST', '/solicitudes-pago', { ...SOL, requisicion_id: id1 }, tk.martina);
  const sueltaFila = (await query<{ requisicion_id: number | null }>('SELECT requisicion_id FROM solicitudes_pago WHERE id = $1', [suelta.cuerpo?.solicitud?.id])).rows[0];
  c(suelta.estado === 201 && sueltaFila?.requisicion_id === null, 'una solicitud normal no se puede colgar de una requisición a mano');

  // Las copias viven bajo solicitudes-pago/, que el barrido de las pruebas no
  // toca (ahí guarda también la copia local): se borran aquí.
  for (const a of adjSol.rows) await deleteFile(a.r2_key).catch(() => undefined);

  // ------------------------------- la orden de compra desde la requisición
  // Igual que la solicitud. Aquí, la línea 3 a un proveedor sin cotización.
  await llaves(martina, { ordenes_ver: true });
  const ORD = {
    proyecto_id: P,
    proveedor: 'Plomería del Centro',
    items: [{ cantidad: 10, unidad: 'unidades', descripcion: 'Codo de PVC 6 a 90', precio_unitario: 12.5 }],
  };
  const desdeOrden = { requisicion_id: id1, lineas: [{ id: lineas1[2].id }], cotizacion_id: null, adjuntar: { papel: true } };
  c((await pedir('POST', '/ordenes-compra', { ...ORD, desde_requisicion: { ...desdeOrden, cotizacion_id: cot3.cuerpo.data.id } }, tk.martina)).estado === 400, 'la orden tampoco le compra a una cotización que no cubre la línea');
  const oc = await pedir('POST', '/ordenes-compra', { ...ORD, desde_requisicion: desdeOrden }, tk.martina);
  c(oc.estado === 201 && oc.cuerpo?.adjuntos_fallidos?.length === 0, `Martina crea la orden desde la requisición (dio ${oc.estado} ${JSON.stringify(oc.cuerpo?.error ?? '')})`);
  const ocId = oc.cuerpo?.data?.id as number;
  const ocFila = (await query<{ requisicion_id: number; requisicion_cotizacion_id: number | null }>('SELECT requisicion_id, requisicion_cotizacion_id FROM ordenes_compra WHERE id = $1', [ocId])).rows[0];
  c(ocFila?.requisicion_id === id1 && ocFila?.requisicion_cotizacion_id === null, 'la orden sabe de qué requisición sale, sin cotización');
  const adjOc = await query<{ nombre_original: string; descripcion: string; r2_key: string }>('SELECT nombre_original, descripcion, r2_key FROM orden_compra_adjuntos WHERE orden_compra_id = $1', [ocId]);
  c(adjOc.rows.length === 1 && adjOc.rows[0].nombre_original === 'REQ-PRU3-175.pdf' && adjOc.rows[0].descripcion === 'Requisición REQ-PRU3-175', 'lleva el papel, con su descripción');
  const conOrden = (await pedir('GET', `/requisiciones/${id1}`, undefined, tk.martina)).cuerpo.data;
  c(conOrden.lineas[2].marca === 'atendida' && conOrden.lineas[2].compras?.[0]?.tipo === 'orden', 'la línea 3 queda Atendida y dice en qué orden va');
  c(conOrden.compras?.length === 2, 'la requisición cuenta la solicitud y la orden');

  // ------------------------------------------------------------- el rastro
  const rastro = await query<{ accion: string }>("SELECT accion FROM audit_log WHERE entidad = 'requisicion'");
  const acciones = new Set(rastro.rows.map((r) => r.accion));
  for (const a of ['crear', 'editar', 'aprobar', 'anular', 'marcar', 'agregar_cotizacion', 'quitar_cotizacion', 'adjuntar', 'agregar_cuadro', 'quitar_adjunto', 'crear_solicitud', 'crear_orden']) {
    c(acciones.has(a), `queda rastro de «${a}»`);
  }
  const ajustesRastro = await query("SELECT 1 FROM audit_log WHERE accion = 'editar_ajustes_requisiciones' AND entidad_id = $1", [P]);
  c(ajustesRastro.rows.length > 0, 'y del cambio de ajustes');

  console.log(`${ok} pasaron, ${fallo} fallaron`);
  await pool.end();
  process.exit(fallo ? 1 : 0);
};

main();
