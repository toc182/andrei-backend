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

/** El cliente, creado la primera vez que hace falta. null si no hay llave.
 *
 *  ANTHROPIC_BASE_URL solo lo usan las pruebas, que levantan un Anthropic de
 *  mentira: asi la conversacion entera se puede probar sin gastar ni depender
 *  de que el modelo conteste hoy lo mismo que ayer. En produccion no se pone y
 *  el cliente va al sitio de siempre. */
export function obtenerCliente(): Anthropic | null {
  if (!estaConfigurado()) return null;
  if (!cliente) {
    const base = process.env.ANTHROPIC_BASE_URL;
    cliente = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      ...(base ? { baseURL: base } : {}),
    });
  }
  return cliente;
}
