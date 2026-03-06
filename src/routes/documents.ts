import { Router, Request, Response } from 'express';
import puppeteer, { Browser, Page } from 'puppeteer';
import type { LaunchOptions } from 'puppeteer';
import rateLimit from 'express-rate-limit';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { authenticateToken, checkPermission } from '../middleware/auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = Router();

// Todas las rutas de documentos requieren permiso documentos_acceso
router.use(authenticateToken, checkPermission('documentos_acceso'));

// Rate limiting para proteger contra abuso de generación de PDFs
const documentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 20, // máximo 20 PDFs por usuario cada 15 minutos
  message: {
    success: false,
    message: 'Demasiadas solicitudes de documentos. Por favor espera 15 minutos.'
  },
  standardHeaders: true,
  legacyHeaders: false
});

interface DocumentBody {
  projectName?: string;
  codigoLic?: string;
  day?: string;
  dayOfMonth?: string;
  dayInText?: string;
  month?: string;
  year?: string;
}

// Configuración de Puppeteer para Railway/producción
const getPuppeteerConfig = (): LaunchOptions => {
  const isProduction = process.env.NODE_ENV === 'production' || process.env.RAILWAY_ENVIRONMENT;

  console.log('🔧 Environment check:', {
    NODE_ENV: process.env.NODE_ENV,
    RAILWAY_ENVIRONMENT: process.env.RAILWAY_ENVIRONMENT,
    isProduction
  });

  if (isProduction) {
    const config: LaunchOptions = {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-features=VizDisplayCompositor'
      ]
    };

    const chromePath = process.env.PUPPETEER_EXECUTABLE_PATH ||
                      process.env.CHROME_BIN ||
                      '/usr/bin/google-chrome';

    try {
      if (fs.existsSync(chromePath)) {
        config.executablePath = chromePath;
        console.log('🔧 Using Chrome at:', chromePath);
      }
    } catch {
      console.log('🔧 Using default Chromium path');
    }

    return config;
  }

  return { headless: true };
};

// Configurar página para renderizado de alta calidad
const configurePageForPDF = async (page: Page): Promise<void> => {
  await page.setViewport({
    width: 1200,
    height: 1600,
    deviceScaleFactor: 2
  });

  await page.emulateMediaType('print');

  console.log('✅ Page configured for high quality PDF rendering');
};

function embedImage(imagePath: string): string {
  console.log('🖼️  Logo file exists:', fs.existsSync(imagePath));
  console.log('🖼️  Logo path:', imagePath);

  const imageBase64 = fs.readFileSync(imagePath).toString('base64');
  const extension = path.extname(imagePath).slice(1);
  const dataSrc = `data:image/${extension};base64,${imageBase64}`;

  console.log('🖼️  Base64 length:', dataSrc.length);
  console.log('🖼️  Data URI preview:', dataSrc.substring(0, 50) + '...');

  return dataSrc;
}

// Endpoint de diagnóstico
router.get('/version', authenticateToken, (req: Request, res: Response): void => {
  res.json({
    version: 'v2.0-high-quality-pdf',
    timestamp: new Date().toISOString(),
    message: 'Backend actualizado con mejoras de calidad PDF'
  });
});

// Acuerdo de Consorcio Preview
router.post('/acuerdo-consorcio-preview', authenticateToken, async (req: Request<object, object, DocumentBody>, res: Response): Promise<void> => {
  try {
    console.log('🔍 Preview request for Acuerdo de Consorcio:', req.body);
    const { projectName, day, month, year } = req.body;

    const htmlPath = path.resolve(__dirname, '../../templates/acuerdoConsorcioTemplate.html');
    let htmlContent = fs.readFileSync(htmlPath, 'utf8');

    htmlContent = htmlContent
      .replace(/{{projectName}}/g, projectName || '')
      .replace(/{{day}}/g, day || '')
      .replace(/{{month}}/g, month || '')
      .replace(/{{year}}/g, year || '');

    console.log('✅ Preview HTML generated successfully');
    res.json({ success: true, html: htmlContent, timestamp: new Date().toISOString() });
  } catch (error) {
    const err = error as Error;
    console.error('❌ Error generating preview:', error);
    res.status(500).json({ success: false, message: 'Error interno al generar vista previa' });
  }
});

// Acuerdo de Consorcio PDF
router.post('/acuerdo-consorcio-pdf', authenticateToken, documentLimiter, async (req: Request<object, object, DocumentBody>, res: Response): Promise<void> => {
  let browser: Browser | undefined;
  try {
    console.log('📄 Request received for Acuerdo de Consorcio:', req.body);
    const { projectName, day, month, year } = req.body;

    console.log('🚀 Launching Puppeteer...');
    browser = await puppeteer.launch(getPuppeteerConfig());
    console.log('✅ Puppeteer launched successfully');

    const page = await browser.newPage();
    console.log('✅ New page created');

    const htmlPath = path.resolve(__dirname, '../../templates/acuerdoConsorcioTemplate.html');
    let htmlContent = fs.readFileSync(htmlPath, 'utf8');

    htmlContent = htmlContent
      .replace(/{{projectName}}/g, projectName || '')
      .replace(/{{day}}/g, day || '')
      .replace(/{{month}}/g, month || '')
      .replace(/{{year}}/g, year || '');

    await page.setContent(htmlContent, { waitUntil: 'networkidle0' });

    const pdfPath = path.resolve(__dirname, '../../templates/acuerdo-consorcio.pdf');
    await page.pdf({
      path: pdfPath,
      format: 'legal',
      printBackground: true,
      margin: { top: '0.5in', right: '0.5in', bottom: '0.5in', left: '0.5in' }
    });

    console.log('✅ Acuerdo de Consorcio PDF generated successfully');
    await browser.close();
    console.log('✅ Browser closed');
    res.download(pdfPath);
  } catch (error) {
    const err = error as Error;
    console.error('❌ Error generating Acuerdo de Consorcio PDF:', error);

    if (browser) {
      try {
        await browser.close();
        console.log('✅ Browser closed after error');
      } catch (closeError) {
        console.error('❌ Error closing browser:', closeError);
      }
    }

    res.status(500).json({ success: false, message: 'Error interno al generar documento' });
  }
});

// Adhesión - Pinellas Preview
router.post('/adhesion-pinellas-preview', authenticateToken, async (req: Request<object, object, DocumentBody>, res: Response): Promise<void> => {
  try {
    console.log('🔍 Preview request for Adhesión Pinellas:', req.body);
    const { day, dayOfMonth, month, year } = req.body;

    const imagePath = path.resolve(__dirname, '../../templates/LogoPinellas.png');
    const imageSrc = embedImage(imagePath);

    const htmlPath = path.resolve(__dirname, '../../templates/adhesionPinellasTemplate.html');
    let htmlContent = fs.readFileSync(htmlPath, 'utf8');

    htmlContent = htmlContent
      .replace(/{{dayOfMonth}}/g, dayOfMonth || '')
      .replace(/{{day}}/g, day || '')
      .replace(/{{month}}/g, month || '')
      .replace(/{{year}}/g, year || '')
      .replace(/{{imagePath}}/g, imageSrc);

    console.log('✅ Preview HTML generated successfully');
    res.json({ success: true, html: htmlContent, timestamp: new Date().toISOString() });
  } catch (error) {
    const err = error as Error;
    console.error('❌ Error generating preview:', error);
    res.status(500).json({ success: false, message: 'Error interno al generar vista previa' });
  }
});

// Adhesión - Pinellas PDF
router.post('/adhesion-pinellas-pdf', authenticateToken, documentLimiter, async (req: Request<object, object, DocumentBody>, res: Response): Promise<void> => {
  let browser: Browser | undefined;
  try {
    console.log('🔥 ADHESION PINELLAS ENDPOINT HIT - NEW VERSION v2.0');
    console.log('Request received for Adhesión Pinellas:', req.body);
    const { day, dayOfMonth, month, year } = req.body;

    const imagePath = path.resolve(__dirname, '../../templates/LogoPinellas.png');
    const imageSrc = embedImage(imagePath);

    browser = await puppeteer.launch(getPuppeteerConfig());
    const page = await browser.newPage();

    const htmlPath = path.resolve(__dirname, '../../templates/adhesionPinellasTemplate.html');
    let htmlContent = fs.readFileSync(htmlPath, 'utf8');

    htmlContent = htmlContent
      .replace(/{{dayOfMonth}}/g, dayOfMonth || '')
      .replace(/{{day}}/g, day || '')
      .replace(/{{month}}/g, month || '')
      .replace(/{{year}}/g, year || '')
      .replace(/{{imagePath}}/g, imageSrc);

    await page.setContent(htmlContent, { waitUntil: 'networkidle0' });

    const pdfPath = path.resolve(__dirname, '../../templates/adhesion-pinellas.pdf');
    await page.pdf({
      path: pdfPath,
      format: 'legal',
      printBackground: true,
      margin: { top: '0.5in', right: '0.5in', bottom: '0.5in', left: '0.5in' }
    });

    console.log('Adhesión Pinellas PDF generated successfully');
    await browser.close();
    res.download(pdfPath);
  } catch (error) {
    console.error('Error generating Adhesión Pinellas PDF:', error);
    if (browser) await browser.close().catch(() => {});
    res.status(500).json({ success: false, message: 'Error interno al generar documento' });
  }
});

// Adhesión - Consorcio Preview
router.post('/adhesion-consorcio-preview', authenticateToken, async (req: Request<object, object, DocumentBody>, res: Response): Promise<void> => {
  try {
    console.log('🔍 Preview request for Adhesión Consorcio:', req.body);
    const { day, month, year } = req.body;

    const htmlPath = path.resolve(__dirname, '../../templates/adhesionConsorcioTemplate.html');
    let htmlContent = fs.readFileSync(htmlPath, 'utf8');

    htmlContent = htmlContent
      .replace(/{{day}}/g, day || '')
      .replace(/{{month}}/g, month || '')
      .replace(/{{year}}/g, year || '');

    console.log('✅ Preview HTML generated successfully');
    res.json({ success: true, html: htmlContent, timestamp: new Date().toISOString() });
  } catch (error) {
    const err = error as Error;
    console.error('❌ Error generating preview:', error);
    res.status(500).json({ success: false, message: 'Error interno al generar vista previa' });
  }
});

// Adhesión - Consorcio PDF
router.post('/adhesion-consorcio-pdf', authenticateToken, documentLimiter, async (req: Request<object, object, DocumentBody>, res: Response): Promise<void> => {
  let browser: Browser | undefined;
  try {
    console.log('Request received for Adhesión Consorcio:', req.body);
    const { day, month, year } = req.body;

    browser = await puppeteer.launch(getPuppeteerConfig());
    const page = await browser.newPage();

    const htmlPath = path.resolve(__dirname, '../../templates/adhesionConsorcioTemplate.html');
    let htmlContent = fs.readFileSync(htmlPath, 'utf8');

    htmlContent = htmlContent
      .replace(/{{day}}/g, day || '')
      .replace(/{{month}}/g, month || '')
      .replace(/{{year}}/g, year || '');

    await page.setContent(htmlContent, { waitUntil: 'networkidle0' });

    const pdfPath = path.resolve(__dirname, '../../templates/adhesion-consorcio.pdf');
    await page.pdf({
      path: pdfPath,
      format: 'legal',
      printBackground: true,
      margin: { top: '0.5in', right: '0.5in', bottom: '0.5in', left: '0.5in' }
    });

    console.log('Adhesión Consorcio PDF generated successfully');
    await browser.close();
    res.download(pdfPath);
  } catch (error) {
    console.error('Error generating Adhesión Consorcio PDF:', error);
    if (browser) await browser.close().catch(() => {});
    res.status(500).json({ success: false, message: 'Error interno al generar documento' });
  }
});

// Retorsión - Pinellas Preview
router.post('/retorsion-pinellas-preview', authenticateToken, async (req: Request<object, object, DocumentBody>, res: Response): Promise<void> => {
  try {
    console.log('🔍 Preview request for Retorsión Pinellas:', req.body);
    const { day, dayOfMonth, month, year } = req.body;

    const dayNum = parseInt(dayOfMonth || '17') || 17;
    const numberToText: Record<number, string> = {
      1: 'uno', 2: 'dos', 3: 'tres', 4: 'cuatro', 5: 'cinco', 6: 'seis', 7: 'siete', 8: 'ocho', 9: 'nueve', 10: 'diez',
      11: 'once', 12: 'doce', 13: 'trece', 14: 'catorce', 15: 'quince', 16: 'dieciséis', 17: 'diecisiete',
      18: 'dieciocho', 19: 'diecinueve', 20: 'veinte', 21: 'veintiuno', 22: 'veintidós', 23: 'veintitrés',
      24: 'veinticuatro', 25: 'veinticinco', 26: 'veintiséis', 27: 'veintisiete', 28: 'veintiocho',
      29: 'veintinueve', 30: 'treinta', 31: 'treinta y uno'
    };
    const dayInText = numberToText[dayNum] || dayOfMonth || '';

    const imagePath = path.resolve(__dirname, '../../templates/LogoPinellas.png');
    const imageSrc = embedImage(imagePath);

    const htmlPath = path.resolve(__dirname, '../../templates/retorsionPinellasTemplate.html');
    let htmlContent = fs.readFileSync(htmlPath, 'utf8');

    htmlContent = htmlContent
      .replace(/{{dayOfMonth}}/g, dayOfMonth || '')
      .replace(/{{day}}/g, day || '')
      .replace(/{{dayInText}}/g, dayInText)
      .replace(/{{month}}/g, month || '')
      .replace(/{{year}}/g, year || '')
      .replace(/{{imagePath}}/g, imageSrc);

    console.log('✅ Preview HTML generated successfully');
    res.json({ success: true, html: htmlContent, timestamp: new Date().toISOString() });
  } catch (error) {
    const err = error as Error;
    console.error('❌ Error generating preview:', error);
    res.status(500).json({ success: false, message: 'Error interno al generar vista previa' });
  }
});

// Retorsión - Pinellas PDF
router.post('/retorsion-pinellas-pdf', authenticateToken, documentLimiter, async (req: Request<object, object, DocumentBody>, res: Response): Promise<void> => {
  let browser: Browser | undefined;
  try {
    console.log('Request received for Retorsión Pinellas:', req.body);
    const { day, dayOfMonth, dayInText, month, year } = req.body;

    const imagePath = path.resolve(__dirname, '../../templates/LogoPinellas.png');
    const imageSrc = embedImage(imagePath);

    browser = await puppeteer.launch(getPuppeteerConfig());
    const page = await browser.newPage();

    const htmlPath = path.resolve(__dirname, '../../templates/retorsionPinellasTemplate.html');
    let htmlContent = fs.readFileSync(htmlPath, 'utf8');

    htmlContent = htmlContent
      .replace(/{{dayOfMonth}}/g, dayOfMonth || '')
      .replace(/{{day}}/g, day || '')
      .replace(/{{dayInText}}/g, dayInText || '')
      .replace(/{{month}}/g, month || '')
      .replace(/{{year}}/g, year || '')
      .replace(/{{imagePath}}/g, imageSrc);

    await page.setContent(htmlContent, { waitUntil: 'networkidle0' });

    const pdfPath = path.resolve(__dirname, '../../templates/retorsion-pinellas.pdf');
    await page.pdf({
      path: pdfPath,
      format: 'legal',
      printBackground: true,
      margin: { top: '0.5in', right: '0.5in', bottom: '0.5in', left: '0.5in' }
    });

    console.log('Retorsión Pinellas PDF generated successfully');
    await browser.close();
    res.download(pdfPath);
  } catch (error) {
    console.error('Error generating Retorsión Pinellas PDF:', error);
    if (browser) await browser.close().catch(() => {});
    res.status(500).json({ success: false, message: 'Error interno al generar documento' });
  }
});

// Retorsión - Consorcio Preview
router.post('/retorsion-consorcio-preview', authenticateToken, async (req: Request<object, object, DocumentBody>, res: Response): Promise<void> => {
  try {
    console.log('🔍 Preview request for Retorsión Consorcio:', req.body);
    const { day, dayOfMonth, month, year } = req.body;

    const htmlPath = path.resolve(__dirname, '../../templates/retorsionConsorcioTemplate.html');
    let htmlContent = fs.readFileSync(htmlPath, 'utf8');

    htmlContent = htmlContent
      .replace(/{{dayOfMonth}}/g, dayOfMonth || '')
      .replace(/{{day}}/g, day || '')
      .replace(/{{month}}/g, month || '')
      .replace(/{{year}}/g, year || '');

    console.log('✅ Preview HTML generated successfully');
    res.json({ success: true, html: htmlContent, timestamp: new Date().toISOString() });
  } catch (error) {
    const err = error as Error;
    console.error('❌ Error generating preview:', error);
    res.status(500).json({ success: false, message: 'Error interno al generar vista previa' });
  }
});

// Retorsión - Consorcio PDF
router.post('/retorsion-consorcio-pdf', authenticateToken, documentLimiter, async (req: Request<object, object, DocumentBody>, res: Response): Promise<void> => {
  let browser: Browser | undefined;
  try {
    console.log('Request received for Retorsión Consorcio:', req.body);
    const { day, dayOfMonth, month, year } = req.body;

    browser = await puppeteer.launch(getPuppeteerConfig());
    const page = await browser.newPage();

    const htmlPath = path.resolve(__dirname, '../../templates/retorsionConsorcioTemplate.html');
    let htmlContent = fs.readFileSync(htmlPath, 'utf8');

    htmlContent = htmlContent
      .replace(/{{dayOfMonth}}/g, dayOfMonth || '')
      .replace(/{{day}}/g, day || '')
      .replace(/{{month}}/g, month || '')
      .replace(/{{year}}/g, year || '');

    await page.setContent(htmlContent, { waitUntil: 'networkidle0' });

    const pdfPath = path.resolve(__dirname, '../../templates/retorsion-consorcio.pdf');
    await page.pdf({
      path: pdfPath,
      format: 'legal',
      printBackground: true,
      margin: { top: '0.5in', right: '0.5in', bottom: '0.5in', left: '0.5in' }
    });

    console.log('Retorsión Consorcio PDF generated successfully');
    await browser.close();
    res.download(pdfPath);
  } catch (error) {
    console.error('Error generating Retorsión Consorcio PDF:', error);
    if (browser) await browser.close().catch(() => {});
    res.status(500).json({ success: false, message: 'Error interno al generar documento' });
  }
});

// Incapacidad - Pinellas Preview
router.post('/incapacidad-pinellas-preview', authenticateToken, async (req: Request<object, object, DocumentBody>, res: Response): Promise<void> => {
  try {
    console.log('🔍 Preview request for Incapacidad Pinellas:', req.body);
    const { projectName, day, month, year } = req.body;

    const imagePath = path.resolve(__dirname, '../../templates/LogoPinellas.png');
    const imageSrc = embedImage(imagePath);

    const htmlPath = path.resolve(__dirname, '../../templates/incapacidadPinellasTemplate.html');
    let htmlContent = fs.readFileSync(htmlPath, 'utf8');

    htmlContent = htmlContent
      .replace(/{{projectName}}/g, projectName || '')
      .replace(/{{day}}/g, day || '')
      .replace(/{{month}}/g, month || '')
      .replace(/{{year}}/g, year || '')
      .replace(/{{imagePath}}/g, imageSrc);

    console.log('✅ Preview HTML generated successfully');
    res.json({ success: true, html: htmlContent, timestamp: new Date().toISOString() });
  } catch (error) {
    const err = error as Error;
    console.error('❌ Error generating preview:', error);
    res.status(500).json({ success: false, message: 'Error interno al generar vista previa' });
  }
});

// Incapacidad - Pinellas PDF
router.post('/incapacidad-pinellas-pdf', authenticateToken, documentLimiter, async (req: Request<object, object, DocumentBody>, res: Response): Promise<void> => {
  let browser: Browser | undefined;
  try {
    console.log('Request received for Incapacidad Pinellas:', req.body);
    const { projectName, day, month, year } = req.body;

    const imagePath = path.resolve(__dirname, '../../templates/LogoPinellas.png');
    const imageSrc = embedImage(imagePath);

    browser = await puppeteer.launch(getPuppeteerConfig());
    const page = await browser.newPage();

    const htmlPath = path.resolve(__dirname, '../../templates/incapacidadPinellasTemplate.html');
    let htmlContent = fs.readFileSync(htmlPath, 'utf8');

    htmlContent = htmlContent
      .replace(/{{projectName}}/g, projectName || '')
      .replace(/{{day}}/g, day || '')
      .replace(/{{month}}/g, month || '')
      .replace(/{{year}}/g, year || '')
      .replace(/{{imagePath}}/g, imageSrc);

    await page.setContent(htmlContent, { waitUntil: 'networkidle0' });

    const pdfPath = path.resolve(__dirname, '../../templates/incapacidad-pinellas.pdf');
    await page.pdf({
      path: pdfPath,
      format: 'legal',
      printBackground: true,
      margin: { top: '0.5in', right: '0.5in', bottom: '0.5in', left: '0.5in' }
    });

    console.log('Incapacidad Pinellas PDF generated successfully');
    await browser.close();
    res.download(pdfPath);
  } catch (error) {
    console.error('Error generating Incapacidad Pinellas PDF:', error);
    if (browser) await browser.close().catch(() => {});
    res.status(500).json({ success: false, message: 'Error interno al generar documento' });
  }
});

// Incapacidad - Consorcio Preview
router.post('/incapacidad-consorcio-preview', authenticateToken, async (req: Request<object, object, DocumentBody>, res: Response): Promise<void> => {
  try {
    console.log('🔍 Preview request for Incapacidad Consorcio:', req.body);
    const { projectName, day, month, year } = req.body;

    const htmlPath = path.resolve(__dirname, '../../templates/incapacidadConsorcioTemplate.html');
    let htmlContent = fs.readFileSync(htmlPath, 'utf8');

    htmlContent = htmlContent
      .replace(/{{projectName}}/g, projectName || '')
      .replace(/{{day}}/g, day || '')
      .replace(/{{month}}/g, month || '')
      .replace(/{{year}}/g, year || '');

    console.log('✅ Preview HTML generated successfully');
    res.json({ success: true, html: htmlContent, timestamp: new Date().toISOString() });
  } catch (error) {
    const err = error as Error;
    console.error('❌ Error generating preview:', error);
    res.status(500).json({ success: false, message: 'Error interno al generar vista previa' });
  }
});

// Incapacidad - Consorcio PDF
router.post('/incapacidad-consorcio-pdf', authenticateToken, documentLimiter, async (req: Request<object, object, DocumentBody>, res: Response): Promise<void> => {
  let browser: Browser | undefined;
  try {
    console.log('Request received for Incapacidad Consorcio:', req.body);
    const { projectName, day, month, year } = req.body;

    browser = await puppeteer.launch(getPuppeteerConfig());
    const page = await browser.newPage();

    const htmlPath = path.resolve(__dirname, '../../templates/incapacidadConsorcioTemplate.html');
    let htmlContent = fs.readFileSync(htmlPath, 'utf8');

    htmlContent = htmlContent
      .replace(/{{projectName}}/g, projectName || '')
      .replace(/{{day}}/g, day || '')
      .replace(/{{month}}/g, month || '')
      .replace(/{{year}}/g, year || '');

    await page.setContent(htmlContent, { waitUntil: 'networkidle0' });

    const pdfPath = path.resolve(__dirname, '../../templates/incapacidad-consorcio.pdf');
    await page.pdf({
      path: pdfPath,
      format: 'legal',
      printBackground: true,
      margin: { top: '0.5in', right: '0.5in', bottom: '0.5in', left: '0.5in' }
    });

    console.log('Incapacidad Consorcio PDF generated successfully');
    await browser.close();
    res.download(pdfPath);
  } catch (error) {
    console.error('Error generating Incapacidad Consorcio PDF:', error);
    if (browser) await browser.close().catch(() => {});
    res.status(500).json({ success: false, message: 'Error interno al generar documento' });
  }
});

// Integridad - Pinellas Preview
router.post('/integridad-pinellas-preview', authenticateToken, async (req: Request<object, object, DocumentBody>, res: Response): Promise<void> => {
  try {
    console.log('🔍 Preview request for Integridad Pinellas:', req.body);
    const { projectName, codigoLic, day, dayOfMonth, month, year } = req.body;

    const imagePath = path.resolve(__dirname, '../../templates/LogoPinellas.png');
    const imageSrc = embedImage(imagePath);

    const htmlPath = path.resolve(__dirname, '../../templates/integridadPinellasTemplate.html');
    let htmlContent = fs.readFileSync(htmlPath, 'utf8');

    htmlContent = htmlContent
      .replace(/{{projectName}}/g, projectName || '')
      .replace(/{{codigoLic}}/g, codigoLic || '')
      .replace(/{{dayOfMonth}}/g, dayOfMonth || '')
      .replace(/{{day}}/g, day || '')
      .replace(/{{month}}/g, month || '')
      .replace(/{{year}}/g, year || '')
      .replace(/{{imagePath}}/g, imageSrc);

    console.log('✅ Preview HTML generated successfully');
    res.json({ success: true, html: htmlContent, timestamp: new Date().toISOString() });
  } catch (error) {
    const err = error as Error;
    console.error('❌ Error generating preview:', error);
    res.status(500).json({ success: false, message: 'Error interno al generar vista previa' });
  }
});

// Integridad - Pinellas PDF
router.post('/integridad-pinellas-pdf', authenticateToken, documentLimiter, async (req: Request<object, object, DocumentBody>, res: Response): Promise<void> => {
  let browser: Browser | undefined;
  try {
    console.log('Request received for Integridad Pinellas:', req.body);
    const { projectName, codigoLic, day, dayOfMonth, month, year } = req.body;

    const imagePath = path.resolve(__dirname, '../../templates/LogoPinellas.png');
    const imageSrc = embedImage(imagePath);

    browser = await puppeteer.launch(getPuppeteerConfig());
    const page = await browser.newPage();

    const htmlPath = path.resolve(__dirname, '../../templates/integridadPinellasTemplate.html');
    let htmlContent = fs.readFileSync(htmlPath, 'utf8');

    htmlContent = htmlContent
      .replace(/{{projectName}}/g, projectName || '')
      .replace(/{{codigoLic}}/g, codigoLic || '')
      .replace(/{{dayOfMonth}}/g, dayOfMonth || '')
      .replace(/{{day}}/g, day || '')
      .replace(/{{month}}/g, month || '')
      .replace(/{{year}}/g, year || '')
      .replace(/{{imagePath}}/g, imageSrc);

    await page.setContent(htmlContent, { waitUntil: 'networkidle0' });

    const pdfPath = path.resolve(__dirname, '../../templates/integridad-pinellas.pdf');
    await page.pdf({
      path: pdfPath,
      format: 'legal',
      printBackground: true,
      margin: { top: '0.5in', right: '0.5in', bottom: '0.5in', left: '0.5in' }
    });

    console.log('Integridad Pinellas PDF generated successfully');
    await browser.close();
    res.download(pdfPath);
  } catch (error) {
    console.error('Error generating Integridad Pinellas PDF:', error);
    if (browser) await browser.close().catch(() => {});
    res.status(500).json({ success: false, message: 'Error interno al generar documento' });
  }
});

// Integridad - Consorcio Preview
router.post('/integridad-consorcio-preview', authenticateToken, async (req: Request<object, object, DocumentBody>, res: Response): Promise<void> => {
  try {
    console.log('🔍 Preview request for Integridad Consorcio:', req.body);
    const { projectName, codigoLic, day, dayOfMonth, month, year } = req.body;

    const htmlPath = path.resolve(__dirname, '../../templates/integridadConsorcioTemplate.html');
    let htmlContent = fs.readFileSync(htmlPath, 'utf8');

    htmlContent = htmlContent
      .replace(/{{projectName}}/g, projectName || '')
      .replace(/{{codigoLic}}/g, codigoLic || '')
      .replace(/{{dayOfMonth}}/g, dayOfMonth || '')
      .replace(/{{day}}/g, day || '')
      .replace(/{{month}}/g, month || '')
      .replace(/{{year}}/g, year || '');

    console.log('✅ Preview HTML generated successfully');
    res.json({ success: true, html: htmlContent, timestamp: new Date().toISOString() });
  } catch (error) {
    const err = error as Error;
    console.error('❌ Error generating preview:', error);
    res.status(500).json({ success: false, message: 'Error interno al generar vista previa' });
  }
});

// Integridad - Consorcio PDF
router.post('/integridad-consorcio-pdf', authenticateToken, documentLimiter, async (req: Request<object, object, DocumentBody>, res: Response): Promise<void> => {
  let browser: Browser | undefined;
  try {
    console.log('Request received for Integridad Consorcio:', req.body);
    const { projectName, codigoLic, day, dayOfMonth, month, year } = req.body;

    browser = await puppeteer.launch(getPuppeteerConfig());
    const page = await browser.newPage();

    const htmlPath = path.resolve(__dirname, '../../templates/integridadConsorcioTemplate.html');
    let htmlContent = fs.readFileSync(htmlPath, 'utf8');

    htmlContent = htmlContent
      .replace(/{{projectName}}/g, projectName || '')
      .replace(/{{codigoLic}}/g, codigoLic || '')
      .replace(/{{dayOfMonth}}/g, dayOfMonth || '')
      .replace(/{{day}}/g, day || '')
      .replace(/{{month}}/g, month || '')
      .replace(/{{year}}/g, year || '');

    await page.setContent(htmlContent, { waitUntil: 'networkidle0' });

    const pdfPath = path.resolve(__dirname, '../../templates/integridad-consorcio.pdf');
    await page.pdf({
      path: pdfPath,
      format: 'legal',
      printBackground: true,
      margin: { top: '0.5in', right: '0.5in', bottom: '0.5in', left: '0.5in' }
    });

    console.log('Integridad Consorcio PDF generated successfully');
    await browser.close();
    res.download(pdfPath);
  } catch (error) {
    console.error('Error generating Integridad Consorcio PDF:', error);
    if (browser) await browser.close().catch(() => {});
    res.status(500).json({ success: false, message: 'Error interno al generar documento' });
  }
});

export default router;
