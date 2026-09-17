// La puerta por la que WhatsApp entrega lo que la gente le escribe al numero de
// la empresa.
//
// Es la unica ruta del sistema sin authenticateToken, y no es un olvido: quien
// llama es Meta, que no tiene sesion ni la puede tener. Lo que hace de
// contrasena es la firma de cada entrega (services/whatsapp/firma.ts), que se
// comprueba contra el cuerpo en crudo antes de mirar nada mas.

import { Router, Request, Response } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { firmaValida } from '../services/whatsapp/firma.js';
import { procesarPayload } from '../services/whatsapp/entrantes.js';

const router = Router();

// GET /api/whatsapp/webhook
//
// El saludo de alta: al conectar la puerta, Meta llama una vez con una palabra
// acordada y un desafio, y espera el desafio de vuelta en texto pelado. Si se
// contesta cualquier otra cosa, no da la puerta por buena.
router.get(
  '/webhook',
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const acordada = process.env.WHATSAPP_VERIFY_TOKEN;
    const modo = req.query['hub.mode'];
    const palabra = req.query['hub.verify_token'];
    const desafio = req.query['hub.challenge'];

    if (acordada && modo === 'subscribe' && palabra === acordada && typeof desafio === 'string') {
      res.status(200).type('text/plain').send(desafio);
      return;
    }
    res.sendStatus(403);
  }),
);

// POST /api/whatsapp/webhook
//
// Se contesta 200 ENSEGUIDA y el trabajo se hace despues. Meta reintenta
// durante dias lo que no le conteste rapido, y cada reintento trae los mismos
// mensajes: una puerta lenta se convierte sola en mensajes repetidos.
router.post(
  '/webhook',
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    // Aqui el cuerpo es un Buffer: esta ruta se monta con express.raw antes del
    // express.json general, porque la firma se calcula sobre los bytes exactos
    // que mando Meta.
    const crudo = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

    if (!firmaValida(crudo, req.header('x-hub-signature-256'))) {
      console.warn('[whatsapp] entrega rechazada: la firma no cuadra');
      res.sendStatus(401);
      return;
    }

    let cuerpo: unknown = null;
    try {
      cuerpo = JSON.parse(crudo.toString('utf8'));
    } catch {
      // Firmado por Meta pero ilegible. Se contesta 200 igual: reintentarlo
      // traeria exactamente lo mismo.
      console.error('[whatsapp] entrega firmada pero ilegible');
      res.sendStatus(200);
      return;
    }

    res.sendStatus(200);

    // Sin await a proposito: la respuesta ya salio. Si esto revienta, que quede
    // en los registros y no tumbe el proceso.
    void procesarPayload(cuerpo).catch((e: Error) => {
      console.error('[whatsapp] no se pudo procesar la entrega:', e.message);
    });
  }),
);

export default router;
