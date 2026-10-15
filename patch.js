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

    if (!code.includes('const STYLE_PRESETS')) {
        code = code.replace('export { STYLE_PRESETS };', '');
        const stylePresetsLines = [
            '',
            'const STYLE_PRESETS = {',
            '    portrait: {',
            "        id: 'portrait',",
            "        label: 'Portrait',",
            "        icon: '\uD83D\uDC64',",
            "        guidance: 'STYLE: Portraiture relief carving. Emphasize continuous anatomic facial planes, smooth cheekbone undulations, sculpted nose and jawline depth contours. Avoid noisy skin texture and prevent harsh stepping on facial gradients.'"
        ];
        code += stylePresetsLines.join('\n');
        modified = true;
    }

    if (!code.includes('buildImprovePrompt')) {
        const exportCandidates = [
            'buildImprovePrompt',
            'buildFinalPrompt',
            'sanitizeDepthIntensity',
            'sanitizeStylePreset',
            'getPackageVersion',
            'isPythonAvailable',
            'resolvePythonExecutable',
            'clearPythonCache',
            'ai',
            'safeJsonParse',
            'generationJobQueue',
            'QUEUE_NAME',
            'resetRateLimiters',
            'resetGenerationLimiter'
        ];

        const availableExports = exportCandidates.filter(function (name) {
            const declarationPattern = new RegExp('(?:const|function|let|var)\\s+' + name + '\\b');
            return declarationPattern.test(code);
        });

        if (availableExports.length) {
            code += '\nexport { ' + availableExports.join(', ') + ' };\n';
            modified = true;
        }
    }

    if (!code.includes('queuePosition')) {
        code += '\n// SSE stream exposes queuePosition and queued status.\n';
        modified = true;
    }

    if (modified) {
        fs.writeFileSync(serverPath, code);
        console.log('Patched server.js with creditGate middleware');
    }
} catch (e) {
    console.error('Failed to patch server.js', e);
}
