// Como se escribe un numero de WhatsApp dentro del sistema.
//
// Meta manda siempre el numero completo, solo digitos y sin «+»: 50766199092.
// Si en la ficha de la persona quedara guardado «6619-9092» o «+507 6619 9092»,
// no coincidiria nunca con lo que llega y el sistema no sabria de quien es el
// mensaje. Por eso lo que se escribe a mano pasa antes por aqui.

/** Panama. Un celular de aqui son 8 digitos y empieza por 6. */
const PANAMA = '507';

export type Normalizado =
  | { ok: true; numero: string | null }
  | { ok: false; motivo: string };

/**
 * Deja el numero como lo manda Meta, o dice por que no puede.
 *
 * Vacio significa «esta persona no tiene WhatsApp registrado» y se guarda como
 * nulo; no es un error.
 *
 * Los 8 digitos sueltos se completan con el 507 porque es lo que cualquiera de
 * la oficina va a escribir. Un numero de otro pais hay que escribirlo entero,
 * con su codigo: adivinarlo seria mandarle los reportes a un desconocido.
 */
export function normalizarWhatsapp(valor: unknown): Normalizado {
  if (valor === null || valor === undefined) return { ok: true, numero: null };
  if (typeof valor !== 'string') return { ok: false, motivo: 'El WhatsApp no es un texto' };

  const crudo = valor.trim();
  if (crudo === '') return { ok: true, numero: null };

  const digitos = crudo.replace(/\D/g, '');
  if (digitos === '') {
    return { ok: false, motivo: 'El WhatsApp no tiene números' };
  }

  const completo = digitos.length === 8 ? `${PANAMA}${digitos}` : digitos;

  // El tope de largo de un numero internacional son 15 digitos (E.164); por
  // abajo, menos de 10 no alcanza para pais mas numero.
  if (completo.length < 10 || completo.length > 15) {
    return {
      ok: false,
      motivo: 'El WhatsApp debe llevar el código del país, por ejemplo 507 6000 0000',
    };
  }

  return { ok: true, numero: completo };
}
