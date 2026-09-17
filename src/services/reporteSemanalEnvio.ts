/**
 * Lo que convierte un reporte semanal en papel y en correo.
 *
 * Mismo camino que el diario: al enviarlo se pone en la cola, y el cron lo
 * archiva en R2 y lo manda por su cuenta, reintentando. El ingeniero nunca oye
 * hablar de correo —«el correo no le interesa al ingeniero»—, y si tras todos
 * los intentos no sale, se le avisa al admin.
 *
 * Va aparte de la ruta (a diferencia del diario, donde esto vive en
 * routes/proyectoReportes.ts) porque aquí no hace falta el círculo: el servicio
 * no necesita nada de la ruta.
 */

import { query } from '../database/config.js';
import { uploadFile } from './storage.js';
import { sendEmail } from './emailService.js';
import {
  MAX_INTENTOS, anotarFallo, marcarAvisado, marcarEnviado, reservarPendientes,
} from './reporteEnvio.js';
import { consorcioDelProyecto } from './consorcioProyecto.js';
import { diasDeLaSemana, domingoDe, lunesDe, semanaIso } from './reporteSemana.js';
import { datosDeLaSemana, type DatosSemana } from './reporteSemanalDatos.js';
import {
  generateReporteSemanalPDF, type MetaPdf, type ReporteSemanalPdfInput,
} from './reporteSemanalPdf.js';
import { HORA_PANAMA } from './reportePdfComun.js';
import type { CambioLegible } from './reporteCambios.js';

const CORREO_ADMINISTRACION =
  process.env.REPORTES_EMAIL_TO || 'ivan@pinellaspanama.com';

const MESES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];
const MESES_CORTOS = [
  'ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sept', 'oct', 'nov', 'dic',
];
const DIAS_CORTOS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];

const dia = (f: string) => Number(f.slice(8, 10));
const mes = (f: string) => Number(f.slice(5, 7)) - 1;
const anio = (f: string) => Number(f.slice(0, 4));

/** «7 al 13 de septiembre de 2026». */
export function semanaLarga(inicio: string, fin: string): string {
  if (mes(inicio) === mes(fin) && anio(inicio) === anio(fin)) {
    return `${dia(inicio)} al ${dia(fin)} de ${MESES[mes(fin)]} de ${anio(fin)}`;
  }
  if (anio(inicio) === anio(fin)) {
    return `${dia(inicio)} de ${MESES[mes(inicio)]} al ${dia(fin)} de ${MESES[mes(fin)]} de ${anio(fin)}`;
  }
  return `${dia(inicio)} de ${MESES[mes(inicio)]} de ${anio(inicio)} al ${dia(fin)} de ${MESES[mes(fin)]} de ${anio(fin)}`;
}

/** «Lun 7 – Dom 13 sept 2026», el recuadro de arriba del papel. */
function semanaCorta(inicio: string, fin: string): string {
  return `${DIAS_CORTOS[0]} ${dia(inicio)} – ${DIAS_CORTOS[6]} ${dia(fin)} ${MESES_CORTOS[mes(fin)]} ${anio(fin)}`;
}

/** «14 al 20 sept», el título del plan. */
function rangoCorto(inicio: string, fin: string): string {
  return mes(inicio) === mes(fin)
    ? `${dia(inicio)} al ${dia(fin)} ${MESES_CORTOS[mes(fin)]}`
    : `${dia(inicio)} ${MESES_CORTOS[mes(inicio)]} al ${dia(fin)} ${MESES_CORTOS[mes(fin)]}`;
}

const ymd = (f: Date | string): string => {
  if (f instanceof Date) {
    const y = f.getFullYear();
    const m = String(f.getMonth() + 1).padStart(2, '0');
    const d = String(f.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(f).slice(0, 10);
};

const numeroONull = (v: string | number | null): number | null =>
  v === null || v === undefined ? null : Number(v);

/**
 * Todo lo que el papel necesita. Los números salen de `datos`, congelados al
 * enviar; si el reporte todavía es borrador —el botón de ver el PDF antes de
 * enviarlo— se calculan al vuelo.
 */
export async function buildSemanalPdfInput(
  reporteId: number,
): Promise<(ReporteSemanalPdfInput & { proyectoId: number; proyectoCorto: string; autorEmail: string | null }) | null> {
  const r = await query<{
    id: number; proyecto_id: number; numero: string | null;
    semana_inicio: Date; semana_fin: Date; anio_iso: number; semana_iso: number;
    resumen: string | null; lo_que_se_espera: string | null; datos: DatosSemana | null;
    completo: boolean; autor: string; autor_email: string | null;
    proyecto_nombre: string; proyecto_corto: string;
    es_consorcio: boolean | null; contratista: string | null; logo_consorcio: string | null;
  }>(
    `SELECT s.id, s.proyecto_id, s.numero, s.semana_inicio, s.semana_fin,
            s.anio_iso, s.semana_iso, s.resumen, s.lo_que_se_espera, s.datos, s.completo,
            u.nombre AS autor, u.email AS autor_email,
            p.nombre AS proyecto_nombre,
            COALESCE(p.nombre_corto, p.nombre) AS proyecto_corto,
            (p.datos_adicionales->>'es_consorcio')::boolean AS es_consorcio,
            p.contratista, p.logo_consorcio
       FROM proyecto_reportes_semanales s
       JOIN users u ON u.id = s.creado_por
       JOIN proyectos p ON p.id = s.proyecto_id
      WHERE s.id = $1 AND s.activo = true`,
    [reporteId],
  );
  if (r.rows.length === 0) return null;
  const s = r.rows[0];

  const inicio = ymd(s.semana_inicio);
  const fin = ymd(s.semana_fin);
  const datos = s.datos ?? (await datosDeLaSemana(s.proyecto_id, inicio));

  const [metas, metasPlan, problemas, decisiones, fotos, correcciones] = await Promise.all([
    query<{
      texto: string; cantidad: string | null; unidad: string | null;
      estado: MetaPdf['estado']; cantidad_hecha: string | null; porcentaje: number | null;
      motivo: string | null; fuera_del_plan: boolean;
    }>(
      `SELECT texto, cantidad, unidad, estado, cantidad_hecha, porcentaje, motivo,
              (reporte_plan_id IS NULL) AS fuera_del_plan
         FROM proyecto_reporte_semanal_metas
        WHERE reporte_evaluacion_id = $1
        ORDER BY CASE estado
                   WHEN 'completada' THEN 1
                   WHEN 'parcial' THEN 2
                   WHEN 'no_completada' THEN 3
                   ELSE 4 END,
                 orden, id`,
      [reporteId],
    ),
    query<{ texto: string; cantidad: string | null; unidad: string | null }>(
      `SELECT texto, cantidad, unidad FROM proyecto_reporte_semanal_metas
        WHERE reporte_plan_id = $1 ORDER BY orden, id`,
      [reporteId],
    ),
    query<{ fecha: Date | null; problema: string; accion: string | null }>(
      `SELECT fecha, problema, accion FROM proyecto_reporte_semanal_problemas
        WHERE reporte_id = $1 ORDER BY orden, id`,
      [reporteId],
    ),
    query<{ texto: string }>(
      `SELECT texto FROM proyecto_reporte_semanal_decisiones
        WHERE reporte_id = $1 ORDER BY orden, id`,
      [reporteId],
    ),
    query<{
      r2_key: string; nombre_archivo: string; tipo_mime: string | null;
      leyenda: string | null; fecha: Date;
    }>(
      `SELECT f.r2_key, f.nombre_archivo, f.tipo_mime, f.leyenda, r.fecha
         FROM proyecto_reporte_semanal_fotos sf
         JOIN proyecto_reporte_fotos f ON f.id = sf.foto_id
         JOIN proyecto_reportes r ON r.id = f.reporte_id
        WHERE sf.reporte_id = $1
        ORDER BY sf.orden, sf.id`,
      [reporteId],
    ),
    query<{ created_at: Date; quien: string; cambios: CambioLegible[] }>(
      `SELECT c.created_at, u.nombre AS quien, c.cambios
         FROM proyecto_reporte_semanal_correcciones c
         JOIN users u ON u.id = c.creado_por
        WHERE c.reporte_id = $1
        ORDER BY c.created_at`,
      [reporteId],
    ),
  ]);

  // La semana siguiente, la del plan.
  const proximoLunes = diasDeLaSemana(inicio)[6];
  const proximoInicio = lunesDe(ymd(new Date(new Date(`${proximoLunes}T12:00:00Z`).getTime() + 24 * 60 * 60 * 1000)));

  // En un proyecto en consorcio, el papel sale con su nombre y su logo.
  const consorcio = consorcioDelProyecto(s);

  return {
    proyectoId: s.proyecto_id,
    numero: s.numero ?? 'BORRADOR',
    semanaIso: s.semana_iso,
    anioIso: s.anio_iso,
    semanaLarga: semanaLarga(inicio, fin),
    semanaCorta: semanaCorta(inicio, fin),
    proximaSemana: rangoCorto(proximoInicio, domingoDe(proximoInicio)),
    proximaSemanaIso: semanaIso(proximoInicio).semana,
    proyectoNombre: s.proyecto_corto,
    proyectoCorto: s.proyecto_corto,
    consorcio,
    autorNombre: s.autor,
    autorEmail: s.autor_email,
    resumen: s.resumen,
    loQueSeEspera: s.lo_que_se_espera,
    datos,
    metas: metas.rows.map((m) => ({
      texto: m.texto,
      cantidad: numeroONull(m.cantidad),
      unidad: m.unidad,
      estado: m.estado,
      cantidad_hecha: numeroONull(m.cantidad_hecha),
      porcentaje: m.porcentaje,
      motivo: m.motivo,
      fuera_del_plan: m.fuera_del_plan,
    })),
    metasPlan: metasPlan.rows.map((m) => ({
      texto: m.texto, cantidad: numeroONull(m.cantidad), unidad: m.unidad,
    })),
    problemas: problemas.rows.map((p) => ({
      fecha: p.fecha ? ymd(p.fecha) : null, problema: p.problema, accion: p.accion,
    })),
    decisiones: decisiones.rows.map((d) => d.texto),
    // La fecha y la hora, ya escritas en la de Panamá: el papel no puede
    // depender de en qué zona corra el servidor.
    correcciones: correcciones.rows.map((c) => ({
      fecha: c.created_at.toLocaleDateString('es-PA', {
        ...HORA_PANAMA, day: 'numeric', month: 'short', year: 'numeric',
      }),
      hora: c.created_at.toLocaleTimeString('es-PA', {
        ...HORA_PANAMA, hour: 'numeric', minute: '2-digit',
      }),
      quien: c.quien,
      cambios: c.cambios ?? [],
    })),
    fotos: fotos.rows.map((f) => ({
      r2_key: f.r2_key,
      nombre_archivo: f.nombre_archivo,
      tipo_mime: f.tipo_mime,
      leyenda: f.leyenda,
      fecha: ymd(f.fecha),
    })),
  };
}

function limpiarNombre(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_');
}

/**
 * Congela el PDF en R2 y lo apunta en proyecto_reporte_semanal_pdfs.
 *
 * La primera versión se guarda como <numero>.pdf; cada corrección deja -v2,
 * -v3… igual que en el diario y en las solicitudes de pago.
 */
export async function archivarSemanalPdf(
  reporteId: number,
): Promise<{ buffer: Buffer; version: number; key: string } | null> {
  const datos = await buildSemanalPdfInput(reporteId);
  if (!datos) return null;

  const previas = await query<{ total: string }>(
    'SELECT COUNT(*)::text AS total FROM proyecto_reporte_semanal_pdfs WHERE reporte_id = $1',
    [reporteId],
  );
  const version = parseInt(previas.rows[0].total, 10) + 1;
  const sufijo = version === 1 ? '' : `-v${version}`;
  const key = `${limpiarNombre(datos.proyectoCorto)}/reportes-semanales/${datos.numero}${sufijo}.pdf`;

  const buffer = await generateReporteSemanalPDF(datos);
  await uploadFile(key, buffer, 'application/pdf');

  await query(
    `INSERT INTO proyecto_reporte_semanal_pdfs (reporte_id, version, r2_key)
     VALUES ($1, $2, $3)
     ON CONFLICT (reporte_id, version) DO NOTHING`,
    [reporteId, version, key],
  );

  return { buffer, version, key };
}

/**
 * Archiva la versión del PDF que ya dice lo que dice esa corrección.
 *
 * La marca se pone solo si la corrección no se movió mientras el PDF se armaba:
 * si alguien guardó otra cosa en medio, la fila se queda pendiente y la
 * siguiente pasada la archiva otra vez. Mismo cuidado que en el diario.
 */
export async function archivarCorreccionSemanal(
  reporteId: number,
  correccionId: number,
): Promise<void> {
  const archivado = await archivarSemanalPdf(reporteId);
  if (!archivado) return;
  await query(
    `UPDATE proyecto_reporte_semanal_correcciones
        SET pdf_version = $1
      WHERE id = $2 AND pdf_version IS NULL`,
    [archivado.version, correccionId],
  );
}

/**
 * Las correcciones que se quedaron sin su PDF archivado. Las archiva el barrido
 * de la madrugada: no hay ninguna prisa —la pantalla y la descarga arman el PDF
 * al vuelo mientras tanto—, pero la constancia de lo que decía el papel después
 * de cada corrección sí tiene que quedar.
 */
export async function archivarCorreccionesSemanalesPendientes(): Promise<number> {
  const pendientes = await query<{ id: number; reporte_id: number }>(
    `SELECT c.id, c.reporte_id
       FROM proyecto_reporte_semanal_correcciones c
       JOIN proyecto_reportes_semanales s ON s.id = c.reporte_id
      WHERE c.pdf_version IS NULL AND s.activo = true
      ORDER BY c.created_at
      LIMIT 20`,
  );
  let hechas = 0;
  for (const p of pendientes.rows) {
    try {
      await archivarCorreccionSemanal(p.reporte_id, p.id);
      hechas += 1;
    } catch (err) {
      console.error(`[reporteSemanal] no se pudo archivar la correccion ${p.id}:`, err);
    }
  }
  return hechas;
}

const escaparHtml = (s: string): string =>
  s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);

/** Avisa al admin de que un reporte no salió ni reintentando. */
async function avisarFallo(reporteId: number, numero: string, motivo: string): Promise<void> {
  try {
    await sendEmail(
      [CORREO_ADMINISTRACION],
      `No se pudo enviar el reporte semanal ${numero}`,
      `<p>El reporte semanal <b>${numero}</b> no pudo enviarse después de
          ${MAX_INTENTOS} intentos.</p>
       <p>Último motivo: <code>${escaparHtml(motivo)}</code></p>
       <p>El reporte está guardado; no se perdió nada de lo que escribió el ingeniero.</p>`,
    );
    await marcarAvisado(reporteId, 'semanal');
  } catch (err) {
    console.error(`[reporteSemanal] no se pudo avisar del fallo de ${numero}:`, err);
  }
}

/**
 * El trabajador de la cola de los semanales. Lo llama el cron; no hay endpoint
 * que lo dispare.
 *
 * Cada reporte se intenta por separado: que uno falle no puede dejar sin mandar
 * a los demás, y el motivo real se guarda en la fila para no tener que ir a
 * leer los registros del servidor.
 */
export async function procesarEnviosSemanalesPendientes(): Promise<void> {
  const enCola = await reservarPendientes(10, 'semanal');
  if (enCola.length === 0) return;

  for (const r of enCola) {
    let numero = `#${r.id}`;
    try {
      const archivado = await archivarSemanalPdf(r.id);
      if (!archivado) throw new Error('El reporte ya no existe');

      const datos = await buildSemanalPdfInput(r.id);
      if (!datos) throw new Error('El reporte ya no existe');
      numero = datos.numero;

      const destinatarios = [CORREO_ADMINISTRACION];
      if (datos.autorEmail && !destinatarios.includes(datos.autorEmail)) {
        destinatarios.push(datos.autorEmail);
      }

      await sendEmail(
        destinatarios,
        `Reporte semanal ${datos.numero} — ${datos.proyectoNombre}`,
        `<p>Reporte semanal de la <b>semana ${datos.semanaIso}</b>
            (${datos.semanaLarga}) en <b>${datos.proyectoNombre}</b>,
            elaborado por ${datos.autorNombre}.</p>
         <p>El PDF va adjunto.</p>`,
        [{ filename: `${datos.numero}.pdf`, content: archivado.buffer }],
      );

      await marcarEnviado(r.id, 'semanal');
      console.log(`📧 Reporte semanal ${numero} enviado a ${destinatarios.join(', ')}`);
    } catch (err) {
      const motivo = err instanceof Error ? err.message : String(err);
      console.error(`[reporteSemanal] falló el envío de ${numero}: ${motivo}`);
      const seAcabaron = await anotarFallo(r.id, r.envio_intentos, motivo, 'semanal');
      if (seAcabaron) await avisarFallo(r.id, numero, motivo);
    }
  }
}
