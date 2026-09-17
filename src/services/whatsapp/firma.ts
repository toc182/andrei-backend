// La puerta por donde entra WhatsApp no puede pedir contrasena: quien llama es
// Meta, no una persona con sesion. Lo que la protege es la firma.
//
// Meta firma cada entrega con el secreto de la aplicacion y manda el resultado
// en la cabecera X-Hub-Signature-256. Si la firma no cuadra con el cuerpo tal
// cual llego, el mensaje no es de Meta y se tira.
//
// Por eso esta ruta necesita el cuerpo EN CRUDO. Si se dejara que Express lo
// convirtiera a objeto y despues se volviera a convertir a texto, un espacio o
// un acento distinto cambiaria la firma y nada cuadraria nunca.

import crypto from 'crypto';

/**
 * Es de Meta?
 *
 * Sin secreto configurado devuelve false, y eso es a proposito: preferimos no
 * recibir nada a recibir cualquier cosa de cualquiera. El unico sintoma es que
 * la puerta contesta 401 y en los registros queda dicho.
 */
export function firmaValida(crudo: Buffer, cabecera: string | undefined): boolean {
  const secreto = process.env.WHATSAPP_APP_SECRET;
  if (!secreto || !cabecera) return false;

  const esperada = 'sha256=' + crypto.createHmac('sha256', secreto).update(crudo).digest('hex');

  // Comparacion de tiempo constante. timingSafeEqual exige que midan lo mismo,
  // asi que la longitud se comprueba antes y no se le pasan dos largos
  // distintos, que lanzaria.
  const a = Buffer.from(esperada);
  const b = Buffer.from(cabecera);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
