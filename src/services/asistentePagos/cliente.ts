// src/services/asistentePagos/cliente.ts
// El conector con Anthropic.
//
// La llave es OPCIONAL, como la del correo: si no esta, el asistente no existe
// y el resto del sistema sigue igual. Un servidor no se cae porque falte una
// funcion de conveniencia.

import Anthropic from '@anthropic-ai/sdk';

let cliente: Anthropic | null = null;

/** Hay llave configurada? La pantalla lo pregunta para no ensenar el panel
 *  cuando no se puede usar. */
export function estaConfigurado(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/** El cliente, creado la primera vez que hace falta. null si no hay llave. */
export function obtenerCliente(): Anthropic | null {
  if (!estaConfigurado()) return null;
  if (!cliente) cliente = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return cliente;
}
