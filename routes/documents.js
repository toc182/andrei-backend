const express = require('express');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const router = express.Router();

// Endpoint de diagnóstico para verificar versión
router.get('/version', (req, res) => {
    res.json({
        version: 'v2.0-high-quality-pdf',
        timestamp: new Date().toISOString(),
        message: 'Backend actualizado con mejoras de calidad PDF'
    });
});

// Configuración de Puppeteer para Railway/producción
const getPuppeteerConfig = () => {
    const isProduction = process.env.NODE_ENV === 'production' || process.env.RAILWAY_ENVIRONMENT;

    console.log('🔧 Environment check:', {
        NODE_ENV: process.env.NODE_ENV,
        RAILWAY_ENVIRONMENT: process.env.RAILWAY_ENVIRONMENT,
        isProduction
    });

    if (isProduction) {
        const config = {
            headless: 'new',
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

        // En Railway, usar el path específico si está disponible
        const chromePath = process.env.PUPPETEER_EXECUTABLE_PATH ||
                          process.env.CHROME_BIN ||
                          '/usr/bin/google-chrome';

        try {
            if (require('fs').existsSync(chromePath)) {
                config.executablePath = chromePath;
                console.log('🔧 Using Chrome at:', chromePath);
            }
        } catch (err) {
            console.log('🔧 Using default Chromium path');
        }

        return config;
    }

    return { headless: 'new' };
};

// Configurar página para renderizado de alta calidad
const configurePageForPDF = async (page) => {
    // Configurar viewport para mejor calidad de renderizado
    await page.setViewport({
        width: 1200,
        height: 1600,
        deviceScaleFactor: 2  // Mayor resolución para mejor calidad
    });

    // Configurar media emulation para print
    await page.emulateMediaType('print');

    console.log('✅ Page configured for high quality PDF rendering');
};

function embedImage(imagePath) {
    // Verificar que el archivo existe
    console.log('🖼️  Logo file exists:', fs.existsSync(imagePath));
    console.log('🖼️  Logo path:', imagePath);
    
    const imageBase64 = fs.readFileSync(imagePath).toString('base64');
    const extension = path.extname(imagePath).slice(1);
    const dataSrc = `data:image/${extension};base64,${imageBase64}`;
    
    // Verificar tamaño del Base64
    console.log('🖼️  Base64 length:', dataSrc.length);
    console.log('🖼️  Data URI preview:', dataSrc.substring(0, 50) + '...');
    
    return dataSrc;
}

// Acuerdo de Consorcio Preview (devuelve HTML procesado)
router.post('/acuerdo-consorcio-preview', async (req, res) => {
    try {
        console.log('🔍 Preview request for Acuerdo de Consorcio:', req.body);
        const { projectName, day, month, year } = req.body;

        const htmlPath = path.resolve(__dirname, '../templates/acuerdoConsorcioTemplate.html');
        let htmlContent = fs.readFileSync(htmlPath, 'utf8');

        htmlContent = htmlContent
            .replace(/{{projectName}}/g, projectName || '')
            .replace(/{{day}}/g, day || '')
            .replace(/{{month}}/g, month || '')
            .replace(/{{year}}/g, year || '');

        console.log('✅ Preview HTML generated successfully');
        res.json({
            success: true,
            html: htmlContent,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('❌ Error generating preview:', error);
        res.status(500).json({
            error: 'Error generating preview',
            message: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Acuerdo de Consorcio
router.post('/acuerdo-consorcio-pdf', async (req, res) => {
    let browser;
    try {
        console.log('📄 Request received for Acuerdo de Consorcio:', req.body);
        const { projectName, day, month, year } = req.body;

        console.log('🚀 Launching Puppeteer...');
        browser = await puppeteer.launch(getPuppeteerConfig());
        console.log('✅ Puppeteer launched successfully');

        const page = await browser.newPage();
        console.log('✅ New page created');

        const htmlPath = path.resolve(__dirname, '../templates/acuerdoConsorcioTemplate.html');
        let htmlContent = fs.readFileSync(htmlPath, 'utf8');

        htmlContent = htmlContent
            .replace(/{{projectName}}/g, projectName || '')
            .replace(/{{day}}/g, day || '')
            .replace(/{{month}}/g, month || '')
            .replace(/{{year}}/g, year || '');

        await page.setContent(htmlContent, { waitUntil: 'networkidle0' });

        const pdfPath = path.resolve(__dirname, '../templates/acuerdo-consorcio.pdf');
        await page.pdf({
            path: pdfPath,
            format: 'legal',
            printBackground: true,
            margin: {
                top: '0.5in',
                right: '0.5in',
                bottom: '0.5in',
                left: '0.5in',
            },
        });

        console.log('✅ Acuerdo de Consorcio PDF generated successfully');
        await browser.close();
        console.log('✅ Browser closed');
        res.download(pdfPath);
    } catch (error) {
        console.error('❌ Error generating Acuerdo de Consorcio PDF:', error);
        console.error('❌ Stack trace:', error.stack);

        if (browser) {
            try {
                await browser.close();
                console.log('✅ Browser closed after error');
            } catch (closeError) {
                console.error('❌ Error closing browser:', closeError);
            }
        }

        res.status(500).json({
            error: 'Error generating PDF',
            message: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Adhesión - Pinellas Preview (devuelve HTML procesado)
router.post('/adhesion-pinellas-preview', async (req, res) => {
    try {
        console.log('🔍 Preview request for Adhesión Pinellas:', req.body);
        const { day, dayOfMonth, month, year } = req.body;

        const imagePath = path.resolve(__dirname, '../templates/LogoPinellas.png');
        const imageSrc = embedImage(imagePath);

        const htmlPath = path.resolve(__dirname, '../templates/adhesionPinellasTemplate.html');
        let htmlContent = fs.readFileSync(htmlPath, 'utf8');

        htmlContent = htmlContent
            .replace(/{{dayOfMonth}}/g, dayOfMonth || '')
            .replace(/{{day}}/g, day || '')
            .replace(/{{month}}/g, month || '')
            .replace(/{{year}}/g, year || '')
            .replace(/{{imagePath}}/g, imageSrc);

        console.log('✅ Preview HTML generated successfully');
        res.json({
            success: true,
            html: htmlContent,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('❌ Error generating preview:', error);
        res.status(500).json({
            error: 'Error generating preview',
            message: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Adhesión - Pinellas
router.post('/adhesion-pinellas-pdf', async (req, res) => {
    try {
        console.log('🔥 ADHESION PINELLAS ENDPOINT HIT - NEW VERSION v2.0');
        console.log('Request received for Adhesión Pinellas:', req.body);
        const { day, dayOfMonth, month, year } = req.body;

        const imagePath = path.resolve(__dirname, '../templates/LogoPinellas.png');
        const imageSrc = embedImage(imagePath);

        const browser = await puppeteer.launch(getPuppeteerConfig());
        const page = await browser.newPage();

        const htmlPath = path.resolve(__dirname, '../templates/adhesionPinellasTemplate.html');
        let htmlContent = fs.readFileSync(htmlPath, 'utf8');

        htmlContent = htmlContent
            .replace(/{{dayOfMonth}}/g, dayOfMonth || '')
            .replace(/{{day}}/g, day || '')
            .replace(/{{month}}/g, month || '')
            .replace(/{{year}}/g, year || '')
            .replace(/{{imagePath}}/g, imageSrc);

        await page.setContent(htmlContent, { waitUntil: 'networkidle0' });

        const pdfPath = path.resolve(__dirname, '../templates/adhesion-pinellas.pdf');
        await page.pdf({
            path: pdfPath,
            format: 'legal',
            printBackground: true,
            margin: {
                top: '0.5in',
                right: '0.5in',
                bottom: '0.5in',
                left: '0.5in',
            },
        });

        console.log('Adhesión Pinellas PDF generated successfully');
        await browser.close();
        res.download(pdfPath);
    } catch (error) {
        console.error('Error generating Adhesión Pinellas PDF:', error);
        res.status(500).send('Error generating PDF');
    }
});

// Adhesión - Consorcio Preview (devuelve HTML procesado)
router.post('/adhesion-consorcio-preview', async (req, res) => {
    try {
        console.log('🔍 Preview request for Adhesión Consorcio:', req.body);
        const { day, month, year } = req.body;

        const htmlPath = path.resolve(__dirname, '../templates/adhesionConsorcioTemplate.html');
        let htmlContent = fs.readFileSync(htmlPath, 'utf8');

        htmlContent = htmlContent
            .replace(/{{day}}/g, day || '')
            .replace(/{{month}}/g, month || '')
            .replace(/{{year}}/g, year || '');

        console.log('✅ Preview HTML generated successfully');
        res.json({
            success: true,
            html: htmlContent,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('❌ Error generating preview:', error);
        res.status(500).json({
            error: 'Error generating preview',
            message: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Adhesión - Consorcio
router.post('/adhesion-consorcio-pdf', async (req, res) => {
    try {
        console.log('Request received for Adhesión Consorcio:', req.body);
        const { day, month, year } = req.body;

        const browser = await puppeteer.launch(getPuppeteerConfig());
        const page = await browser.newPage();

        const htmlPath = path.resolve(__dirname, '../templates/adhesionConsorcioTemplate.html');
        let htmlContent = fs.readFileSync(htmlPath, 'utf8');

        htmlContent = htmlContent
            .replace(/{{day}}/g, day || '')
            .replace(/{{month}}/g, month || '')
            .replace(/{{year}}/g, year || '');

        await page.setContent(htmlContent, { waitUntil: 'networkidle0' });

        const pdfPath = path.resolve(__dirname, '../templates/adhesion-consorcio.pdf');
        await page.pdf({
            path: pdfPath,
            format: 'legal',
            printBackground: true,
            margin: {
                top: '0.5in',
                right: '0.5in',
                bottom: '0.5in',
                left: '0.5in',
            },
        });

        console.log('Adhesión Consorcio PDF generated successfully');
        await browser.close();
        res.download(pdfPath);
    } catch (error) {
        console.error('Error generating Adhesión Consorcio PDF:', error);
        res.status(500).send('Error generating PDF');
    }
});

// Retorsión - Pinellas Preview (devuelve HTML procesado)
router.post('/retorsion-pinellas-preview', async (req, res) => {
    try {
        console.log('🔍 Preview request for Retorsión Pinellas:', req.body);
        const { day, dayOfMonth, month, year } = req.body;

        // Crear número del día en texto
        const dayNum = parseInt(dayOfMonth) || 17;
        const numberToText = {
            1: 'uno', 2: 'dos', 3: 'tres', 4: 'cuatro', 5: 'cinco', 6: 'seis', 7: 'siete', 8: 'ocho', 9: 'nueve', 10: 'diez',
            11: 'once', 12: 'doce', 13: 'trece', 14: 'catorce', 15: 'quince', 16: 'dieciséis', 17: 'diecisiete',
            18: 'dieciocho', 19: 'diecinueve', 20: 'veinte', 21: 'veintiuno', 22: 'veintidós', 23: 'veintitrés',
            24: 'veinticuatro', 25: 'veinticinco', 26: 'veintiséis', 27: 'veintisiete', 28: 'veintiocho',
            29: 'veintinueve', 30: 'treinta', 31: 'treinta y uno'
        };
        const dayInText = numberToText[dayNum] || dayOfMonth;
        console.log('🔢 dayNum:', dayNum, 'dayInText:', dayInText);

        const imagePath = path.resolve(__dirname, '../templates/LogoPinellas.png');
        const imageSrc = embedImage(imagePath);

        const htmlPath = path.resolve(__dirname, '../templates/retorsionPinellasTemplate.html');
        let htmlContent = fs.readFileSync(htmlPath, 'utf8');

        htmlContent = htmlContent
            .replace(/{{dayOfMonth}}/g, dayOfMonth || '')
            .replace(/{{day}}/g, day || '')
            .replace(/{{dayInText}}/g, dayInText)
            .replace(/{{month}}/g, month || '')
            .replace(/{{year}}/g, year || '')
            .replace(/{{imagePath}}/g, imageSrc);

        console.log('✅ Preview HTML generated successfully');
        res.json({
            success: true,
            html: htmlContent,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('❌ Error generating preview:', error);
        res.status(500).json({
            error: 'Error generating preview',
            message: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Retorsión - Pinellas
router.post('/retorsion-pinellas-pdf', async (req, res) => {
    try {
        console.log('Request received for Retorsión Pinellas:', req.body);
        const { day, dayOfMonth, dayInText, month, year } = req.body;

        const imagePath = path.resolve(__dirname, '../templates/LogoPinellas.png');
        const imageSrc = embedImage(imagePath);
        
        const browser = await puppeteer.launch(getPuppeteerConfig());
        const page = await browser.newPage();

        const htmlPath = path.resolve(__dirname, '../templates/retorsionPinellasTemplate.html');
        let htmlContent = fs.readFileSync(htmlPath, 'utf8');

        htmlContent = htmlContent
            .replace(/{{dayOfMonth}}/g, dayOfMonth || '')
            .replace(/{{day}}/g, day || '')
            .replace(/{{dayInText}}/g, dayInText)
            .replace(/{{month}}/g, month || '')
            .replace(/{{year}}/g, year || '')
            .replace(/{{imagePath}}/g, imageSrc);

        await page.setContent(htmlContent, { waitUntil: 'networkidle0' });

        const pdfPath = path.resolve(__dirname, '../templates/retorsion-pinellas.pdf');
        await page.pdf({
            path: pdfPath,
            format: 'legal',
            printBackground: true,
            margin: {
                top: '0.5in',
                right: '0.5in',
                bottom: '0.5in',
                left: '0.5in',
            },
        });

        console.log('Retorsión Pinellas PDF generated successfully');
        await browser.close();
        res.download(pdfPath);
    } catch (error) {
        console.error('Error generating Retorsión Pinellas PDF:', error);
        res.status(500).send('Error generating PDF');
    }
});

// Retorsión - Consorcio Preview (devuelve HTML procesado)
router.post('/retorsion-consorcio-preview', async (req, res) => {
    try {
        console.log('🔍 Preview request for Retorsión Consorcio:', req.body);
        const { day, dayOfMonth, month, year } = req.body;

        const htmlPath = path.resolve(__dirname, '../templates/retorsionConsorcioTemplate.html');
        let htmlContent = fs.readFileSync(htmlPath, 'utf8');

        htmlContent = htmlContent
            .replace(/{{dayOfMonth}}/g, dayOfMonth || '')
            .replace(/{{day}}/g, day || '')
            .replace(/{{month}}/g, month || '')
            .replace(/{{year}}/g, year || '');

        console.log('✅ Preview HTML generated successfully');
        res.json({
            success: true,
            html: htmlContent,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('❌ Error generating preview:', error);
        res.status(500).json({
            error: 'Error generating preview',
            message: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Retorsión - Consorcio
router.post('/retorsion-consorcio-pdf', async (req, res) => {
    try {
        console.log('Request received for Retorsión Consorcio:', req.body);
        const { day, dayOfMonth, month, year } = req.body;
        
        const browser = await puppeteer.launch(getPuppeteerConfig());
        const page = await browser.newPage();

        const htmlPath = path.resolve(__dirname, '../templates/retorsionConsorcioTemplate.html');
        let htmlContent = fs.readFileSync(htmlPath, 'utf8');

        htmlContent = htmlContent
            .replace(/{{dayOfMonth}}/g, dayOfMonth || '')
            .replace(/{{day}}/g, day || '')
            .replace(/{{month}}/g, month || '')
            .replace(/{{year}}/g, year || '');

        await page.setContent(htmlContent, { waitUntil: 'networkidle0' });

        const pdfPath = path.resolve(__dirname, '../templates/retorsion-consorcio.pdf');
        await page.pdf({
            path: pdfPath,
            format: 'legal',
            printBackground: true,
            margin: {
                top: '0.5in',
                right: '0.5in',
                bottom: '0.5in',
                left: '0.5in',
            },
        });

        console.log('Retorsión Consorcio PDF generated successfully');
        await browser.close();
        res.download(pdfPath);
    } catch (error) {
        console.error('Error generating Retorsión Consorcio PDF:', error);
        res.status(500).send('Error generating PDF');
    }
});

// Incapacidad - Pinellas Preview (devuelve HTML procesado)
router.post('/incapacidad-pinellas-preview', async (req, res) => {
    try {
        console.log('🔍 Preview request for Incapacidad Pinellas:', req.body);
        const { projectName, day, month, year } = req.body;

        const imagePath = path.resolve(__dirname, '../templates/LogoPinellas.png');
        const imageSrc = embedImage(imagePath);

        const htmlPath = path.resolve(__dirname, '../templates/incapacidadPinellasTemplate.html');
        let htmlContent = fs.readFileSync(htmlPath, 'utf8');

        htmlContent = htmlContent
            .replace(/{{projectName}}/g, projectName || '')
            .replace(/{{day}}/g, day || '')
            .replace(/{{month}}/g, month || '')
            .replace(/{{year}}/g, year || '')
            .replace(/{{imagePath}}/g, imageSrc);

        console.log('✅ Preview HTML generated successfully');
        res.json({
            success: true,
            html: htmlContent,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('❌ Error generating preview:', error);
        res.status(500).json({
            error: 'Error generating preview',
            message: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Incapacidad - Pinellas
router.post('/incapacidad-pinellas-pdf', async (req, res) => {
    try {
        console.log('Request received for Incapacidad Pinellas:', req.body);
        const { projectName, day, month, year } = req.body;
        
        const imagePath = path.resolve(__dirname, '../templates/LogoPinellas.png');
        const imageSrc = embedImage(imagePath);
        
        const browser = await puppeteer.launch(getPuppeteerConfig());
        const page = await browser.newPage();

        const htmlPath = path.resolve(__dirname, '../templates/incapacidadPinellasTemplate.html');
        let htmlContent = fs.readFileSync(htmlPath, 'utf8');

        htmlContent = htmlContent
            .replace(/{{projectName}}/g, projectName || '')
            .replace(/{{day}}/g, day || '')
            .replace(/{{month}}/g, month || '')
            .replace(/{{year}}/g, year || '')
            .replace(/{{imagePath}}/g, imageSrc);

        await page.setContent(htmlContent, { waitUntil: 'networkidle0' });

        const pdfPath = path.resolve(__dirname, '../templates/incapacidad-pinellas.pdf');
        await page.pdf({
            path: pdfPath,
            format: 'legal',
            printBackground: true,
            margin: {
                top: '0.5in',
                right: '0.5in',
                bottom: '0.5in',
                left: '0.5in',
            },
        });

        console.log('Incapacidad Pinellas PDF generated successfully');
        await browser.close();
        res.download(pdfPath);
    } catch (error) {
        console.error('Error generating Incapacidad Pinellas PDF:', error);
        res.status(500).send('Error generating PDF');
    }
});

// Incapacidad - Consorcio Preview (devuelve HTML procesado)
router.post('/incapacidad-consorcio-preview', async (req, res) => {
    try {
        console.log('🔍 Preview request for Incapacidad Consorcio:', req.body);
        const { projectName, day, month, year } = req.body;

        const htmlPath = path.resolve(__dirname, '../templates/incapacidadConsorcioTemplate.html');
        let htmlContent = fs.readFileSync(htmlPath, 'utf8');

        htmlContent = htmlContent
            .replace(/{{projectName}}/g, projectName || '')
            .replace(/{{day}}/g, day || '')
            .replace(/{{month}}/g, month || '')
            .replace(/{{year}}/g, year || '');

        console.log('✅ Preview HTML generated successfully');
        res.json({
            success: true,
            html: htmlContent,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('❌ Error generating preview:', error);
        res.status(500).json({
            error: 'Error generating preview',
            message: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Incapacidad - Consorcio
router.post('/incapacidad-consorcio-pdf', async (req, res) => {
    try {
        console.log('Request received for Incapacidad Consorcio:', req.body);
        const { projectName, day, month, year } = req.body;
        
        const browser = await puppeteer.launch(getPuppeteerConfig());
        const page = await browser.newPage();

        const htmlPath = path.resolve(__dirname, '../templates/incapacidadConsorcioTemplate.html');
        let htmlContent = fs.readFileSync(htmlPath, 'utf8');

        htmlContent = htmlContent
            .replace(/{{projectName}}/g, projectName || '')
            .replace(/{{day}}/g, day || '')
            .replace(/{{month}}/g, month || '')
            .replace(/{{year}}/g, year || '');

        await page.setContent(htmlContent, { waitUntil: 'networkidle0' });

        const pdfPath = path.resolve(__dirname, '../templates/incapacidad-consorcio.pdf');
        await page.pdf({
            path: pdfPath,
            format: 'legal',
            printBackground: true,
            margin: {
                top: '0.5in',
                right: '0.5in',
                bottom: '0.5in',
                left: '0.5in',
            },
        });

        console.log('Incapacidad Consorcio PDF generated successfully');
        await browser.close();
        res.download(pdfPath);
    } catch (error) {
        console.error('Error generating Incapacidad Consorcio PDF:', error);
        res.status(500).send('Error generating PDF');
    }
});

// Integridad - Pinellas Preview (devuelve HTML procesado)
router.post('/integridad-pinellas-preview', async (req, res) => {
    try {
        console.log('🔍 Preview request for Integridad Pinellas:', req.body);
        const { projectName, codigoLic, day, dayOfMonth, month, year } = req.body;

        const imagePath = path.resolve(__dirname, '../templates/LogoPinellas.png');
        const imageSrc = embedImage(imagePath);

        const htmlPath = path.resolve(__dirname, '../templates/integridadPinellasTemplate.html');
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
        res.json({
            success: true,
            html: htmlContent,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('❌ Error generating preview:', error);
        res.status(500).json({
            error: 'Error generating preview',
            message: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Integridad - Pinellas
router.post('/integridad-pinellas-pdf', async (req, res) => {
    try {
        console.log('Request received for Integridad Pinellas:', req.body);
        const { projectName, codigoLic, day, dayOfMonth, month, year } = req.body;
        
        const imagePath = path.resolve(__dirname, '../templates/LogoPinellas.png');
        const imageSrc = embedImage(imagePath);
        
        const browser = await puppeteer.launch(getPuppeteerConfig());
        const page = await browser.newPage();

        const htmlPath = path.resolve(__dirname, '../templates/integridadPinellasTemplate.html');
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

        const pdfPath = path.resolve(__dirname, '../templates/integridad-pinellas.pdf');
        await page.pdf({
            path: pdfPath,
            format: 'legal',
            printBackground: true,
            margin: {
                top: '0.5in',
                right: '0.5in',
                bottom: '0.5in',
                left: '0.5in',
            },
        });

        console.log('Integridad Pinellas PDF generated successfully');
        await browser.close();
        res.download(pdfPath);
    } catch (error) {
        console.error('Error generating Integridad Pinellas PDF:', error);
        res.status(500).send('Error generating PDF');
    }
});

// Integridad - Consorcio Preview (devuelve HTML procesado)
router.post('/integridad-consorcio-preview', async (req, res) => {
    try {
        console.log('🔍 Preview request for Integridad Consorcio:', req.body);
        const { projectName, codigoLic, day, dayOfMonth, month, year } = req.body;

        const htmlPath = path.resolve(__dirname, '../templates/integridadConsorcioTemplate.html');
        let htmlContent = fs.readFileSync(htmlPath, 'utf8');

        htmlContent = htmlContent
            .replace(/{{projectName}}/g, projectName || '')
            .replace(/{{codigoLic}}/g, codigoLic || '')
            .replace(/{{dayOfMonth}}/g, dayOfMonth || '')
            .replace(/{{day}}/g, day || '')
            .replace(/{{month}}/g, month || '')
            .replace(/{{year}}/g, year || '');

        console.log('✅ Preview HTML generated successfully');
        res.json({
            success: true,
            html: htmlContent,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('❌ Error generating preview:', error);
        res.status(500).json({
            error: 'Error generating preview',
            message: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Integridad - Consorcio
router.post('/integridad-consorcio-pdf', async (req, res) => {
    try {
        console.log('Request received for Integridad Consorcio:', req.body);
        const { projectName, codigoLic, day, dayOfMonth, month, year } = req.body;
        
        const browser = await puppeteer.launch(getPuppeteerConfig());
        const page = await browser.newPage();

        const htmlPath = path.resolve(__dirname, '../templates/integridadConsorcioTemplate.html');
        let htmlContent = fs.readFileSync(htmlPath, 'utf8');

        htmlContent = htmlContent
            .replace(/{{projectName}}/g, projectName || '')
            .replace(/{{codigoLic}}/g, codigoLic || '')
            .replace(/{{dayOfMonth}}/g, dayOfMonth || '')
            .replace(/{{day}}/g, day || '')
            .replace(/{{month}}/g, month || '')
            .replace(/{{year}}/g, year || '');

        await page.setContent(htmlContent, { waitUntil: 'networkidle0' });

        const pdfPath = path.resolve(__dirname, '../templates/integridad-consorcio.pdf');
        await page.pdf({
            path: pdfPath,
            format: 'legal',
            printBackground: true,
            margin: {
                top: '0.5in',
                right: '0.5in',
                bottom: '0.5in',
                left: '0.5in',
            },
        });

        console.log('Integridad Consorcio PDF generated successfully');
        await browser.close();
        res.download(pdfPath);
    } catch (error) {
        console.error('Error generating Integridad Consorcio PDF:', error);
        res.status(500).send('Error generating PDF');
    }
});

module.exports = router;