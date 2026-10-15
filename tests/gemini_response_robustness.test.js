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

const { app, ai, safeJsonParse } = await import('../server.js');

describe('Gemini Response Robustness (Feature F15) - Integration Tests', () => {
    let originalGenerateContent;
    let originalGenerateImages;
    let capturedImagePrompt = null;

    beforeEach(() => {
        capturedImagePrompt = null;
        originalGenerateContent = ai.models.generateContent;
        originalGenerateImages = ai.models.generateImages;

        ai.models.generateImages = async (params) => {
            capturedImagePrompt = params.prompt;
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

    describe('1. safeJsonParse Unit Tests', () => {
        test('parses standard valid JSON without issues', () => {
            const raw = JSON.stringify({ improved_prompt: 'lion relief', depth_prompt: 'smooth lion' });
            const result = safeJsonParse(raw);
            assert.deepEqual(result, { improved_prompt: 'lion relief', depth_prompt: 'smooth lion' });
        });

        test('parses JSON wrapped in markdown code blocks', () => {
            const raw = '```json\n{\n  "improved_prompt": "eagle relief",\n  "subject_description": "majestic eagle"\n}\n```';
            const result = safeJsonParse(raw);
            assert.deepEqual(result, {
                improved_prompt: 'eagle relief',
                subject_description: 'majestic eagle'
            });
        });

        test('falls back safely on malformed JSON without throwing', () => {
            const malformed = '{"improved_prompt": "broken json';
            const fallback = { defaultVal: true };
            const result = safeJsonParse(malformed, fallback, { error: () => {} });
            assert.deepEqual(result, fallback);
        });
    });

    describe('2. POST /api/generate Robustness Under Non-JSON Gemini Responses', () => {
        test('recovers and generates image when Gemini returns markdown code blocks', async () => {
            ai.models.generateContent = async () => ({
                text: '```json\n{"improved_prompt": "ornate dragon medallion"}\n```'
            });

            const server = app.listen(0);
            const port = server.address().port;

            try {
                const response = await fetch(`http://127.0.0.1:${port}/api/generate`, {
                    method: 'POST',
                    headers: {
        'Authorization': 'Bearer ' + (process.env.TEST_JWT_TOKEN || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6InRlc3RfdXNlciIsInVzZXJfaWQiOiJ0ZXN0X3VzZXIiLCJpYXQiOjE3OTIwNTM2NzV9.wWiObpWDa9vPiaaSpaT_TRytip0WXKJW38ZwHfiVYKw'), 'Content-Type': 'application/json' },
                    body: JSON.stringify({ prompt: 'dragon' })
                });

                assert.equal(response.status, 200);
                const data = await response.json();
                assert.equal(data.status, 'success');
                assert.ok(capturedImagePrompt.includes('ornate dragon medallion'));
            } finally {
                server.close();
            }
        });

        test('falls back to user prompt when Gemini returns plain text / non-JSON instead of 500 error', async () => {
            ai.models.generateContent = async () => ({
                text: 'Here is a prompt for you: A magnificent sculpted wolf head in relief.'
            });

            const server = app.listen(0);
            const port = server.address().port;

            try {
                const response = await fetch(`http://127.0.0.1:${port}/api/generate`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ prompt: 'wolf head' })
                });

                assert.equal(response.status, 200, 'Must NOT return HTTP 500 on non-JSON response');
                const data = await response.json();
                assert.equal(data.status, 'success');
                // Prompt must fall back to user's input
                assert.ok(capturedImagePrompt.includes('wolf head'));
            } finally {
                server.close();
            }
        });

        test('falls back to default prompt when Gemini returns empty text or missing keys', async () => {
            ai.models.generateContent = async () => ({
                text: ''
            });

            const server = app.listen(0);
            const port = server.address().port;

            try {
                const response = await fetch(`http://127.0.0.1:${port}/api/generate`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ prompt: 'celtic knot' })
                });

                assert.equal(response.status, 200);
                const data = await response.json();
                assert.equal(data.status, 'success');
                assert.ok(capturedImagePrompt.includes('celtic knot'));
            } finally {
                server.close();
            }
        });
    });

    describe('3. POST /api/photo-to-depth Robustness Under Non-JSON Gemini Responses', () => {
        test('recovers and generates depth map when Gemini Vision returns non-JSON or plain text', async () => {
            ai.models.generateContent = async () => ({
                text: 'I detected a mountain landscape with deep spatial ridges.'
            });

            const server = app.listen(0);
            const port = server.address().port;

            const tempUploadPath = path.join(rootDir, 'tests', 'test_photo_robust.png');
            fs.writeFileSync(tempUploadPath, Buffer.from('fake_image_bytes'));

            try {
                const formData = new FormData();
                formData.append('photo', new Blob([Buffer.from('fake_image_bytes')], { type: 'image/png' }), 'photo.png');
                formData.append('aspectRatio', '1:1');

                const response = await fetch(`http://127.0.0.1:${port}/api/photo-to-depth`, {
                    method: 'POST',
                    body: formData
                });

                assert.equal(response.status, 200, 'Must NOT return HTTP 500 when vision returns plain text');
                const data = await response.json();
                assert.equal(data.status, 'success');
                assert.ok(data.subject);
                assert.ok(capturedImagePrompt.includes('mountain landscape'));
            } finally {
                if (fs.existsSync(tempUploadPath)) fs.unlinkSync(tempUploadPath);
                server.close();
            }
        });
    });
});
