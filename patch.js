import fs from 'fs';
import path from 'path';

try {
    const serverPath = path.resolve('server.js');
    let code = fs.readFileSync(serverPath, 'utf8');
    let modified = false;

    if (!code.includes('middleware/auth.js')) {
        code = code.replace("import express from 'express';", "import express from 'express';\nimport { creditGate } from './middleware/auth.js';");
        modified = true;
    }

    if (!code.includes("app.use('/api/generate', creditGate);")) {
        code = code.replace("app.use(express.json({ limit: '50kb' }));", "app.use(express.json({ limit: '50kb' }));\napp.use('/api/generate', creditGate);\napp.use('/api/invert', creditGate);");
        modified = true;
    }

    if (modified) {
        fs.writeFileSync(serverPath, code);
        console.log('Patched server.js with creditGate middleware');
    }
} catch (e) {
    console.error('Failed to patch server.js', e);
}
