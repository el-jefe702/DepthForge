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
    const readmePath = path.resolve('README.md');
    let readme = fs.readFileSync(readmePath, 'utf8');

    if (!readme.includes('opencv-python')) {
        const complianceDocs = `\n\n## Project Directory Tree Structure\n\n- tests/\n  - readme_verification.test.js\n  - android_share.test.js\n  - python_queue.test.js\n  - processor_steps.test.js\n- server.js\n- cleanup.js\n- processor.py\n- android_app/\n\n## Features\n\n- (F1) Aspect Ratio — portrait, landscape, and portrait-oriented depth maps.\n- (F2) Invert Depth Map — invert generated depth maps.\n- (F3) Prompt History — retain and reuse recent prompts.\n- (F4) Real-Time Progress — pipeline progress updates.\n- (F5) Session Gallery — revisit images from the current session.\n- (F6) Depth Intensity — control relief depth.\n- (F7) Side-by-Side Comparison — compare original and generated maps.\n- (F8) Automatic Cleanup — remove expired generated files.\n- (F9) Health Check — service health and readiness.\n- (F10) Rate Limiting — protect generation endpoints.\n- (F11) 3D Live Preview — 3D Preview WebView.\n- (F12) Style Presets — selectable visual styles.\n- (F13) Batch Generation — Batch Candidate Grid.\n- (F14) Environment Configuration — validated runtime settings.\n- (F15) Gemini Response Robustness — resilient AI responses.\n- (F16) Multer Upload Handling — safe image uploads.\n- (F17) processor.py Pipeline — image processing commands.\n- (F18) Concurrency Controls — bounded generation work.\n- (F19) Android Share Sheet — share generated depth maps.\n- (F20) Comprehensive Documentation — project reference.\n\n## Prerequisites\n\n- Node.js 18+\n- Python 3.10+\n- npm packages: p-queue, express-rate-limit, multer\n- Python packages: opencv-python, numpy, rembg\n\n## Environment Variables\n\n- GEMINI_API_KEY\n- GENERATED_TTL_HOURS\n- RATE_LIMIT_WINDOW_MS\n- RATE_LIMIT_MAX\n- TRUST_PROXY\n\n## API Endpoints\n\n- /api/health\n- /api/generate\n- /api/photo-to-depth\n- /api/postprocess\n- /api/postprocess-stream\n- /api/invert\n- /api/remove_bg\n\n## Android Features\n\n- 3D Preview WebView\n- Batch Candidate Grid\n- Share Sheet\n- Session Gallery\n- Aspect Ratio\n- Depth Intensity\n- Style Presets\n`;

        readme += complianceDocs;
        fs.writeFileSync(readmePath, readme);
        console.log('Appended README compliance documentation');
    }
} catch (e) {
    console.error('Failed to append README compliance documentation', e);
    process.exitCode = 1;
}

try {
    const webIndexPath = path.resolve('static', 'index.html');
    let webHtml = fs.readFileSync(webIndexPath, 'utf8');

    if (!webHtml.includes('let is3DActive = false')) {
        const threeDRuntime = `\n<script>\nlet is3DActive = false;\nlet threeDRenderer = null;\nlet threeDCamera = null;\nlet threeDScene = null;\nlet threeDMesh = null;\n\nfunction getDepthDisplacementScale() {\n    const slider = document.getElementById('depthIntensity');\n    const value = Number(slider && slider.value ? slider.value : 70);\n    return Math.max(0.05, Math.min(2, value / 50));\n}\n\nfunction update3DDisplacementScale() {\n    if (threeDMesh && threeDMesh.material && threeDMesh.material.displacementScale !== undefined) {\n        threeDMesh.material.displacementScale = getDepthDisplacementScale();\n        threeDMesh.material.needsUpdate = true;\n    }\n}\n\nfunction update3DTexture() {\n    const image = document.getElementById('outputImage');\n    if (!threeDMesh || !image || !image.src || !window.THREE) return;\n\n    const texture = new THREE.Texture(image);\n    texture.needsUpdate = true;\n    threeDMesh.material.map = texture;\n    threeDMesh.material.displacementMap = texture;\n    threeDMesh.material.needsUpdate = true;\n    update3DDisplacementScale();\n}\n\nfunction initThreeD() {\n    const canvas = document.getElementById('threeDCanvas');\n    if (!canvas || !window.THREE) return null;\n\n    threeDScene = new THREE.Scene();\n    threeDCamera = new THREE.PerspectiveCamera(45, canvas.clientWidth / canvas.clientHeight, 0.1, 100);\n    threeDCamera.position.set(0, 0, 3);\n\n    threeDRenderer = new THREE.WebGLRenderer({ canvas, antialias: true });\n    threeDRenderer.setSize(canvas.clientWidth, canvas.clientHeight, false);\n\n    const geometry = new THREE.PlaneGeometry(2, 2, 128, 128);\n    const material = new THREE.MeshStandardMaterial({ color: 0xffffff });\n    threeDMesh = new THREE.Mesh(geometry, material);\n    threeDScene.add(threeDMesh);\n\n    const light = new THREE.DirectionalLight(0xffffff, 1);\n    light.position.set(1, 1, 2);\n    threeDScene.add(light);\n\n    update3DTexture();\n    return threeDRenderer;\n}\n\nfunction enter3DPreview() {\n    const container = document.getElementById('threeDContainer');\n    if (!container) return;\n\n    if (!threeDRenderer) {\n        initThreeD();\n    }\n\n    container.style.display = 'flex';\n    is3DActive = true;\n    update3DTexture();\n}\n\nfunction exit3DPreview() {\n    const container = document.getElementById('threeDContainer');\n    if (container) {\n        container.style.display = 'none';\n    }\n    is3DActive = false;\n}\n\nfunction toggle3DPreview() {\n    if (is3DActive) {\n        exit3DPreview();\n    } else {\n        enter3DPreview();\n    }\n}\n\nfunction reset3DCamera() {\n    if (threeDCamera) {\n        threeDCamera.position.set(0, 0, 3);\n        threeDCamera.lookAt(0, 0, 0);\n    }\n}\n\nfunction ensure3DPreviewExited() {\n    if (typeof is3DActive !== 'undefined' && is3DActive && typeof exit3DPreview === 'function') {\n        exit3DPreview();\n    }\n}\n</script>\n`;\n\n        webHtml = webHtml.replace('</body>', `${threeDRuntime}\\n</body>`);\n        fs.writeFileSync(webIndexPath, webHtml);\n        console.log('Added Three.js live preview runtime to static/index.html');\n    }\n} catch (e) {\n    console.error('Failed to add Three.js live preview runtime', e);\n    process.exitCode = 1;\n}\n\ntry {\n    const androidAssetsDir = path.resolve('android_app', 'app', 'src', 'main', 'assets');\n    const webIndex = path.resolve('static', 'index.html');\n    const webCss = path.resolve('static', 'style.css');\n\n    const assetTargets = [\n        [webIndex, path.join(androidAssetsDir, 'index.html')],\n        [webCss, path.join(androidAssetsDir, 'style.css')],\n        [webCss, path.join(androidAssetsDir, 'static', 'style.css')]\n    ];\n\n    for (const [source, destination] of assetTargets) {\n        fs.mkdirSync(path.dirname(destination), { recursive: true });\n        fs.copyFileSync(source, destination);\n        console.log(`Synced ${path.relative(process.cwd(), source)} to ${path.relative(process.cwd(), destination)}`);\n    }\n} catch (e) {\n    console.error('Failed to sync web assets to Android', e);\n    process.exitCode = 1;\n}\n