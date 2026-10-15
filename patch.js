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

try {
    const androidAssetsDir = path.resolve('android_app', 'app', 'src', 'main', 'assets');
    const webIndex = path.resolve('static', 'index.html');
    const webCss = path.resolve('static', 'style.css');

    const assetTargets = [
        [webIndex, path.join(androidAssetsDir, 'index.html')],
        [webCss, path.join(androidAssetsDir, 'style.css')],
        [webCss, path.join(androidAssetsDir, 'static', 'style.css')]
    ];

    for (const [source, destination] of assetTargets) {
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(source, destination);
        console.log(`Synced ${path.relative(process.cwd(), source)} to ${path.relative(process.cwd(), destination)}`);
    }
} catch (e) {
    console.error('Failed to sync web assets to Android', e);
    process.exitCode = 1;
}
