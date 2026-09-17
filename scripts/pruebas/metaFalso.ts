/**
 * El Meta de mentira.
 *
 * Una prueba de WhatsApp no puede hablar con Meta: mandaría mensajes a personas
 * de verdad y dependería de internet y de una cuenta. Así que el entorno de
 * pruebas levanta este servidor diminuto y le dice al servidor de pruebas que
 * Meta vive aquí (WHATSAPP_API_URL).
 *
 * Hace las tres cosas que el sistema le pide a Meta:
 *  - recibir los mensajes que mandamos y devolver un id, como hace el de verdad;
 *  - dar la dirección temporal de una foto;
 *  - entregar esa foto, y solo con el token, igual que el de verdad.
 *
 * Y dos que el de verdad no hace, para que la prueba pueda mirar: guardar una
 * foto de antemano y contar lo que se mandó.
 */

import http from 'http';
import net from 'net';
import { randomUUID } from 'crypto';

/** Lo que el sistema le mandó a «Meta». */
export interface Enviado {
  telefono: string;
  tipo: string;
  texto: string | null;
  waId: string;
  cuerpo: unknown;
}

export interface MetaFalso {
  /** Lo que va en WHATSAPP_API_URL. */
  url: string;
  cerrar: () => Promise<void>;
}

const esObjeto = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null;

const puertoLibre = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });

const leerCuerpo = (req: http.IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const trozos: Buffer[] = [];
    req.on('data', (d: Buffer) => trozos.push(d));
    req.on('end', () => resolve(Buffer.concat(trozos)));
    req.on('error', reject);
  });

/**
 * Levanta el Meta de mentira. Sin puerto, pide uno libre.
 *
 * Vive en SU PROPIO proceso (metaFalsoProceso.ts) y no dentro del corredor de
 * pruebas: el corredor lanza cada prueba con spawnSync y se queda bloqueado
 * hasta que termina, así que un servidor suyo no contestaría a nadie mientras
 * la prueba corre —ni a la prueba ni al servidor de pruebas.
 */
export async function arrancarMetaFalso(puertoPedido?: number): Promise<MetaFalso> {
  const puerto = puertoPedido ?? (await puertoLibre());
  const url = `http://127.0.0.1:${puerto}`;

  const enviados: Enviado[] = [];
  const archivos = new Map<string, { datos: Buffer; tipoMime: string }>();

  const servidor = http.createServer((req, res) => {
    void (async () => {
      const ruta = (req.url ?? '/').split('?')[0];
      const json = (codigo: number, cuerpo: unknown): void => {
        res.writeHead(codigo, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(cuerpo));
      };
      // Meta rechaza cualquier llamada sin token; el sistema tiene que mandarlo
      // también al bajar el archivo, que es el error clásico.
      const conToken = (req.headers.authorization ?? '').startsWith('Bearer ');

      // --- lo que solo existe para la prueba ---
      if (ruta === '/_prueba/enviados' && req.method === 'GET') {
        return json(200, enviados);
      }
      if (ruta === '/_prueba/media' && req.method === 'POST') {
        const cuerpo: unknown = JSON.parse((await leerCuerpo(req)).toString('utf8'));
        if (!esObjeto(cuerpo) || typeof cuerpo.base64 !== 'string') {
          return json(400, { error: 'falta base64' });
        }
        const id = typeof cuerpo.mediaId === 'string' ? cuerpo.mediaId : randomUUID();
        archivos.set(id, {
          datos: Buffer.from(cuerpo.base64, 'base64'),
          tipoMime: typeof cuerpo.tipoMime === 'string' ? cuerpo.tipoMime : 'image/jpeg',
        });
        return json(200, { mediaId: id });
      }

      // --- lo que hace el Meta de verdad ---
      const bajar = /^\/_prueba\/bajar\/(.+)$/.exec(ruta);
      if (bajar) {
        const archivo = archivos.get(bajar[1]);
        if (!conToken) return json(401, { error: { message: 'falta el token' } });
        if (!archivo) return json(404, { error: { message: 'no existe' } });
        res.writeHead(200, { 'Content-Type': archivo.tipoMime });
        return res.end(archivo.datos);
      }

      const mensajes = /^\/([^/]+)\/messages$/.exec(ruta);
      if (mensajes && req.method === 'POST') {
        if (!conToken) return json(401, { error: { message: 'falta el token' } });
        const cuerpo: unknown = JSON.parse((await leerCuerpo(req)).toString('utf8'));
        const waId = `wamid.prueba.${enviados.length + 1}`;
        const c = esObjeto(cuerpo) ? cuerpo : {};
        enviados.push({
          telefono: typeof c.to === 'string' ? c.to : '',
          tipo: typeof c.type === 'string' ? c.type : '',
          texto: esObjeto(c.text) && typeof c.text.body === 'string' ? c.text.body : null,
          waId,
          cuerpo,
        });
        return json(200, {
          messaging_product: 'whatsapp',
          contacts: [{ wa_id: typeof c.to === 'string' ? c.to : '' }],
          messages: [{ id: waId }],
        });
      }

      const ficha = /^\/([^/]+)$/.exec(ruta);
      if (ficha && req.method === 'GET') {
        if (!conToken) return json(401, { error: { message: 'falta el token' } });
        const archivo = archivos.get(ficha[1]);
        if (!archivo) return json(404, { error: { message: 'no existe ese archivo' } });
        return json(200, {
          url: `${url}/_prueba/bajar/${ficha[1]}`,
          mime_type: archivo.tipoMime,
          file_size: archivo.datos.length,
        });
      }

      return json(404, { error: { message: `sin ruta para ${req.method} ${ruta}` } });
    })().catch((e: Error) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: e.message } }));
    });
  });

  await new Promise<void>((resolve) => servidor.listen(puerto, '127.0.0.1', resolve));

  return {
    url,
    cerrar: () => new Promise<void>((resolve) => servidor.close(() => resolve())),
  };
}
