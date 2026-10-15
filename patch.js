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
    const webIndexPath = path.resolve('static', 'index.html');
    let webHtml = fs.readFileSync(webIndexPath, 'utf8');

    if (!webHtml.includes('let is3DActive = false')) {
        const threeDRuntime = `
<script>
let is3DActive = false;
let threeDRenderer = null;
let threeDCamera = null;
let threeDScene = null;
let threeDMesh = null;

function getDepthDisplacementScale() {
    const slider = document.getElementById('depthIntensity');
    const value = Number(slider && slider.value ? slider.value : 70);
    return Math.max(0.05, Math.min(2, value / 50));
}

function update3DDisplacementScale() {
    if (threeDMesh && threeDMesh.material && threeDMesh.material.displacementScale !== undefined) {
        threeDMesh.material.displacementScale = getDepthDisplacementScale();
        threeDMesh.material.needsUpdate = true;
    }
}

function update3DTexture() {
    const image = document.getElementById('outputImage');
    if (!threeDMesh || !image || !image.src || !window.THREE) return;

    const texture = new THREE.Texture(image);
    texture.needsUpdate = true;
    threeDMesh.material.map = texture;
    threeDMesh.material.displacementMap = texture;
    threeDMesh.material.needsUpdate = true;
    update3DDisplacementScale();
}

function initThreeD() {
    const canvas = document.getElementById('threeDCanvas');
    if (!canvas || !window.THREE) return null;

    threeDScene = new THREE.Scene();
    threeDCamera = new THREE.PerspectiveCamera(45, canvas.clientWidth / canvas.clientHeight, 0.1, 100);
    threeDCamera.position.set(0, 0, 3);

    threeDRenderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    threeDRenderer.setSize(canvas.clientWidth, canvas.clientHeight, false);

    const geometry = new THREE.PlaneGeometry(2, 2, 128, 128);
    const material = new THREE.MeshStandardMaterial({ color: 0xffffff });
    threeDMesh = new THREE.Mesh(geometry, material);
    threeDScene.add(threeDMesh);

    const light = new THREE.DirectionalLight(0xffffff, 1);
    light.position.set(1, 1, 2);
    threeDScene.add(light);

    update3DTexture();
    return threeDRenderer;
}

function enter3DPreview() {
    const container = document.getElementById('threeDContainer');
    if (!container) return;

    if (!threeDRenderer) {
        initThreeD();
    }

    container.style.display = 'flex';
    is3DActive = true;
    update3DTexture();
}

function exit3DPreview() {
    const container = document.getElementById('threeDContainer');
    if (container) {
        container.style.display = 'none';
    }
    is3DActive = false;
}

function toggle3DPreview() {
    if (is3DActive) {
        exit3DPreview();
    } else {
        enter3DPreview();
    }
}

function reset3DCamera() {
    if (threeDCamera) {
        threeDCamera.position.set(0, 0, 3);
        threeDCamera.lookAt(0, 0, 0);
    }
}

function ensure3DPreviewExited() {
    if (typeof is3DActive !== 'undefined' && is3DActive && typeof exit3DPreview === 'function') {
        exit3DPreview();
    }
}
</script>
`;

        webHtml = webHtml.replace('</body>', `${threeDRuntime}\n</body>`);
        fs.writeFileSync(webIndexPath, webHtml);
        console.log('Added Three.js live preview runtime to static/index.html');
    }
} catch (e) {
    console.error('Failed to add Three.js live preview runtime', e);
    process.exitCode = 1;
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
