/**
 * El papel de una requisicion.
 *
 * Sale con el nombre y el logo del consorcio cuando el proyecto es de uno, y con
 * los de Pinellas si no: la misma regla del reporte diario (Ivan, 2026-10-02).
 * Donde el papel de Santa Isabel lleva la firma escaneada del jefe del
 * proyecto, este dice quien la aprobo y cuando: la aprobacion se hizo en el
 * sistema, con su contraseña.
 *
 * Cuando va adjunto a una solicitud de pago, lleva TODAS las lineas que se
 * pidieron y marca las que van en esa solicitud, para que quien aprueba el pago
 * vea que se esta pagando y que no.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { aPdf, esc, HORA_PANAMA, logoPinellas, NAVY, GRAY, RULE } from './reportePdfComun.js';
import { nombreEmisor, nombrePropio, type Consorcio } from './consorcioProyecto.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export type MarcaLinea = 'pendiente' | 'atendida' | 'parcial' | 'cancelada';

export interface RequisicionPdfLinea {
  numero: number;
  cantidad: string | number;
  unidad: string | null;
  descripcion: string;
  renglon_desglose: string | null;
  marca: MarcaLinea;
  /** Solo cuando el papel va adjunto a una solicitud: si esa línea va en ella. */
  enEsta?: boolean;
}

export interface RequisicionPdfInput {
  numero: string;
  creada_at: Date | string;
  proyecto_nombre: string;
  consorcio: Consorcio | null;
  descripcion: string;
  fecha_requerida: Date | string;
  prioridad: 'normal' | 'urgente';
  estado: 'por_aprobar' | 'aprobada' | 'anulada';
  escrita_por: string;
  aprobada_por: string | null;
  aprobada_at: Date | string | null;
  notas: string | null;
  beneficiario: string | null;
  banco: string | null;
  tipo_cuenta: string | null;
  numero_cuenta: string | null;
  lineas: RequisicionPdfLinea[];
  /** El papel adjunto a una solicitud de pago u orden: cuál, y a quién se le compra. */
  adjuntaA?: { numero: string; proveedor: string; tipo: 'solicitud' | 'orden' } | null;
  generado_at: Date;
}

const ETIQUETA_MARCA: Record<MarcaLinea, string> = {
  pendiente: 'Pendiente',
  atendida: 'Atendida',
  parcial: 'Parcial',
  cancelada: 'Cancelada',
};

/** Una fecha DATE de la base: pg la arma a la medianoche local, y así se lee. */
function dia(valor: Date | string): string {
  if (typeof valor === 'string') {
    const [a, m, d] = valor.slice(0, 10).split('-');
    return `${d}/${m}/${a}`;
  }
  return `${String(valor.getDate()).padStart(2, '0')}/${String(valor.getMonth() + 1).padStart(2, '0')}/${valor.getFullYear()}`;
}

/** El día de un momento (TIMESTAMPTZ), en la hora de Panamá. */
function diaDe(valor: Date | string): string {
  return DIA.format(typeof valor === 'string' ? new Date(valor) : valor);
}

// es-PA escribe el mes primero (10/06/2026 es el 6 de octubre): la fecha se
// arma con en-GB, que es día/mes/año, en la hora de Panamá.
const DIA = new Intl.DateTimeFormat('en-GB', { ...HORA_PANAMA, day: '2-digit', month: '2-digit', year: 'numeric' });
const HORA = new Intl.DateTimeFormat('es-PA', { ...HORA_PANAMA, hour: 'numeric', minute: '2-digit' });

/** Un momento (TIMESTAMPTZ), en la hora de Panamá. */
function momento(valor: Date | string): string {
  const d = typeof valor === 'string' ? new Date(valor) : valor;
  return `${DIA.format(d)} ${HORA.format(d)}`;
}

function cantidad(valor: string | number): string {
  const n = Number(valor);
  return Number.isInteger(n) ? n.toLocaleString('en-US') : n.toLocaleString('en-US', { maximumFractionDigits: 3 });
}

function bloque(etiqueta: string, linea1: string, linea2?: string | null): string {
  return `<div class="dato"><div class="etq">${esc(etiqueta)}</div>
    <div><div class="v1">${esc(linea1)}</div>${linea2 ? `<div class="v2">${esc(linea2)}</div>` : ''}</div></div>`;
}

function armarHtml(d: RequisicionPdfInput, logo: string): string {
  const conMarca = d.estado === 'aprobada';
  const conEsta = !!d.adjuntaA;
  const filas = d.lineas
    .map((l) => {
      const caja = conEsta
        ? `<td class="c"><span class="caja">${l.enEsta ? '&#10003;' : ''}</span></td>`
        : '';
      return `<tr class="${l.enEsta ? 'esta' : ''}">
        <td class="c num">${l.numero}</td>
        <td class="r num">${esc(cantidad(l.cantidad))}</td>
        <td>${esc(l.unidad ?? '')}</td>
        <td>${esc(l.descripcion)}</td>
        <td class="c num">${esc(l.renglon_desglose ?? '')}</td>
        ${conMarca ? `<td>${ETIQUETA_MARCA[l.marca]}</td>` : ''}
        ${caja}
      </tr>`;
    })
    .join('');

  const bancarios = [d.beneficiario, d.banco, d.numero_cuenta].some((v) => v && v.trim());
  const cuenta = [
    d.banco,
    d.tipo_cuenta ? (d.tipo_cuenta === 'ahorro' ? 'Ahorro' : 'Corriente') : null,
    d.numero_cuenta,
  ]
    .filter((v) => v && String(v).trim())
    .join(' · ');

  const aprobacion =
    d.estado === 'aprobada' && d.aprobada_por && d.aprobada_at
      ? bloque('Aprobada por', d.aprobada_por, `${momento(d.aprobada_at)} · con su contraseña en el sistema`)
      : d.estado === 'anulada'
        ? bloque('Estado', 'Anulada')
        : bloque('Estado', 'Por aprobar');

  const tipoDoc = d.adjuntaA?.tipo === 'orden' ? 'a la orden de compra' : 'a la solicitud de pago';

  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><style>
    @page { size: letter; }
    body { margin:0; font-family: Arial, Helvetica, sans-serif; color:#0f172a; font-size:11.5px; }
    .cab { display:flex; justify-content:space-between; align-items:flex-start; gap:24px; }
    .logo { height:44px; }
    .marca-propia { font-size:16px; font-weight:700; color:${NAVY}; }
    h1 { margin:0; font-family: Georgia, 'Times New Roman', serif; font-size:22px; letter-spacing:0.02em; color:${NAVY}; text-align:right; }
    .num-doc { margin-top:6px; text-align:right; font-size:12px; }
    .num-doc b { font-size:13px; }
    .aviso { margin-top:16px; padding:8px 12px; border:1px solid #0F766E; border-radius:4px; background:rgba(15,118,110,0.06); font-size:12px; }
    .datos { margin-top:14px; }
    .dato { display:grid; grid-template-columns:120px 1fr; gap:12px; padding:7px 0; border-bottom:1px solid ${RULE}; }
    .etq { font-size:10px; font-weight:700; letter-spacing:0.04em; text-transform:uppercase; color:${GRAY}; }
    .v1 { font-size:12px; font-weight:600; }
    .v2 { font-size:11.5px; color:#334155; }
    table { width:100%; border-collapse:collapse; margin-top:16px; }
    th { padding:7px 8px; border:1px solid #94A3B8; background:#E2E8F0; font-size:10px; font-weight:700; letter-spacing:0.04em; text-transform:uppercase; text-align:left; }
    td { padding:7px 8px; border:1px solid #CBD5E1; vertical-align:top; }
    td.c, th.c { text-align:center; } td.r, th.r { text-align:right; }
    .num { font-variant-numeric: tabular-nums; }
    tr.esta td { background:rgba(15,118,110,0.06); }
    .caja { display:inline-block; width:12px; height:12px; line-height:12px; border:1.5px solid #0f172a; border-radius:2px; font-size:10px; }
    .notas { margin-top:16px; padding:10px 12px; border:1px solid #CBD5E1; border-radius:4px; white-space:pre-line; }
    .pie { margin-top:18px; font-size:10px; color:${GRAY}; }
  </style></head><body>
    <div class="cab">
      ${logo ? `<img class="logo" src="${esc(logo)}" alt="${esc(nombrePropio(d.consorcio))}">` : `<span class="marca-propia">${esc(nombrePropio(d.consorcio))}</span>`}
      <div>
        <h1>REQUISICIÓN</h1>
        <div class="num-doc">N° <b>${esc(d.numero)}</b></div>
        <div class="num-doc">Fecha ${diaDe(d.creada_at)}</div>
      </div>
    </div>
    ${
      d.adjuntaA
        ? `<div class="aviso">Adjunta ${tipoDoc} <b>${esc(d.adjuntaA.numero)}</b> · ${esc(d.adjuntaA.proveedor)}. Las líneas que van en ella están marcadas.</div>`
        : ''
    }
    <div class="datos">
      ${bloque('Proyecto', d.proyecto_nombre, d.consorcio?.nombre ?? null)}
      ${bloque('Descripción', d.descripcion)}
      ${bloque('Fecha requerida', `${dia(d.fecha_requerida)} · ${d.prioridad === 'urgente' ? 'Urgente' : 'Normal'}`)}
      ${bloque('Escrita por', d.escrita_por, momento(d.creada_at))}
      ${aprobacion}
      ${bancarios ? bloque('Datos bancarios', d.beneficiario ?? '', cuenta) : ''}
    </div>
    <table>
      <thead><tr>
        <th class="c" style="width:30px">N°</th>
        <th class="r" style="width:56px">Cant.</th>
        <th style="width:70px">Unidad</th>
        <th>Descripción</th>
        <th class="c" style="width:84px">Desglose</th>
        ${conMarca ? '<th style="width:70px">Marca</th>' : ''}
        ${conEsta ? '<th class="c" style="width:70px">En esta</th>' : ''}
      </tr></thead>
      <tbody>${filas}</tbody>
    </table>
    ${d.notas ? `<div class="notas"><div class="etq">Notas</div>${esc(d.notas)}</div>` : ''}
    <div class="pie">Generado el ${momento(d.generado_at)} por el sistema.</div>
  </body></html>`;
}

export async function generarRequisicionPDF(d: RequisicionPdfInput): Promise<Buffer> {
  // En un consorcio va SU logo, y si todavía no lo subieron, su nombre: el de
  // Pinellas en el papel de un consorcio diría quién no es.
  const logo = d.consorcio ? d.consorcio.logo ?? '' : logoPinellas(__dirname);
  return aPdf(armarHtml(d, logo), `${nombreEmisor(d.consorcio)} — Requisición ${d.numero}`);
}
