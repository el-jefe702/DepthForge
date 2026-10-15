import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

describe('3D Live Preview (Three.js Displacement) (F11) - Unit & Integration Tests', () => {

    const webHtml = fs.readFileSync(path.join(rootDir, 'static', 'index.html'), 'utf-8');
    const androidHtml = fs.readFileSync(path.join(rootDir, 'android_app', 'app', 'src', 'main', 'assets', 'index.html'), 'utf-8');
    const webCss = fs.readFileSync(path.join(rootDir, 'static', 'style.css'), 'utf-8');
    const androidCss = fs.readFileSync(path.join(rootDir, 'android_app', 'app', 'src', 'main', 'assets', 'style.css'), 'utf-8');
    const androidStaticCss = fs.readFileSync(path.join(rootDir, 'android_app', 'app', 'src', 'main', 'assets', 'static', 'style.css'), 'utf-8');
    const mainActivityPath = path.join(rootDir, 'android_app', 'app', 'src', 'main', 'kotlin', 'com', 'depthforge', 'app', 'MainActivity.kt');
    const mainActivity = fs.readFileSync(mainActivityPath, 'utf-8');

    describe('1. Web UI & Assets Parity', () => {
        test('index.html is identical byte-for-byte between static/ and android assets', () => {
            assert.equal(webHtml, androidHtml);
        });

        test('style.css is identical byte-for-byte between static/ and android assets', () => {
            assert.equal(webCss, androidCss);
            assert.equal(webCss, androidStaticCss);
        });

        test('HTML loads Three.js from CDN in head', () => {
            assert.ok(webHtml.includes('<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>'));
        });

        test('HTML contains 3D live preview container, canvas, controls, and hints', () => {
            assert.ok(webHtml.includes('id="threeDContainer"'));
            assert.ok(webHtml.includes('id="threeDCanvas"'));
            assert.ok(webHtml.includes('id="threeDHint"'));
            assert.ok(webHtml.includes('id="reset3DCameraBtn"'));
            assert.ok(webHtml.includes('id="exit3DBtn"'));
            assert.ok(webHtml.includes('onclick="reset3DCamera()"'));
            assert.ok(webHtml.includes('onclick="exit3DPreview()"'));
        });

        test('Action bar contains 3D Preview button with purple styling and toggle handler', () => {
            assert.ok(webHtml.includes('id="threeDPreviewBtn"'));
            assert.ok(webHtml.includes('onclick="toggle3DPreview()"'));
            assert.ok(webHtml.includes('btn-action purple'));
            assert.ok(webHtml.includes('🧊 3D Preview'));
        });

        test('3D canvas includes accessibility attributes', () => {
            assert.ok(webHtml.includes('tabindex="0"'));
            assert.ok(webHtml.includes('role="region"'));
            assert.ok(webHtml.includes('aria-label="3D Depth Map Surface"'));
        });
    });

    describe('2. CSS Styles & Design System', () => {
        test('CSS defines .three-d-container and .three-d-canvas viewport layout', () => {
            assert.ok(webCss.includes('.three-d-container'));
            assert.ok(webCss.includes('.three-d-canvas'));
            assert.ok(webCss.includes('cursor: grab'));
            assert.ok(webCss.includes('cursor: grabbing'));
        });

        test('CSS defines controls for 3D view (.btn-three-d-reset, .btn-three-d-exit, .three-d-hint)', () => {
            assert.ok(webCss.includes('.three-d-hint'));
            assert.ok(webCss.includes('.btn-three-d-reset'));
            assert.ok(webCss.includes('.btn-three-d-exit'));
            assert.ok(webCss.includes('.btn-action.purple'));
            assert.ok(webCss.includes('.btn-action.purple.active'));
        });
    });

    describe('3. Client-Side JavaScript Logic & State Management', () => {
        const scriptBlocks = Array.from(webHtml.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/gi));
        assert.ok(scriptBlocks.length > 0, 'Inline script block must be present in HTML');
        const scriptCode = scriptBlocks.map(m => m[1]).join('\n');

        test('JS defines all required 3D preview functions and states', () => {
            assert.ok(scriptCode.includes('let is3DActive = false'));
            assert.ok(scriptCode.includes('function initThreeD('));
            assert.ok(scriptCode.includes('function enter3DPreview('));
            assert.ok(scriptCode.includes('function exit3DPreview('));
            assert.ok(scriptCode.includes('function toggle3DPreview('));
            assert.ok(scriptCode.includes('function reset3DCamera('));
            assert.ok(scriptCode.includes('function update3DTexture('));
            assert.ok(scriptCode.includes('function update3DDisplacementScale('));
            assert.ok(scriptCode.includes('function getDepthDisplacementScale('));
        });

        test('Generation and Comparison flows automatically exit 3D preview if active', () => {
            assert.ok(webHtml.includes('if (typeof is3DActive !== \'undefined\' && is3DActive && typeof exit3DPreview === \'function\')'));
        });
    });

    describe('4. Android Native UI Integration', () => {
        test('MainActivity.kt defines PurpleAccent color', () => {
            assert.ok(mainActivity.includes('val PurpleAccent = Color(0xFF8B5CF6)'));
        });

        test('MainActivity.kt defines show3DWebView state for WebView dialog', () => {
            assert.ok(mainActivity.includes('var show3DWebView by remember { mutableStateOf(false) }'));
        });

        test('MainActivity.kt renders 3D Preview button with WebView trigger', () => {
            assert.ok(mainActivity.includes('Text("🧊 3D Preview"'));
            assert.ok(mainActivity.includes('backgroundColor = PurpleAccent'));
            assert.ok(mainActivity.includes('show3DWebView = true'));
        });

        test('MainActivity.kt embeds WebView with JavaScript and WebGL enabled', () => {
            assert.ok(mainActivity.includes('AndroidView('));
            assert.ok(mainActivity.includes('WebView(ctx)'));
            assert.ok(mainActivity.includes('settings.javaScriptEnabled = true'));
            assert.ok(mainActivity.includes('settings.domStorageEnabled = true'));
        });

        test('MainActivity.kt loads local Three.js assets in WebView', () => {
            assert.ok(mainActivity.includes('loadUrl("file:///android_asset/index.html")'));
        });

        test('MainActivity.kt injects JavaScript to enter 3D preview with current image', () => {
            assert.ok(mainActivity.includes('evaluateJavascript'));
            assert.ok(mainActivity.includes('enter3DPreview'));
            assert.ok(mainActivity.includes('showOutput'));
            assert.ok(mainActivity.includes('currentImageUrl'));
        });

        test('MainActivity.kt provides BackHandler and close button for 3D WebView dialog', () => {
            assert.ok(mainActivity.includes('BackHandler { show3DWebView = false }'));
            assert.ok(mainActivity.includes('✕ Close 3D Preview'));
            assert.ok(mainActivity.includes('webViewRef.value?.destroy()'));
        });

        test('MainActivity.kt uses fullscreen DialogProperties for immersive 3D experience', () => {
            assert.ok(mainActivity.includes('usePlatformDefaultWidth = false'));
            assert.ok(mainActivity.includes('dismissOnBackPress = true'));
            assert.ok(mainActivity.includes('fillMaxHeight'));
        });
    });
});
