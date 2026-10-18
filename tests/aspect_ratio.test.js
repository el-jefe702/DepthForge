import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { authenticatedFetch as fetch } from './authenticated-fetch.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// Set NODE_ENV to test to avoid starting listening server
process.env.NODE_ENV = 'test';
process.env.GEMINI_API_KEY = 'test_key';

const { app, sanitizeAspectRatio, ALLOWED_ASPECT_RATIOS, ai } = await import('../server.js');

describe('Aspect Ratio Feature - Unit & Integration Tests', () => {
    
    describe('1. Sanitize Aspect Ratio Logic', () => {
        test('ALLOWED_ASPECT_RATIOS has exact 5 supported ratios in required order', () => {
            assert.deepEqual(ALLOWED_ASPECT_RATIOS, ['1:1', '4:3', '3:2', '16:9', '2:3']);
            assert.equal(ALLOWED_ASPECT_RATIOS.length, 5);
        });

        test('returns valid ratios unchanged for all 5 allowed values', () => {
            for (const ratio of ['1:1', '4:3', '3:2', '16:9', '2:3']) {
                assert.equal(sanitizeAspectRatio(ratio), ratio);
            }
        });

        test('falls back to 1:1 for invalid, empty, or non-matching string values', () => {
            assert.equal(sanitizeAspectRatio(undefined), '1:1');
            assert.equal(sanitizeAspectRatio(null), '1:1');
            assert.equal(sanitizeAspectRatio(''), '1:1');
            assert.equal(sanitizeAspectRatio('9:16'), '1:1');
            assert.equal(sanitizeAspectRatio('21:9'), '1:1');
            assert.equal(sanitizeAspectRatio('16:10'), '1:1');
            assert.equal(sanitizeAspectRatio('square'), '1:1');
            assert.equal(sanitizeAspectRatio('1:1:1'), '1:1');
            assert.equal(sanitizeAspectRatio('invalid'), '1:1');
            assert.equal(sanitizeAspectRatio(123), '1:1');
            assert.equal(sanitizeAspectRatio({}), '1:1');
            assert.equal(sanitizeAspectRatio([]), '1:1');
        });
    });

    describe('2. Express Server Endpoint /api/generate', () => {
        let originalGenerateContent;
        let originalGenerateImages;
        let capturedImageConfig = null;

        beforeEach(() => {
            capturedImageConfig = null;
            originalGenerateContent = ai.models.generateContent;
            originalGenerateImages = ai.models.generateImages;

            ai.models.generateContent = async () => ({
                text: JSON.stringify({ improved_prompt: 'improved lion relief' })
            });

            ai.models.generateImages = async (params) => {
                capturedImageConfig = params.config;
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

        test('passes each of the 5 allowed aspect ratios to generateImages config', async () => {
            const server = app.listen(0);
            const port = server.address().port;

            try {
                for (const ratio of ['1:1', '4:3', '3:2', '16:9', '2:3']) {
                    const response = await fetch(`http://127.0.0.1:${port}/api/generate`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ prompt: 'lion head', aspectRatio: ratio })
                    });

                    assert.equal(response.status, 200);
                    const data = await response.json();
                    assert.equal(data.status, 'success');
                    assert.ok(capturedImageConfig);
                    assert.equal(capturedImageConfig.aspectRatio, ratio);
                }
            } finally {
                server.close();
            }
        });

        test('defaults aspect ratio to 1:1 when omitted in request body', async () => {
            const server = app.listen(0);
            const port = server.address().port;

            try {
                const response = await fetch(`http://127.0.0.1:${port}/api/generate`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ prompt: 'lion head' })
                });

                assert.equal(response.status, 200);
                const data = await response.json();
                assert.equal(data.status, 'success');
                assert.ok(capturedImageConfig);
                assert.equal(capturedImageConfig.aspectRatio, '1:1');
            } finally {
                server.close();
            }
        });

        test('falls back to 1:1 when an unsupported ratio is passed', async () => {
            const server = app.listen(0);
            const port = server.address().port;

            try {
                const response = await fetch(`http://127.0.0.1:${port}/api/generate`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ prompt: 'lion head', aspectRatio: '99:99' })
                });

                assert.equal(response.status, 200);
                assert.ok(capturedImageConfig);
                assert.equal(capturedImageConfig.aspectRatio, '1:1');
            } finally {
                server.close();
            }
        });

        test('handles API generation failure gracefully with 500 status', async () => {
            ai.models.generateImages = async () => {
                throw new Error('Imagen API rate limit exceeded');
            };

            const server = app.listen(0);
            const port = server.address().port;

            try {
                const response = await fetch(`http://127.0.0.1:${port}/api/generate`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ prompt: 'lion head', aspectRatio: '16:9' })
                });

                assert.equal(response.status, 500);
                const data = await response.json();
                assert.ok(data.error.includes('Imagen API rate limit exceeded'));
            } finally {
                server.close();
            }
        });
    });

    describe('3. Express Server Endpoint /api/photo-to-depth', () => {
        let originalGenerateContent;
        let originalGenerateImages;
        let capturedImageConfig = null;

        beforeEach(() => {
            capturedImageConfig = null;
            originalGenerateContent = ai.models.generateContent;
            originalGenerateImages = ai.models.generateImages;

            ai.models.generateContent = async () => ({
                text: JSON.stringify({
                    depth_prompt: 'detailed depth relief',
                    subject_description: 'a test subject'
                })
            });

            ai.models.generateImages = async (params) => {
                capturedImageConfig = params.config;
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

        test('passes each of the 5 allowed aspect ratios in multipart request to generateImages', async () => {
            const server = app.listen(0);
            const port = server.address().port;

            try {
                for (const ratio of ['1:1', '4:3', '3:2', '16:9', '2:3']) {
                    const formData = new FormData();
                    const fakeFile = new Blob(['mock_image_data'], { type: 'image/png' });
                    formData.append('photo', fakeFile, `test_${ratio.replace(':', '_')}.png`);
                    formData.append('aspectRatio', ratio);

                    const response = await fetch(`http://127.0.0.1:${port}/api/photo-to-depth`, {
                        method: 'POST',
                        body: formData
                    });

                    assert.equal(response.status, 200);
                    const data = await response.json();
                    assert.equal(data.status, 'success');
                    assert.ok(capturedImageConfig);
                    assert.equal(capturedImageConfig.aspectRatio, ratio);
                }
            } finally {
                server.close();
            }
        });

        test('defaults aspect ratio to 1:1 when omitted in multipart request', async () => {
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
                const data = await response.json();
                assert.equal(data.status, 'success');
                assert.ok(capturedImageConfig);
                assert.equal(capturedImageConfig.aspectRatio, '1:1');
            } finally {
                server.close();
            }
        });

        test('falls back to 1:1 when invalid aspect ratio is sent in multipart request', async () => {
            const server = app.listen(0);
            const port = server.address().port;

            try {
                const formData = new FormData();
                const fakeFile = new Blob(['mock_image_data'], { type: 'image/png' });
                formData.append('photo', fakeFile, 'test.png');
                formData.append('aspectRatio', 'invalid_ratio_99');

                const response = await fetch(`http://127.0.0.1:${port}/api/photo-to-depth`, {
                    method: 'POST',
                    body: formData
                });

                assert.equal(response.status, 200);
                assert.ok(capturedImageConfig);
                assert.equal(capturedImageConfig.aspectRatio, '1:1');
            } finally {
                server.close();
            }
        });

        test('returns 400 when no photo is uploaded', async () => {
            const server = app.listen(0);
            const port = server.address().port;

            try {
                const formData = new FormData();
                formData.append('aspectRatio', '16:9');

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

    describe('4. Web UI & Android Assets Parity', () => {
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

        test('HTML contains aspect ratio dropdowns for both text and photo modes', () => {
            assert.ok(webHtml.includes('id="aspectRatioSelect"'));
            assert.ok(webHtml.includes('id="photoAspectRatioSelect"'));
            for (const ratio of ['1:1', '4:3', '3:2', '16:9', '2:3']) {
                assert.ok(webHtml.includes(`value="${ratio}"`));
            }
            assert.ok(webHtml.includes('value="1:1" selected'));
        });

        test('HTML JS sends aspectRatio in generateMap and convertPhoto', () => {
            assert.ok(webHtml.includes('document.getElementById(\'aspectRatioSelect\')'));
            assert.ok(webHtml.includes('document.getElementById(\'photoAspectRatioSelect\')'));
            assert.ok(webHtml.includes('body: JSON.stringify({ prompt, aspectRatio })'));
            assert.ok(webHtml.includes("formData.append('aspectRatio', aspectRatio)"));
        });
    });

    describe('5. Android Native UI & Client Integration', () => {
        const apiClientKt = fs.readFileSync(path.join(rootDir, 'android_app', 'app', 'src', 'main', 'kotlin', 'com', 'depthforge', 'app', 'ApiClient.kt'), 'utf-8');
        const mainActivityKt = fs.readFileSync(path.join(rootDir, 'android_app', 'app', 'src', 'main', 'kotlin', 'com', 'depthforge', 'app', 'MainActivity.kt'), 'utf-8');

        test('ApiClient.kt has aspectRatio parameter defaulting to "1:1"', () => {
            assert.ok(apiClientKt.includes('fun generate(prompt: String, aspectRatio: String = "1:1")'));
            assert.ok(apiClientKt.includes('fun photoToDepth(file: File, aspectRatio: String = "1:1")'));
            assert.ok(apiClientKt.includes('put("aspectRatio", aspectRatio)'));
            assert.ok(apiClientKt.includes('mapOf("aspectRatio" to aspectRatio)'));
        });

        test('MainActivity.kt exposes AspectRatioSelector and connects it to ApiClient', () => {
            assert.ok(mainActivityKt.includes('fun AspectRatioSelector'));
            assert.ok(mainActivityKt.includes('selectedAspectRatio'));
            assert.ok(mainActivityKt.includes('ApiClient.generate(promptInput, selectedAspectRatio)'));
            assert.ok(mainActivityKt.includes('ApiClient.photoToDepth(tempFile, selectedAspectRatio)'));
            for (const ratio of ['1:1', '4:3', '3:2', '16:9', '2:3']) {
                assert.ok(mainActivityKt.includes(`"${ratio}"`));
            }
        });
    });
});
