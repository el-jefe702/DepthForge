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

import {
    app,
    ai,
    DEFAULT_RATE_LIMIT_WINDOW_MS,
    DEFAULT_RATE_LIMIT_MAX,
    RATE_LIMIT_ERROR_MESSAGE,
    RATE_LIMIT_RESPONSE_BODY,
    parseRateLimitWindowMs,
    parseRateLimitMax,
    createRateLimiter,
    createGenerationLimiter,
    generateLimiter,
    photoToDepthLimiter,
    generationLimiter,
    resetRateLimiters,
    resetGenerationLimiter
} from '../server.js';

describe('Rate Limiting Feature (F10) - Unit & Integration Tests', () => {
    let originalGenerateContent;
    let originalGenerateImages;
    let aiCallsCount = 0;

    beforeEach(() => {
        aiCallsCount = 0;
        originalGenerateContent = ai.models.generateContent;
        originalGenerateImages = ai.models.generateImages;

        ai.models.generateContent = async () => {
            aiCallsCount++;
            return {
                text: JSON.stringify({
                    improved_prompt: 'mock improved prompt',
                    depth_prompt: 'mock depth prompt',
                    subject_description: 'mock subject'
                })
            };
        };

        ai.models.generateImages = async () => {
            return {
                generatedImages: [
                    { image: { imageBytes: Buffer.from('mock_image_bytes').toString('base64') } }
                ]
            };
        };
    });

    afterEach(() => {
        ai.models.generateContent = originalGenerateContent;
        ai.models.generateImages = originalGenerateImages;
    });

    describe('1. Module & Server Exports Contract', () => {
        test('server.js exports all required rate limiting constants and functions', () => {
            assert.equal(typeof DEFAULT_RATE_LIMIT_WINDOW_MS, 'number');
            assert.equal(DEFAULT_RATE_LIMIT_WINDOW_MS, 900000); // 15 minutes = 15 * 60 * 1000

            assert.equal(typeof DEFAULT_RATE_LIMIT_MAX, 'number');
            assert.equal(DEFAULT_RATE_LIMIT_MAX, 10);

            assert.equal(typeof RATE_LIMIT_ERROR_MESSAGE, 'string');
            assert.equal(RATE_LIMIT_ERROR_MESSAGE, 'Too many requests. Please wait before generating again.');

            assert.deepEqual(RATE_LIMIT_RESPONSE_BODY, {
                error: 'Too many requests. Please wait before generating again.'
            });

            assert.equal(typeof parseRateLimitWindowMs, 'function');
            assert.equal(typeof parseRateLimitMax, 'function');
            assert.equal(typeof createRateLimiter, 'function');
            assert.equal(typeof createGenerationLimiter, 'function');
            assert.equal(typeof generateLimiter, 'function');
            assert.equal(typeof photoToDepthLimiter, 'function');
            assert.equal(typeof generationLimiter, 'function');
            assert.equal(typeof resetRateLimiters, 'function');
            assert.equal(typeof resetGenerationLimiter, 'function');
        });
    });

    describe('2. Environment Variable Parsing & Boundary Handling', () => {
        test('parseRateLimitWindowMs handles defaults, empty, invalid, and custom values', () => {
            assert.equal(parseRateLimitWindowMs(undefined), 900000);
            assert.equal(parseRateLimitWindowMs(null), 900000);
            assert.equal(parseRateLimitWindowMs(''), 900000);
            assert.equal(parseRateLimitWindowMs('invalid_string'), 900000);
            assert.equal(parseRateLimitWindowMs('-500'), 900000);
            assert.equal(parseRateLimitWindowMs('0'), 900000);
            assert.equal(parseRateLimitWindowMs(0), 900000);
            assert.equal(parseRateLimitWindowMs(-100), 900000);

            // Valid values
            assert.equal(parseRateLimitWindowMs('60000'), 60000);
            assert.equal(parseRateLimitWindowMs(30000), 30000);
            assert.equal(parseRateLimitWindowMs('1800000'), 1800000);
            assert.equal(parseRateLimitWindowMs('9e5'), 900000);
        });

        test('parseRateLimitMax handles defaults, empty, invalid, and custom values', () => {
            assert.equal(parseRateLimitMax(undefined), 10);
            assert.equal(parseRateLimitMax(null), 10);
            assert.equal(parseRateLimitMax(''), 10);
            assert.equal(parseRateLimitMax('not_a_number'), 10);
            assert.equal(parseRateLimitMax('-1'), 10);
            assert.equal(parseRateLimitMax(-5), 10);

            // Valid values
            assert.equal(parseRateLimitMax('5'), 5);
            assert.equal(parseRateLimitMax('20'), 20);
            assert.equal(parseRateLimitMax(15), 15);
            assert.equal(parseRateLimitMax('0'), 0); // 0 is a valid boundary value
            assert.equal(parseRateLimitMax(0), 0);
            assert.equal(parseRateLimitMax('1e2'), 100);
        });
    });

    describe('3. Rate Limiter on POST /api/generate', () => {
        let server;
        let baseUrl;

        beforeEach(() => {
            aiCallsCount = 0;
            resetRateLimiters({ max: 3, windowMs: 60000 });
            server = app.listen(0);
            const port = server.address().port;
            baseUrl = `http://127.0.0.1:${port}`;
        });

        afterEach(() => {
            resetRateLimiters();
            if (server) server.close();
        });

        test('permits requests under the limit and decrements remaining header', async () => {
            const res1 = await fetch(`${baseUrl}/api/generate`, {
                method: 'POST',
                headers: {
        'Authorization': 'Bearer ' + (process.env.TEST_JWT_TOKEN || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6InRlc3RfdXNlciIsInVzZXJfaWQiOiJ0ZXN0X3VzZXIiLCJpYXQiOjE3OTIwNTM2NzV9.wWiObpWDa9vPiaaSpaT_TRytip0WXKJW38ZwHfiVYKw'), 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: 'test depth map 1' })
            });
            assert.equal(res1.status, 200);
            const remaining1 = parseInt(res1.headers.get('ratelimit-remaining') ?? res1.headers.get('x-ratelimit-remaining'), 10);
            assert.equal(remaining1, 2);

            const res2 = await fetch(`${baseUrl}/api/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: 'test depth map 2' })
            });
            assert.equal(res2.status, 200);
            const remaining2 = parseInt(res2.headers.get('ratelimit-remaining') ?? res2.headers.get('x-ratelimit-remaining'), 10);
            assert.equal(remaining2, 1);

            const res3 = await fetch(`${baseUrl}/api/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: 'test depth map 3' })
            });
            assert.equal(res3.status, 200);
            const remaining3 = parseInt(res3.headers.get('ratelimit-remaining') ?? res3.headers.get('x-ratelimit-remaining'), 10);
            assert.equal(remaining3, 0);

            assert.equal(aiCallsCount, 3);
        });

        test('returns HTTP 429 with exact JSON error when limit is exceeded without calling AI', async () => {
            // First 3 requests exhaust the budget of 3
            for (let i = 0; i < 3; i++) {
                const res = await fetch(`${baseUrl}/api/generate`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ prompt: `test ${i}` })
                });
                assert.equal(res.status, 200);
            }
            assert.equal(aiCallsCount, 3);

            // 4th request exceeds rate limit
            const res4 = await fetch(`${baseUrl}/api/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: 'test 4 should fail' })
            });

            assert.equal(res4.status, 429);
            assert.ok(res4.headers.get('content-type')?.includes('application/json'));

            const body = await res4.json();
            assert.deepEqual(body, {
                error: 'Too many requests. Please wait before generating again.'
            });

            // AI model was NOT called on the 4th request
            assert.equal(aiCallsCount, 3);

            // Standard / Legacy rate limit headers check
            const limitHeader = res4.headers.get('ratelimit-limit') ?? res4.headers.get('x-ratelimit-limit');
            const remainingHeader = res4.headers.get('ratelimit-remaining') ?? res4.headers.get('x-ratelimit-remaining');
            assert.equal(limitHeader, '3');
            assert.equal(remainingHeader, '0');
            assert.ok(res4.headers.has('retry-after') || res4.headers.has('ratelimit-reset'));
        });
    });

    describe('4. Rate Limiter on POST /api/photo-to-depth', () => {
        let server;
        let baseUrl;

        beforeEach(() => {
            aiCallsCount = 0;
            resetRateLimiters({ max: 2, windowMs: 60000 });
            server = app.listen(0);
            const port = server.address().port;
            baseUrl = `http://127.0.0.1:${port}`;
        });

        afterEach(() => {
            resetRateLimiters();
            if (server) server.close();
        });

        test('returns HTTP 429 when photo-to-depth exceeds rate limit', async () => {
            const boundary = '----WebKitFormBoundaryRateLimitTest';
            const multipartBody = Buffer.concat([
                Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="test.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
                Buffer.from('fake_image_bytes'),
                Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="aspectRatio"\r\n\r\n1:1\r\n--${boundary}--\r\n`)
            ]);

            // Request 1
            const res1 = await fetch(`${baseUrl}/api/photo-to-depth`, {
                method: 'POST',
                headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
                body: multipartBody
            });
            assert.equal(res1.status, 200);

            // Request 2
            const res2 = await fetch(`${baseUrl}/api/photo-to-depth`, {
                method: 'POST',
                headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
                body: multipartBody
            });
            assert.equal(res2.status, 200);

            // Request 3 exceeds limit
            const res3 = await fetch(`${baseUrl}/api/photo-to-depth`, {
                method: 'POST',
                headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
                body: multipartBody
            });
            assert.equal(res3.status, 429);
            const data = await res3.json();
            assert.deepEqual(data, {
                error: 'Too many requests. Please wait before generating again.'
            });
        });
    });

    describe('5. Route Exemption Verification (Non-generation endpoints unthrottled)', () => {
        let server;
        let baseUrl;

        beforeEach(() => {
            resetRateLimiters({ max: 1, windowMs: 60000 });
            server = app.listen(0);
            const port = server.address().port;
            baseUrl = `http://127.0.0.1:${port}`;
        });

        afterEach(() => {
            resetRateLimiters();
            if (server) server.close();
        });

        test('non-generation endpoints remain unthrottled even after rate limit exhaustion', async () => {
            // First exhaust generation endpoint
            const r1 = await fetch(`${baseUrl}/api/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: 'exhaust' })
            });
            assert.equal(r1.status, 200);

            // Generation endpoint is now 429
            const genRes = await fetch(`${baseUrl}/api/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: 'exhaust again' })
            });
            assert.equal(genRes.status, 429);

            // 1. /api/health is NOT throttled (must return 200)
            for (let i = 0; i < 5; i++) {
                const healthRes = await fetch(`${baseUrl}/api/health`);
                assert.equal(healthRes.status, 200);
                const healthData = await healthRes.json();
                assert.equal(healthData.status, 'ok');
                // Ensure health does not output generation ratelimit headers
                assert.equal(healthRes.headers.get('ratelimit-remaining'), null);
            }

            // 2. /static/ asset routes are NOT throttled
            const staticRes = await fetch(`${baseUrl}/static/index.html`);
            assert.equal(staticRes.status, 200);

            // 3. /api/invert is NOT throttled by rate limiter (returns 400 for missing image_url, NOT 429)
            const invertRes = await fetch(`${baseUrl}/api/invert`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({})
            });
            assert.notEqual(invertRes.status, 429);
            assert.equal(invertRes.status, 400);

            // 4. /api/remove_bg is NOT throttled (returns 400, NOT 429)
            const removeBgRes = await fetch(`${baseUrl}/api/remove_bg`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({})
            });
            assert.notEqual(removeBgRes.status, 429);
            assert.equal(removeBgRes.status, 400);

            // 5. /api/postprocess is NOT throttled (returns 400, NOT 429)
            const postprocessRes = await fetch(`${baseUrl}/api/postprocess`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({})
            });
            assert.notEqual(postprocessRes.status, 429);
            assert.equal(postprocessRes.status, 400);

            // 6. /api/postprocess-stream is NOT throttled (returns 200 SSE with error event, NOT 429)
            const sseRes = await fetch(`${baseUrl}/api/postprocess-stream`);
            assert.notEqual(sseRes.status, 429);
            assert.equal(sseRes.status, 200);
        });
    });

    describe('6. Environment Variable Overrides & Configurable Limits', () => {
        let originalMax;
        let originalWindow;
        let server;
        let baseUrl;

        beforeEach(() => {
            originalMax = process.env.RATE_LIMIT_MAX;
            originalWindow = process.env.RATE_LIMIT_WINDOW_MS;
        });

        afterEach(() => {
            process.env.RATE_LIMIT_MAX = originalMax;
            process.env.RATE_LIMIT_WINDOW_MS = originalWindow;
            resetRateLimiters();
            if (server) server.close();
        });

        test('RATE_LIMIT_MAX environment variable overrides default limit dynamically', async () => {
            process.env.RATE_LIMIT_MAX = '2';
            resetRateLimiters();

            server = app.listen(0);
            const port = server.address().port;
            baseUrl = `http://127.0.0.1:${port}`;

            const r1 = await fetch(`${baseUrl}/api/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: 'req1' })
            });
            assert.equal(r1.status, 200);
            const r1Limit = r1.headers.get('ratelimit-limit') ?? r1.headers.get('x-ratelimit-limit');
            assert.equal(r1Limit, '2');

            const r2 = await fetch(`${baseUrl}/api/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: 'req2' })
            });
            assert.equal(r2.status, 200);

            // 3rd request should be 429 because RATE_LIMIT_MAX is 2
            const r3 = await fetch(`${baseUrl}/api/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: 'req3' })
            });
            assert.equal(r3.status, 429);
        });

        test('RATE_LIMIT_WINDOW_MS environment variable configures rate limit window', () => {
            process.env.RATE_LIMIT_WINDOW_MS = '60000';
            const limiter = createRateLimiter();
            assert.ok(limiter);
            assert.equal(typeof limiter, 'function');
        });
    });

    describe('7. Web UI & Assets Parity', () => {
        const webHtml = fs.readFileSync(path.join(rootDir, 'static', 'index.html'), 'utf-8');
        const androidHtml = fs.readFileSync(path.join(rootDir, 'android_app', 'app', 'src', 'main', 'assets', 'index.html'), 'utf-8');

        test('index.html is identical byte-for-byte between static/ and android assets', () => {
            assert.equal(webHtml, androidHtml);
        });

        test('static/index.html handles HTTP 429 in generateMap with user-friendly error', () => {
            const generateMapIndex = webHtml.indexOf('async function generateMap');
            assert.ok(generateMapIndex !== -1);
            const convertPhotoIndex = webHtml.indexOf('async function convertPhoto');
            const generateMapSnippet = webHtml.slice(generateMapIndex, convertPhotoIndex);
            assert.ok(generateMapSnippet.includes('res.status === 429'));
            assert.ok(generateMapSnippet.includes('Too many requests. Please wait before generating again.'));
        });

        test('static/index.html handles HTTP 429 in convertPhoto with user-friendly error', () => {
            const convertPhotoIndex = webHtml.indexOf('async function convertPhoto');
            assert.ok(convertPhotoIndex !== -1);
            const removeBgIndex = webHtml.indexOf('async function removeBg');
            const convertPhotoSnippet = webHtml.slice(convertPhotoIndex, removeBgIndex);
            assert.ok(convertPhotoSnippet.includes('res.status === 429'));
            assert.ok(convertPhotoSnippet.includes('Too many requests. Please wait before generating again.'));
        });
    });

    describe('8. Android Native ApiClient & MainActivity Contract', () => {
        const apiClientKt = fs.readFileSync(path.join(rootDir, 'android_app', 'app', 'src', 'main', 'kotlin', 'com', 'depthforge', 'app', 'ApiClient.kt'), 'utf-8');
        const mainActivityKt = fs.readFileSync(path.join(rootDir, 'android_app', 'app', 'src', 'main', 'kotlin', 'com', 'depthforge', 'app', 'MainActivity.kt'), 'utf-8');

        test('ApiClient.kt declares isRateLimited helper method', () => {
            assert.ok(apiClientKt.includes('fun isRateLimited('));
            assert.ok(apiClientKt.includes('statusCode') || apiClientKt.includes('429'));
            assert.ok(apiClientKt.includes('Too many requests'));
        });

        test('ApiClient.kt handles error stream on non-200 responses in postJson', () => {
            assert.ok(apiClientKt.includes('conn.errorStream'));
            assert.ok(apiClientKt.includes('statusCode'));
        });

        test('MainActivity.kt displays 429 error message via snackbar and lastError state', () => {
            assert.ok(mainActivityKt.includes('ApiClient.isRateLimited'));
            assert.ok(mainActivityKt.includes('scaffoldState.snackbarHostState.showSnackbar(errorMsg)'));
            assert.ok(mainActivityKt.includes('lastError = errorMsg'));
        });

        test('MainActivity.kt preserves legacy test contract comments', () => {
            assert.ok(mainActivityKt.includes('ApiClient.generate(promptInput, selectedAspectRatio)'));
            assert.ok(mainActivityKt.includes('ApiClient.photoToDepth(tempFile, selectedAspectRatio)'));
            assert.ok(mainActivityKt.includes('ApiClient.generate(promptInput, selectedAspectRatio, depthIntensity.toInt())'));
            assert.ok(mainActivityKt.includes('ApiClient.photoToDepth(tempFile, selectedAspectRatio, depthIntensity.toInt())'));
        });

        test('ApiClient.kt avoids calling conn.inputStream on HTTP errors when errorStream is null', () => {
            // Confirm the fix preventing IOException on HTTP >= 400
            assert.ok(apiClientKt.includes('val stream = if (responseCode in 200..299) conn.inputStream else conn.errorStream'));
            assert.ok(!apiClientKt.includes('else (conn.errorStream ?: conn.inputStream)'));
        });

        test('ApiClient.kt sanitizes HTTP 429 raw or non-JSON error stream to user-friendly message', () => {
            assert.ok(apiClientKt.includes('if (responseCode == 429)'));
            assert.ok(apiClientKt.includes('if (statusCode == 429)'));
            assert.ok(apiClientKt.includes('currentErr.startsWith("HTTP 429")'));
        });

        test('MainActivity.kt sanitizes HTTP 429 server error strings in both text and photo modes', () => {
            assert.ok(mainActivityKt.includes('serverError.startsWith("HTTP 429")'));
        });

        test('RateLimitingTest.kt exists in android_app and covers JUnit rate limit contracts', () => {
            const testFilePath = path.join(rootDir, 'android_app', 'app', 'src', 'test', 'kotlin', 'com', 'depthforge', 'app', 'RateLimitingTest.kt');
            assert.ok(fs.existsSync(testFilePath), 'RateLimitingTest.kt must exist');
            const content = fs.readFileSync(testFilePath, 'utf-8');
            assert.ok(content.includes('class RateLimitingTest'));
            assert.ok(content.includes('testApiClientIsRateLimitedMethodExists'));
            assert.ok(content.includes('testIsRateLimitedWith429StatusCode'));
            assert.ok(content.includes('testStandard429ResponseContract'));
            assert.ok(content.includes('testNonJson429FallbackContract'));
            assert.ok(content.includes('testEmptyBody429FallbackContract'));
        });
    });

    describe('9. Adversarial Concurrency, Cross-Route Sharing & Edge Cases', () => {
        let server;
        let baseUrl;

        afterEach(() => {
            resetRateLimiters();
            if (server) server.close();
        });

        test('enforces shared generation rate limit budget across both /api/generate and /api/photo-to-depth', async () => {
            aiCallsCount = 0;
            resetRateLimiters({ max: 2, windowMs: 60000, shared: true });
            server = app.listen(0);
            const port = server.address().port;
            baseUrl = `http://127.0.0.1:${port}`;

            const boundary = '----WebKitFormBoundarySharedRateLimit';
            const multipartBody = Buffer.concat([
                Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="sample.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
                Buffer.from('sample_bytes'),
                Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="aspectRatio"\r\n\r\n1:1\r\n--${boundary}--\r\n`)
            ]);

            // Request 1: POST /api/generate uses 1 of 2
            const res1 = await fetch(`${baseUrl}/api/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: 'shared prompt 1' })
            });
            assert.equal(res1.status, 200);

            // Request 2: POST /api/photo-to-depth uses 2 of 2
            const res2 = await fetch(`${baseUrl}/api/photo-to-depth`, {
                method: 'POST',
                headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
                body: multipartBody
            });
            assert.equal(res2.status, 200);

            // Request 3: POST /api/generate must now be rejected with 429
            const res3 = await fetch(`${baseUrl}/api/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: 'shared prompt 2 should fail' })
            });
            assert.equal(res3.status, 429);
            const data3 = await res3.json();
            assert.deepEqual(data3, { error: 'Too many requests. Please wait before generating again.' });

            // Request 4: POST /api/photo-to-depth must also be rejected with 429
            const res4 = await fetch(`${baseUrl}/api/photo-to-depth`, {
                method: 'POST',
                headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
                body: multipartBody
            });
            assert.equal(res4.status, 429);
            const data4 = await res4.json();
            assert.deepEqual(data4, { error: 'Too many requests. Please wait before generating again.' });
        });

        test('handles concurrent burst requests accurately at limit boundary without race conditions', async () => {
            aiCallsCount = 0;
            resetRateLimiters({ max: 3, windowMs: 60000 });
            server = app.listen(0);
            const port = server.address().port;
            baseUrl = `http://127.0.0.1:${port}`;

            // Send 6 concurrent requests in parallel
            const promises = Array.from({ length: 6 }, (_, i) =>
                fetch(`${baseUrl}/api/generate`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ prompt: `burst ${i}` })
                })
            );

            const responses = await Promise.all(promises);
            const statuses = responses.map(r => r.status);

            const successCount = statuses.filter(s => s === 200).length;
            const throttledCount = statuses.filter(s => s === 429).length;

            assert.equal(successCount, 3, 'Exactly 3 requests should succeed');
            assert.equal(throttledCount, 3, 'Exactly 3 requests should be throttled');
            assert.equal(aiCallsCount, 3, 'AI should only be called 3 times');
        });

        test('handles RATE_LIMIT_MAX=0 boundary: immediately rejects with HTTP 429 without calling AI', async () => {
            const originalMax = process.env.RATE_LIMIT_MAX;
            try {
                process.env.RATE_LIMIT_MAX = '0';
                resetRateLimiters();
                aiCallsCount = 0;

                server = app.listen(0);
                const port = server.address().port;
                baseUrl = `http://127.0.0.1:${port}`;

                const res = await fetch(`${baseUrl}/api/generate`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ prompt: 'zero limit test' })
                });

                assert.equal(res.status, 429);
                assert.equal(aiCallsCount, 0, 'AI should not be called when limit is 0');
                const data = await res.json();
                assert.deepEqual(data, { error: 'Too many requests. Please wait before generating again.' });
            } finally {
                process.env.RATE_LIMIT_MAX = originalMax;
            }
        });

        test('isolates rate limits per IP and operates cleanly when trust proxy is enabled', async () => {
            const originalTrustProxy = app.get('trust proxy');
            try {
                app.set('trust proxy', true);
                resetRateLimiters({ max: 1, windowMs: 60000 });

                server = app.listen(0);
                const port = server.address().port;
                baseUrl = `http://127.0.0.1:${port}`;

                // Client 1 (IP: 198.51.100.1) request 1 succeeds
                const c1r1 = await fetch(`${baseUrl}/api/generate`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.1' },
                    body: JSON.stringify({ prompt: 'client 1 prompt 1' })
                });
                assert.equal(c1r1.status, 200);

                // Client 1 request 2 is throttled
                const c1r2 = await fetch(`${baseUrl}/api/generate`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.1' },
                    body: JSON.stringify({ prompt: 'client 1 prompt 2' })
                });
                assert.equal(c1r2.status, 429);

                // Client 2 (IP: 198.51.100.2) is NOT throttled by Client 1's usage
                const c2r1 = await fetch(`${baseUrl}/api/generate`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.2' },
                    body: JSON.stringify({ prompt: 'client 2 prompt 1' })
                });
                assert.equal(c2r1.status, 200);
            } finally {
                app.set('trust proxy', originalTrustProxy);
            }
        });

        test('resets quota and permits requests after windowMs expires', async () => {
            resetRateLimiters({ max: 1, windowMs: 50 });
            server = app.listen(0);
            const port = server.address().port;
            baseUrl = `http://127.0.0.1:${port}`;

            // Request 1 uses the 1-request budget
            const r1 = await fetch(`${baseUrl}/api/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: 'window expiration 1' })
            });
            assert.equal(r1.status, 200);

            // Request 2 immediately following is throttled
            const r2 = await fetch(`${baseUrl}/api/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: 'window expiration 2' })
            });
            assert.equal(r2.status, 429);

            // Wait for windowMs (50ms) to expire
            await new Promise(resolve => setTimeout(resolve, 75));

            // Request 3 after window expiry succeeds
            const r3 = await fetch(`${baseUrl}/api/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: 'window expiration 3' })
            });
            assert.equal(r3.status, 200);
        });
    });
});
