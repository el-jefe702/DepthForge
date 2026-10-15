import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

process.env.NODE_ENV = 'test';
process.env.GEMINI_API_KEY = 'test_key';

const {
    app,
    sanitizeDepthIntensity,
    getDepthModifier,
    buildFinalPrompt,
    ai
} = await import('../server.js');

describe('Depth Intensity Feature (F6) - Unit & Integration Tests', () => {

    describe('1. Sanitize Depth Intensity Logic', () => {
        test('defaults to 70 when value is undefined, null, empty or whitespace string', () => {
            assert.equal(sanitizeDepthIntensity(undefined), 70);
            assert.equal(sanitizeDepthIntensity(null), 70);
            assert.equal(sanitizeDepthIntensity(''), 70);
            assert.equal(sanitizeDepthIntensity('   '), 70);
            assert.equal(sanitizeDepthIntensity('\t\n'), 70);
        });

        test('defaults to 70 for invalid, non-numeric, boolean, or non-finite values', () => {
            assert.equal(sanitizeDepthIntensity(NaN), 70);
            assert.equal(sanitizeDepthIntensity('invalid'), 70);
            assert.equal(sanitizeDepthIntensity({}), 70);
            assert.equal(sanitizeDepthIntensity([]), 70);
            assert.equal(sanitizeDepthIntensity([50]), 70);
            assert.equal(sanitizeDepthIntensity(true), 70);
            assert.equal(sanitizeDepthIntensity(false), 70);
            assert.equal(sanitizeDepthIntensity(Symbol('test')), 70);
            assert.equal(sanitizeDepthIntensity(() => {}), 70);
            assert.equal(sanitizeDepthIntensity(Infinity), 70);
            assert.equal(sanitizeDepthIntensity(-Infinity), 70);
            assert.equal(sanitizeDepthIntensity('Infinity'), 70);
            assert.equal(sanitizeDepthIntensity('-Infinity'), 70);
        });

        test('parses and returns valid numbers within 0-100 range', () => {
            assert.equal(sanitizeDepthIntensity(0), 0);
            assert.equal(sanitizeDepthIntensity(30), 30);
            assert.equal(sanitizeDepthIntensity(50), 50);
            assert.equal(sanitizeDepthIntensity(70), 70);
            assert.equal(sanitizeDepthIntensity(100), 100);
        });

        test('parses numeric string representations correctly', () => {
            assert.equal(sanitizeDepthIntensity('0'), 0);
            assert.equal(sanitizeDepthIntensity('25'), 25);
            assert.equal(sanitizeDepthIntensity('70'), 70);
            assert.equal(sanitizeDepthIntensity('85'), 85);
            assert.equal(sanitizeDepthIntensity('100'), 100);
        });

        test('clamps values below 0 to 0 and above 100 to 100', () => {
            assert.equal(sanitizeDepthIntensity(-10), 0);
            assert.equal(sanitizeDepthIntensity(-100), 0);
            assert.equal(sanitizeDepthIntensity(105), 100);
            assert.equal(sanitizeDepthIntensity(999), 100);
            assert.equal(sanitizeDepthIntensity('-25'), 0);
            assert.equal(sanitizeDepthIntensity('250'), 100);
        });

        test('rounds floating point inputs to nearest integer', () => {
            assert.equal(sanitizeDepthIntensity(70.4), 70);
            assert.equal(sanitizeDepthIntensity(70.6), 71);
            assert.equal(sanitizeDepthIntensity('29.8'), 30);
        });
    });

    describe('2. Prompt Modifier Injection & buildFinalPrompt Logic', () => {
        const GENTLE_PHRASE = 'gentle, shallow relief with subtle height transitions';
        const DRAMATIC_PHRASE = 'dramatic, maximum-depth carving with extreme black-to-white contrast and deep relief';

        test('0–30 returns gentle modifier and incorporates into prompt', () => {
            for (const val of [0, 15, 30]) {
                assert.equal(getDepthModifier(val), GENTLE_PHRASE);
                const prompt = buildFinalPrompt('lion', val);
                assert.ok(prompt.includes(GENTLE_PHRASE), `Expected prompt to include gentle phrase for intensity ${val}`);
                assert.ok(!prompt.includes(DRAMATIC_PHRASE), `Expected prompt NOT to include dramatic phrase for intensity ${val}`);
            }
        });

        test('31–69 returns empty modifier for default behavior without extreme modifiers', () => {
            for (const val of [31, 50, 69]) {
                assert.equal(getDepthModifier(val), '');
                const prompt = buildFinalPrompt('lion', val);
                assert.ok(!prompt.includes(GENTLE_PHRASE), `Expected prompt NOT to include gentle phrase for intensity ${val}`);
                assert.ok(!prompt.includes(DRAMATIC_PHRASE), `Expected prompt NOT to include dramatic phrase for intensity ${val}`);
                assert.ok(prompt.includes('A perfect, ultra-smooth 3D grayscale height map of lion.'));
            }
        });

        test('70–100 returns dramatic modifier and incorporates into prompt', () => {
            for (const val of [70, 85, 100]) {
                assert.equal(getDepthModifier(val), DRAMATIC_PHRASE);
                const prompt = buildFinalPrompt('lion', val);
                assert.ok(prompt.includes(DRAMATIC_PHRASE), `Expected prompt to include dramatic phrase for intensity ${val}`);
                assert.ok(!prompt.includes(GENTLE_PHRASE), `Expected prompt NOT to include gentle phrase for intensity ${val}`);
            }
        });

        test('default 70 when intensity is omitted preserves dramatic expected behavior', () => {
            assert.equal(getDepthModifier(70), DRAMATIC_PHRASE);
            const promptDefault = buildFinalPrompt('lion');
            assert.ok(promptDefault.includes(DRAMATIC_PHRASE));
            assert.ok(!promptDefault.includes(GENTLE_PHRASE));
        });

        test('exact boundary conditions: 0, 30, 31, 69, 70, 100', () => {
            assert.equal(getDepthModifier(0), GENTLE_PHRASE);
            assert.equal(getDepthModifier(30), GENTLE_PHRASE);
            assert.equal(getDepthModifier(31), '');
            assert.equal(getDepthModifier(69), '');
            assert.equal(getDepthModifier(70), DRAMATIC_PHRASE);
            assert.equal(getDepthModifier(100), DRAMATIC_PHRASE);
        });
    });

    describe('3. Express Server Endpoint /api/generate', () => {
        let originalGenerateContent;
        let originalGenerateImages;
        let capturedPrompt = null;

        beforeEach(() => {
            capturedPrompt = null;
            originalGenerateContent = ai.models.generateContent;
            originalGenerateImages = ai.models.generateImages;

            ai.models.generateContent = async () => ({
                text: JSON.stringify({ improved_prompt: 'improved lion medallion' })
            });

            ai.models.generateImages = async (params) => {
                capturedPrompt = params.prompt;
                return {
                    generatedImages: [
                        { image: { imageBytes: Buffer.from('mock_png_bytes').toString('base64') } }
                    ]
                };
            };
        });

        afterEach(() => {
            ai.models.generateContent = originalGenerateContent;
            ai.models.generateImages = originalGenerateImages;
        });

        test('applies gentle modifier when depth_intensity is <= 30', async () => {
            const server = app.listen(0);
            const port = server.address().port;

            try {
                const response = await fetch(`http://127.0.0.1:${port}/api/generate`, {
                    method: 'POST',
                    headers: {
        'Authorization': 'Bearer ' + (process.env.TEST_JWT_TOKEN || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6InRlc3RfdXNlciIsInVzZXJfaWQiOiJ0ZXN0X3VzZXIiLCJpYXQiOjE3OTIwNTMzMTd9.S8YcO_W-Y7sJfI-8qBipvTix6qBkFuq60TgfOZNe-2c'), 'Content-Type': 'application/json' },
                    body: JSON.stringify({ prompt: 'lion medallion', depth_intensity: 20 })
                });

                assert.equal(response.status, 200);
                const data = await response.json();
                assert.equal(data.status, 'success');
                assert.ok(capturedPrompt);
                assert.ok(capturedPrompt.includes('gentle, shallow relief with subtle height transitions'));
                assert.ok(!capturedPrompt.includes('dramatic, maximum-depth carving'));
            } finally {
                server.close();
            }
        });

        test('applies dramatic modifier when depth_intensity is >= 70', async () => {
            const server = app.listen(0);
            const port = server.address().port;

            try {
                const response = await fetch(`http://127.0.0.1:${port}/api/generate`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ prompt: 'lion medallion', depth_intensity: 90 })
                });

                assert.equal(response.status, 200);
                const data = await response.json();
                assert.equal(data.status, 'success');
                assert.ok(capturedPrompt);
                assert.ok(capturedPrompt.includes('dramatic, maximum-depth carving with extreme black-to-white contrast and deep relief'));
                assert.ok(!capturedPrompt.includes('gentle, shallow relief'));
            } finally {
                server.close();
            }
        });

        test('applies default behavior when depth_intensity is in 31–69 range', async () => {
            const server = app.listen(0);
            const port = server.address().port;

            try {
                const response = await fetch(`http://127.0.0.1:${port}/api/generate`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ prompt: 'lion medallion', depth_intensity: 50 })
                });

                assert.equal(response.status, 200);
                const data = await response.json();
                assert.equal(data.status, 'success');
                assert.ok(capturedPrompt);
                assert.ok(!capturedPrompt.includes('gentle, shallow relief'));
                assert.ok(!capturedPrompt.includes('dramatic, maximum-depth carving'));
            } finally {
                server.close();
            }
        });

        test('defaults to 70 with dramatic modifier when depth_intensity is omitted', async () => {
            const server = app.listen(0);
            const port = server.address().port;

            try {
                const response = await fetch(`http://127.0.0.1:${port}/api/generate`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ prompt: 'lion medallion' })
                });

                assert.equal(response.status, 200);
                const data = await response.json();
                assert.equal(data.status, 'success');
                assert.ok(capturedPrompt);
                assert.ok(capturedPrompt.includes('dramatic, maximum-depth carving with extreme black-to-white contrast and deep relief'));
            } finally {
                server.close();
            }
        });

        test('accepts camelCase depthIntensity parameter fallback', async () => {
            const server = app.listen(0);
            const port = server.address().port;

            try {
                const response = await fetch(`http://127.0.0.1:${port}/api/generate`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ prompt: 'lion medallion', depthIntensity: 25 })
                });

                assert.equal(response.status, 200);
                assert.ok(capturedPrompt);
                assert.ok(capturedPrompt.includes('gentle, shallow relief with subtle height transitions'));
            } finally {
                server.close();
            }
        });

        test('defaults to 70 when depth_intensity is whitespace or invalid type in /api/generate', async () => {
            const server = app.listen(0);
            const port = server.address().port;

            try {
                const response = await fetch(`http://127.0.0.1:${port}/api/generate`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ prompt: 'lion medallion', depth_intensity: '   ' })
                });

                assert.equal(response.status, 200);
                const data = await response.json();
                assert.equal(data.status, 'success');
                assert.ok(capturedPrompt);
                assert.ok(capturedPrompt.includes('dramatic, maximum-depth carving with extreme black-to-white contrast and deep relief'));
            } finally {
                server.close();
            }
        });
    });

    describe('4. Express Server Endpoint /api/photo-to-depth', () => {
        let originalGenerateContent;
        let originalGenerateImages;
        let capturedPrompt = null;

        beforeEach(() => {
            capturedPrompt = null;
            originalGenerateContent = ai.models.generateContent;
            originalGenerateImages = ai.models.generateImages;

            ai.models.generateContent = async () => ({
                text: JSON.stringify({
                    depth_prompt: 'photo depth structure',
                    subject_description: 'sample photo subject'
                })
            });

            ai.models.generateImages = async (params) => {
                capturedPrompt = params.prompt;
                return {
                    generatedImages: [
                        { image: { imageBytes: Buffer.from('mock_png_bytes').toString('base64') } }
                    ]
                };
            };
        });

        afterEach(() => {
            ai.models.generateContent = originalGenerateContent;
            ai.models.generateImages = originalGenerateImages;
        });

        test('applies gentle modifier when depth_intensity is <= 30 via multipart form', async () => {
            const server = app.listen(0);
            const port = server.address().port;

            try {
                const formData = new FormData();
                const fakeFile = new Blob(['mock_image_data'], { type: 'image/png' });
                formData.append('photo', fakeFile, 'test.png');
                formData.append('depth_intensity', '25');

                const response = await fetch(`http://127.0.0.1:${port}/api/photo-to-depth`, {
                    method: 'POST',
                    body: formData
                });

                assert.equal(response.status, 200);
                assert.ok(capturedPrompt);
                assert.ok(capturedPrompt.includes('gentle, shallow relief with subtle height transitions'));
            } finally {
                server.close();
            }
        });

        test('applies dramatic modifier when depth_intensity is >= 70 via multipart form', async () => {
            const server = app.listen(0);
            const port = server.address().port;

            try {
                const formData = new FormData();
                const fakeFile = new Blob(['mock_image_data'], { type: 'image/png' });
                formData.append('photo', fakeFile, 'test.png');
                formData.append('depth_intensity', '85');

                const response = await fetch(`http://127.0.0.1:${port}/api/photo-to-depth`, {
                    method: 'POST',
                    body: formData
                });

                assert.equal(response.status, 200);
                assert.ok(capturedPrompt);
                assert.ok(capturedPrompt.includes('dramatic, maximum-depth carving with extreme black-to-white contrast and deep relief'));
            } finally {
                server.close();
            }
        });

        test('defaults to 70 with dramatic modifier when depth_intensity is omitted in multipart form', async () => {
            const server = app.listen(0);
            const port = server.address().port;

            try {
                const formData = new FormData();
                const fakeFile = new Blob(['mock_image_data'], { type: 'image/png' });
                formData.append('photo', fakeFile, 'test.png');

                const response = await fetch(`http://127.0.0.1:${port}/api/photo-to-depth`, {
                    method: 'POST',
                    body: formData
                });

                assert.equal(response.status, 200);
                assert.ok(capturedPrompt);
                assert.ok(capturedPrompt.includes('dramatic, maximum-depth carving with extreme black-to-white contrast and deep relief'));
            } finally {
                server.close();
            }
        });

        test('defaults to 70 when depth_intensity is whitespace string in multipart form', async () => {
            const server = app.listen(0);
            const port = server.address().port;

            try {
                const formData = new FormData();
                const fakeFile = new Blob(['mock_image_data'], { type: 'image/png' });
                formData.append('photo', fakeFile, 'test.png');
                formData.append('depth_intensity', '   ');

                const response = await fetch(`http://127.0.0.1:${port}/api/photo-to-depth`, {
                    method: 'POST',
                    body: formData
                });

                assert.equal(response.status, 200);
                assert.ok(capturedPrompt);
                assert.ok(capturedPrompt.includes('dramatic, maximum-depth carving with extreme black-to-white contrast and deep relief'));
            } finally {
                server.close();
            }
        });

        test('returns 400 when no photo is uploaded', async () => {
            const server = app.listen(0);
            const port = server.address().port;

            try {
                const formData = new FormData();
                formData.append('depth_intensity', '70');

                const response = await fetch(`http://127.0.0.1:${port}/api/photo-to-depth`, {
                    method: 'POST',
                    body: formData
                });

                assert.equal(response.status, 400);
                const data = await response.json();
                assert.ok(data.error);
            } finally {
                server.close();
            }
        });
    });

    describe('5. Web UI & Android Assets Parity', () => {
        const webHtml = fs.readFileSync(path.join(rootDir, 'static', 'index.html'), 'utf-8');
        const androidHtml = fs.readFileSync(path.join(rootDir, 'android_app', 'app', 'src', 'main', 'assets', 'index.html'), 'utf-8');
        const webCss = fs.readFileSync(path.join(rootDir, 'static', 'style.css'), 'utf-8');
        const androidCss = fs.readFileSync(path.join(rootDir, 'android_app', 'app', 'src', 'main', 'assets', 'style.css'), 'utf-8');
        const androidStaticCss = fs.readFileSync(path.join(rootDir, 'android_app', 'app', 'src', 'main', 'assets', 'static', 'style.css'), 'utf-8');

        test('index.html is identical between static/ and android assets', () => {
            assert.equal(webHtml, androidHtml);
        });

        test('style.css is identical between static/ and android assets', () => {
            assert.equal(webCss, androidCss);
            assert.equal(webCss, androidStaticCss);
        });

        test('HTML contains depth intensity slider labeled Depth Intensity with range 0–100 and default 70', () => {
            assert.ok(webHtml.includes('id="depthIntensity"'));
            assert.ok(webHtml.includes('min="0"'));
            assert.ok(webHtml.includes('max="100"'));
            assert.ok(webHtml.includes('value="70"'));
            assert.ok(webHtml.includes('Depth Intensity'));
        });

        test('HTML contains dynamic value indicator showing 70%', () => {
            assert.ok(webHtml.includes('id="depthIntensityVal"'));
            assert.ok(webHtml.includes('70%'));
        });

        test('HTML contains updateDepthIntensity function', () => {
            assert.ok(webHtml.includes('function updateDepthIntensity'));
            assert.ok(webHtml.includes('oninput="updateDepthIntensity(this.value)"'));
        });

        test('HTML range sliders include full WCAG accessibility attributes and onchange handler', () => {
            assert.ok(webHtml.includes('aria-label="Depth Intensity"'));
            assert.ok(webHtml.includes('aria-labelledby="depthIntensityLabel"'));
            assert.ok(webHtml.includes('aria-labelledby="photoDepthIntensityLabel"'));
            assert.ok(webHtml.includes('aria-valuemin="0"'));
            assert.ok(webHtml.includes('aria-valuemax="100"'));
            assert.ok(webHtml.includes('aria-valuenow="70"'));
            assert.ok(webHtml.includes('aria-valuetext="70%"'));
            assert.ok(webHtml.includes('title="Depth Intensity: 70%"'));
            assert.ok(webHtml.includes('onchange="updateDepthIntensity(this.value)"'));
        });

        test('updateDepthIntensity updates aria-valuenow, aria-valuetext, and title dynamically', () => {
            assert.ok(webHtml.includes("setAttribute('aria-valuenow', numericVal)"));
            assert.ok(webHtml.includes("setAttribute('aria-valuetext', `${numericVal}%`)"));
            assert.ok(webHtml.includes("title = `Depth Intensity: ${numericVal}%`"));
        });

        test('switchMode synchronizes depth intensity slider between tabs', () => {
            assert.ok(webHtml.includes('// Synchronize depth intensity slider between tabs'));
            assert.ok(webHtml.includes("updateDepthIntensity(currentVal)"));
        });

        test('style.css defines .form-range:focus-visible for keyboard accessibility', () => {
            assert.ok(webCss.includes('.form-range:focus-visible'));
            assert.ok(webCss.includes('outline: 2px solid var(--accent-gold)'));
            assert.ok(webCss.includes('.form-range:focus-visible::-webkit-slider-thumb'));
            assert.ok(webCss.includes('.form-range:focus-visible::-moz-range-thumb'));
        });

        test('HTML JS sends depth_intensity in generateMap and convertPhoto', () => {
            assert.ok(webHtml.includes("document.getElementById('depthIntensity')"));
            assert.ok(webHtml.includes('depth_intensity'));
            assert.ok(webHtml.includes("formData.append('depth_intensity'"));
        });

        test('HTML JS preserves 0% depth intensity without converting 0 to 70 via falsy fallback', () => {
            // Validate parsing logic extracts 0 rather than falsy 70
            const simulateParse = (rawVal) => {
                const parsed = parseInt(rawVal ?? '70', 10);
                return Number.isNaN(parsed) ? 70 : Math.max(0, Math.min(100, parsed));
            };
            assert.equal(simulateParse('0'), 0);
            assert.equal(simulateParse('30'), 30);
            assert.equal(simulateParse('70'), 70);
            assert.equal(simulateParse('100'), 100);
            assert.equal(simulateParse(undefined), 70);
            assert.equal(simulateParse(''), 70);
            assert.equal(simulateParse('invalid'), 70);
            assert.equal(simulateParse('-10'), 0);
            assert.equal(simulateParse('150'), 100);

            // Confirm webHtml uses NaN check rather than || 70 on parseInt
            assert.ok(!webHtml.includes('parseInt(document.getElementById(\'depthIntensity\')?.value || \'70\', 10) || 70'));
            assert.ok(webHtml.includes('Number.isNaN(parsedDepth) ? 70 : Math.max(0, Math.min(100, parsedDepth))'));
        });
    });

    describe('6. Android Native UI & Client Integration', () => {
        const apiClientKt = fs.readFileSync(path.join(rootDir, 'android_app', 'app', 'src', 'main', 'kotlin', 'com', 'depthforge', 'app', 'ApiClient.kt'), 'utf-8');
        const mainActivityKt = fs.readFileSync(path.join(rootDir, 'android_app', 'app', 'src', 'main', 'kotlin', 'com', 'depthforge', 'app', 'MainActivity.kt'), 'utf-8');

        test('ApiClient.kt has depthIntensity parameter and sends depth_intensity', () => {
            assert.ok(apiClientKt.includes('depthIntensity: Int = 70'));
            assert.ok(apiClientKt.includes('put("depth_intensity", depthIntensity)'));
            assert.ok(apiClientKt.includes('"depth_intensity" to depthIntensity.toString()'));
        });

        test('ApiClient.kt delegates 2-parameter photoToDepth to 3-parameter overload', () => {
            assert.ok(apiClientKt.includes('return photoToDepth(file, aspectRatio, 70)'));
        });

        test('MainActivity.kt exposes DepthIntensitySlider and connects to ApiClient', () => {
            assert.ok(mainActivityKt.includes('fun DepthIntensitySlider'));
            assert.ok(mainActivityKt.includes('depthIntensity'));
            assert.ok(mainActivityKt.includes('Depth Intensity: ${intensity.toInt()}%'));
            assert.ok(mainActivityKt.includes('ApiClient.generate(promptInput, selectedAspectRatio, depthIntensity.toInt())'));
            assert.ok(mainActivityKt.includes('ApiClient.photoToDepth(tempFile, selectedAspectRatio, depthIntensity.toInt())'));
        });

        test('MainActivity.kt DepthIntensitySlider supports enabled parameter and is guarded by !isBusy', () => {
            assert.ok(mainActivityKt.includes('enabled: Boolean = true'));
            assert.ok(mainActivityKt.includes('enabled = !isBusy'));
        });
    });
});
