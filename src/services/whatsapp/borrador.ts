// Del cuaderno del asistente al reporte de verdad: armar el borrador, sacarle
// el PDF y, cuando el ingeniero lo pida, enviarlo.
//
// Nada de esto reimplementa el reporte. El borrador lo crea la MISMA funcion
// que usa la pantalla (crearBorradorDeReporte), el PDF lo arma el mismo
// generador, y el envio son las mismas dos llamadas que hace el boton «Guardar
// reporte»: completarReporte le pone numero, y la cola manda el correo.

import { query } from '../../database/config.js';
import {
  buildReportePdfInput,
  completarReporte,
  crearBorradorDeReporte,
} from '../../routes/proyectoReportes.js';
import { encolarEnvio } from '../reporteEnvio.js';
import { generateReportePDF } from '../reportePdf.js';
import { registrarAudit } from '../auditLog.js';
import { obligatoriasQueFaltan, type DatosReporte } from './datosReporte.js';
import type { Conversacion } from './conversacion.js';

/** Lo que el asistente lleva anotado, con la forma que espera el reporte. */
function comoCuerpoDeReporte(datos: DatosReporte) {
  return {
    fecha: datos.fecha,
    clima: datos.clima,
    horas_perdidas: datos.horasPerdidas ?? null,
    motivo: datos.motivo ?? null,
    // El reporte guarda el trabajo en puntos por area; las areas del dia son
    // las que tienen puntos, asi que ya no se mandan aparte. `que_se_hizo` solo
    // queda por si una conversacion venia a medias de antes del cambio.
    ...(datos.trabajos?.length
      ? { trabajos: datos.trabajos.map((t) => ({ area_id: t.areaId, texto: t.texto })) }
      : { areas: datos.areas ?? [], que_se_hizo: datos.queSeHizo }),
    atrasos: datos.atrasos ?? null,
    novedades: datos.novedades ?? null,
    personal: (datos.personal ?? []).map((p) => ({
      puesto_id: p.puestoId,
      cantidad: p.cantidad,
    })),
    equipos: (datos.equipos ?? []).map((e) => ({
      equipo_id: e.equipoId,
      unidades: e.unidades,
      horas: e.horas,
    })),
    entregas: (datos.entregas ?? []).map((e) => ({
      categoria_id: e.categoriaId,
      descripcion: e.descripcion,
      cantidad: e.cantidad,
      unidad: e.unidad,
      notas: e.notas,
    })),
  };
}

/** Las fotos que la persona mando en esta conversacion, en orden. */
async function fotosDeLaConversacion(conversacionId: number) {
  const r = await query<{
    r2_key: string;
    tipo_mime: string | null;
    tamano: number | null;
    texto: string | null;
  }>(
    `SELECT r2_key, tipo_mime, tamano, texto
       FROM whatsapp_mensajes
      WHERE conversacion_id = $1 AND direccion = 'entrante'
        AND r2_key IS NOT NULL AND tipo IN ('image', 'document')
      ORDER BY id`,
    [conversacionId],
  );
  return r.rows;
}

/**
 * Deja listo el borrador con lo anotado hasta ahora.
 *
 * Si ya habia uno de un intento anterior, se da de baja y se hace otro. Suena
 * a desperdicio y es lo correcto: el borrador tiene que decir exactamente lo
 * que dice el cuaderno, y rehacerlo es una consulta, mientras que ir
 * parcheandolo campo por campo es la clase de codigo donde se cuelan los datos
 * viejos. Las fotos no se vuelven a subir: las filas nuevas apuntan al mismo
 * archivo que ya esta guardado.
 */
export async function armarBorrador(
  conversacion: Conversacion,
): Promise<{ ok: true; reporteId: number } | { ok: false; motivo: string }> {
  if (conversacion.proyectoId === null) {
    return { ok: false, motivo: 'Todavía no hay proyecto elegido' };
  }
  const faltan = obligatoriasQueFaltan(conversacion.datos);
  if (faltan.length > 0) {
    return {
      ok: false,
      motivo: `Falta ${faltan.map((s) => s.nombre.toLowerCase()).join(' y ')}`,
    };
  }

  if (conversacion.reporteId !== null) {
    await query(
      `UPDATE proyecto_reportes SET activo = false
        WHERE id = $1 AND completo = false AND activo = true`,
      [conversacion.reporteId],
    );
  }

  const creado = await crearBorradorDeReporte(
    conversacion.proyectoId,
    comoCuerpoDeReporte(conversacion.datos),
    conversacion.userId,
  );
  if (!creado.ok) return creado;

  const fotos = await fotosDeLaConversacion(conversacion.id);
  for (const [i, f] of fotos.entries()) {
    await query(
      `INSERT INTO proyecto_reporte_fotos
         (reporte_id, nombre_archivo, r2_key, tipo_mime, tamano, orden, creado_por, leyenda)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        creado.id,
        `whatsapp-${i + 1}.jpg`,
        f.r2_key,
        f.tipo_mime,
        f.tamano,
        i + 1,
        conversacion.userId,
        // El pie que la persona le escribio a la foto en WhatsApp es la leyenda
        // del reporte: es exactamente lo que quiso decir de esa foto.
        (f.texto ?? '').trim().slice(0, 150) || null,
      ],
    );
  }

  return { ok: true, reporteId: creado.id };
}

/** El PDF del borrador: el mismo papel, con «BORRADOR» cruzado y sin numero. */
export async function pdfDelBorrador(reporteId: number): Promise<Buffer | null> {
  const datos = await buildReportePdfInput(reporteId, true);
  if (!datos) return null;
  return generateReportePDF({ ...datos, borrador: true });
}

/** El PDF del reporte ya enviado, el mismo que sale por correo. */
export async function pdfFinal(reporteId: number): Promise<Buffer | null> {
  const datos = await buildReportePdfInput(reporteId);
  if (!datos) return null;
  return generateReportePDF(datos);
}

/**
 * Lo mismo que hace «Guardar reporte» en la pantalla: el borrador pasa a ser
 * reporte —con su numero— y el correo se pone en cola.
 *
 * El correo no se espera aqui, igual que no se espera en la pantalla: armar el
 * PDF y hablar con Resend tarda, y el ingeniero no tiene que quedarse mirando
 * el telefono por un correo que no le incumbe.
 */
export async function enviarReporte(
  conversacion: Conversacion,
): Promise<{ ok: true; numero: string } | { ok: false; motivo: string }> {
  if (conversacion.reporteId === null || conversacion.proyectoId === null) {
    return { ok: false, motivo: 'Todavía no hay borrador que enviar' };
  }
  const completado = await completarReporte(conversacion.reporteId, conversacion.proyectoId);
  if (!completado) return { ok: false, motivo: 'Ese borrador ya no existe' };

  await encolarEnvio(conversacion.reporteId);
  await registrarAudit(
    conversacion.userId,
    'enviar',
    'reporte_diario',
    conversacion.reporteId,
    { encolado: true, numero: completado.numero, por: 'whatsapp' },
  );
  return { ok: true, numero: completado.numero };
}

/** Como se llama el archivo que recibe la persona. */
export function nombreArchivo(numero: string | null, fecha: string | undefined): string {
  const dia = (fecha ?? '').replace(/-/g, '') || 'reporte';
  return numero ? `${numero}.pdf` : `Borrador-${dia}.pdf`;
}
