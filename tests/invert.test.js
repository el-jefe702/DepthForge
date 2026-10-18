import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { authenticatedFetch as fetch } from './authenticated-fetch.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// Set NODE_ENV to test to avoid starting listening server
process.env.NODE_ENV = 'test';
process.env.GEMINI_API_KEY = 'test_key';

const { app } = await import('../server.js');

const resolvePythonExecutable = () => {
    const candidates = [
        process.env.PYTHON_EXEC,
        path.join(rootDir, '.venv', 'Scripts', 'python.exe'),
        path.join(rootDir, '.venv', 'bin', 'python'),
        path.join(rootDir, '.venv', 'Scripts', 'python')
    ];
    for (const candidate of candidates) {
        if (candidate && fs.existsSync(candidate)) return candidate;
    }
    return process.env.PYTHON_EXEC || (process.platform === 'win32' ? 'python.exe' : 'python');
};

describe('Invert Depth Map Feature (F2) - Unit & Integration Tests', () => {

    describe('1. Python OpenCV Pipeline (processor.py invert)', () => {
        const pythonExec = resolvePythonExecutable();
        const testDir = path.join(rootDir, 'static', 'generated');

        test('inverts 8-bit grayscale image (255 - pixel)', () => {
            const script = `
import cv2, numpy as np, sys, os
in_path = sys.argv[1]
out_path = sys.argv[2]
img = np.array([[0, 64, 128, 255]], dtype=np.uint8)
cv2.imwrite(in_path, img)
`;
            const inPath = path.join(testDir, 'test_in_8bit.png');
            const outPath = path.join(testDir, 'test_out_8bit.png');

            try {
                // Create input test image
                const createRes = spawnSync(pythonExec, ['-c', script, inPath, outPath], { encoding: 'utf-8' });
                assert.equal(createRes.status, 0, createRes.stderr);

                // Run processor.py invert
                const procRes = spawnSync(pythonExec, [path.join(rootDir, 'processor.py'), 'invert', inPath, outPath], {
                    cwd: rootDir,
                    encoding: 'utf-8'
                });
                assert.equal(procRes.status, 0, procRes.stderr);
                assert.ok(fs.existsSync(outPath));

                // Verify inverted pixel values using python
                const verifyScript = `
import cv2, numpy as np, sys
res = cv2.imread(sys.argv[1], cv2.IMREAD_UNCHANGED)
assert res.dtype == np.uint8, f"Expected uint8, got {res.dtype}"
expected = np.array([[255, 191, 127, 0]], dtype=np.uint8)
assert np.array_equal(res, expected), f"Mismatch: {res} vs {expected}"
print("OK")
`;
                const verifyRes = spawnSync(pythonExec, ['-c', verifyScript, outPath], { encoding: 'utf-8' });
                assert.equal(verifyRes.status, 0, verifyRes.stderr);
                assert.ok(verifyRes.stdout.includes('OK'));
            } finally {
                if (fs.existsSync(inPath)) fs.unlinkSync(inPath);
                if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
            }
        });

        test('inverts 16-bit depth map (65535 - pixel)', () => {
            const script = `
import cv2, numpy as np, sys
in_path = sys.argv[1]
img = np.array([[0, 10000, 32768, 65535]], dtype=np.uint16)
cv2.imwrite(in_path, img, [cv2.IMWRITE_PNG_COMPRESSION, 9])
`;
            const inPath = path.join(testDir, 'test_in_16bit.png');
            const outPath = path.join(testDir, 'test_out_16bit.png');

            try {
                // Create input 16-bit test image
                const createRes = spawnSync(pythonExec, ['-c', script, inPath], { encoding: 'utf-8' });
                assert.equal(createRes.status, 0, createRes.stderr);

                // Run processor.py invert
                const procRes = spawnSync(pythonExec, [path.join(rootDir, 'processor.py'), 'invert', inPath, outPath], {
                    cwd: rootDir,
                    encoding: 'utf-8'
                });
                assert.equal(procRes.status, 0, procRes.stderr);
                assert.ok(fs.existsSync(outPath));

                // Verify 16-bit inverted pixel values
                const verifyScript = `
import cv2, numpy as np, sys
res = cv2.imread(sys.argv[1], cv2.IMREAD_UNCHANGED)
assert res.dtype == np.uint16, f"Expected uint16, got {res.dtype}"
expected = np.array([[65535, 55535, 32767, 0]], dtype=np.uint16)
assert np.array_equal(res, expected), f"Mismatch: {res} vs {expected}"
print("OK")
`;
                const verifyRes = spawnSync(pythonExec, ['-c', verifyScript, outPath], { encoding: 'utf-8' });
                assert.equal(verifyRes.status, 0, verifyRes.stderr);
                assert.ok(verifyRes.stdout.includes('OK'));
            } finally {
                if (fs.existsSync(inPath)) fs.unlinkSync(inPath);
                if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
            }
        });

        test('inverts 16-bit 4-channel (RGBA) preserving alpha channel', () => {
            const inPath = path.join(testDir, 'test_in_16bit_rgba.png');
            const outPath = path.join(testDir, 'test_out_16bit_rgba.png');

            try {
                const createScript = `
import cv2, numpy as np, sys
img = np.zeros((2, 2, 4), dtype=np.uint16)
img[:, :, 0] = 10000
img[:, :, 1] = 20000
img[:, :, 2] = 30000
img[:, :, 3] = 65535 # fully opaque alpha
cv2.imwrite(sys.argv[1], img)
`;
                const createRes = spawnSync(pythonExec, ['-c', createScript, inPath], { encoding: 'utf-8' });
                assert.equal(createRes.status, 0, createRes.stderr);

                const procRes = spawnSync(pythonExec, [path.join(rootDir, 'processor.py'), 'invert', inPath, outPath], {
                    cwd: rootDir,
                    encoding: 'utf-8'
                });
                assert.equal(procRes.status, 0, procRes.stderr);
                assert.ok(fs.existsSync(outPath));

                const verifyScript = `
import cv2, numpy as np, sys
res = cv2.imread(sys.argv[1], cv2.IMREAD_UNCHANGED)
assert res.dtype == np.uint16, f"Expected uint16, got {res.dtype}"
assert res.shape == (2, 2, 4), f"Expected shape (2,2,4), got {res.shape}"
# Verify alpha is preserved at 65535
assert np.all(res[:, :, 3] == 65535), f"Alpha corrupted: {res[:, :, 3]}"
# Verify RGB channels are inverted (65535 - val)
assert np.all(res[:, :, 0] == 55535)
assert np.all(res[:, :, 1] == 45535)
assert np.all(res[:, :, 2] == 35535)
print("OK")
`;
                const verifyRes = spawnSync(pythonExec, ['-c', verifyScript, outPath], { encoding: 'utf-8' });
                assert.equal(verifyRes.status, 0, verifyRes.stderr);
                assert.ok(verifyRes.stdout.includes('OK'));
            } finally {
                if (fs.existsSync(inPath)) fs.unlinkSync(inPath);
                if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
            }
        });

        test('inverts 8-bit 4-channel (RGBA) preserving alpha channel', () => {
            const inPath = path.join(testDir, 'test_in_8bit_rgba.png');
            const outPath = path.join(testDir, 'test_out_8bit_rgba.png');

            try {
                const createScript = `
import cv2, numpy as np, sys
img = np.zeros((2, 2, 4), dtype=np.uint8)
img[:, :, 0] = 50
img[:, :, 1] = 100
img[:, :, 2] = 150
img[:, :, 3] = 255 # fully opaque alpha
cv2.imwrite(sys.argv[1], img)
`;
                const createRes = spawnSync(pythonExec, ['-c', createScript, inPath], { encoding: 'utf-8' });
                assert.equal(createRes.status, 0, createRes.stderr);

                const procRes = spawnSync(pythonExec, [path.join(rootDir, 'processor.py'), 'invert', inPath, outPath], {
                    cwd: rootDir,
                    encoding: 'utf-8'
                });
                assert.equal(procRes.status, 0, procRes.stderr);
                assert.ok(fs.existsSync(outPath));

                const verifyScript = `
import cv2, numpy as np, sys
res = cv2.imread(sys.argv[1], cv2.IMREAD_UNCHANGED)
assert res.dtype == np.uint8, f"Expected uint8, got {res.dtype}"
assert res.shape == (2, 2, 4), f"Expected shape (2,2,4), got {res.shape}"
assert np.all(res[:, :, 3] == 255), f"Alpha corrupted: {res[:, :, 3]}"
assert np.all(res[:, :, 0] == 205)
assert np.all(res[:, :, 1] == 155)
assert np.all(res[:, :, 2] == 105)
print("OK")
`;
                const verifyRes = spawnSync(pythonExec, ['-c', verifyScript, outPath], { encoding: 'utf-8' });
                assert.equal(verifyRes.status, 0, verifyRes.stderr);
                assert.ok(verifyRes.stdout.includes('OK'));
            } finally {
                if (fs.existsSync(inPath)) fs.unlinkSync(inPath);
                if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
            }
        });

        test('inverts 8-bit 3-channel (BGR) image across all channels', () => {
            const inPath = path.join(testDir, 'test_in_8bit_3ch.png');
            const outPath = path.join(testDir, 'test_out_8bit_3ch.png');

            try {
                const createScript = `
import cv2, numpy as np, sys
img = np.zeros((2, 2, 3), dtype=np.uint8)
img[:, :, 0] = 50
img[:, :, 1] = 100
img[:, :, 2] = 150
cv2.imwrite(sys.argv[1], img)
`;
                const createRes = spawnSync(pythonExec, ['-c', createScript, inPath], { encoding: 'utf-8' });
                assert.equal(createRes.status, 0, createRes.stderr);

                const procRes = spawnSync(pythonExec, [path.join(rootDir, 'processor.py'), 'invert', inPath, outPath], {
                    cwd: rootDir,
                    encoding: 'utf-8'
                });
                assert.equal(procRes.status, 0, procRes.stderr);
                assert.ok(fs.existsSync(outPath));

                const verifyScript = `
import cv2, numpy as np, sys
res = cv2.imread(sys.argv[1], cv2.IMREAD_UNCHANGED)
assert res.dtype == np.uint8, f"Expected uint8, got {res.dtype}"
assert res.shape == (2, 2, 3), f"Expected shape (2,2,3), got {res.shape}"
assert np.all(res[:, :, 0] == 205)
assert np.all(res[:, :, 1] == 155)
assert np.all(res[:, :, 2] == 105)
print("OK")
`;
                const verifyRes = spawnSync(pythonExec, ['-c', verifyScript, outPath], { encoding: 'utf-8' });
                assert.equal(verifyRes.status, 0, verifyRes.stderr);
                assert.ok(verifyRes.stdout.includes('OK'));
            } finally {
                if (fs.existsSync(inPath)) fs.unlinkSync(inPath);
                if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
            }
        });

        test('inverts 16-bit 3-channel (BGR) image across all channels', () => {
            const inPath = path.join(testDir, 'test_in_16bit_3ch.png');
            const outPath = path.join(testDir, 'test_out_16bit_3ch.png');

            try {
                const createScript = `
import cv2, numpy as np, sys
img = np.zeros((2, 2, 3), dtype=np.uint16)
img[:, :, 0] = 10000
img[:, :, 1] = 20000
img[:, :, 2] = 30000
cv2.imwrite(sys.argv[1], img)
`;
                const createRes = spawnSync(pythonExec, ['-c', createScript, inPath], { encoding: 'utf-8' });
                assert.equal(createRes.status, 0, createRes.stderr);

                const procRes = spawnSync(pythonExec, [path.join(rootDir, 'processor.py'), 'invert', inPath, outPath], {
                    cwd: rootDir,
                    encoding: 'utf-8'
                });
                assert.equal(procRes.status, 0, procRes.stderr);
                assert.ok(fs.existsSync(outPath));

                const verifyScript = `
import cv2, numpy as np, sys
res = cv2.imread(sys.argv[1], cv2.IMREAD_UNCHANGED)
assert res.dtype == np.uint16, f"Expected uint16, got {res.dtype}"
assert res.shape == (2, 2, 3), f"Expected shape (2,2,3), got {res.shape}"
assert np.all(res[:, :, 0] == 55535)
assert np.all(res[:, :, 1] == 45535)
assert np.all(res[:, :, 2] == 35535)
print("OK")
`;
                const verifyRes = spawnSync(pythonExec, ['-c', verifyScript, outPath], { encoding: 'utf-8' });
                assert.equal(verifyRes.status, 0, verifyRes.stderr);
                assert.ok(verifyRes.stdout.includes('OK'));
            } finally {
                if (fs.existsSync(inPath)) fs.unlinkSync(inPath);
                if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
            }
        });

        test('double invert produces exact identical 16-bit values (identity contract)', () => {
            const inPath = path.join(testDir, 'test_in_roundtrip.png');
            const inv1Path = path.join(testDir, 'test_inv1_roundtrip.png');
            const inv2Path = path.join(testDir, 'test_inv2_roundtrip.png');

            try {
                const createScript = `
import cv2, numpy as np, sys
img = np.array([[0, 1, 1000, 32767, 32768, 65534, 65535]], dtype=np.uint16)
cv2.imwrite(sys.argv[1], img, [cv2.IMWRITE_PNG_COMPRESSION, 9])
`;
                const createRes = spawnSync(pythonExec, ['-c', createScript, inPath], { encoding: 'utf-8' });
                assert.equal(createRes.status, 0, createRes.stderr);

                // First invert
                const res1 = spawnSync(pythonExec, [path.join(rootDir, 'processor.py'), 'invert', inPath, inv1Path], { cwd: rootDir, encoding: 'utf-8' });
                assert.equal(res1.status, 0, res1.stderr);

                // Second invert
                const res2 = spawnSync(pythonExec, [path.join(rootDir, 'processor.py'), 'invert', inv1Path, inv2Path], { cwd: rootDir, encoding: 'utf-8' });
                assert.equal(res2.status, 0, res2.stderr);

                const verifyScript = `
import cv2, numpy as np, sys
orig = cv2.imread(sys.argv[1], cv2.IMREAD_UNCHANGED)
double_inv = cv2.imread(sys.argv[2], cv2.IMREAD_UNCHANGED)
assert np.array_equal(orig, double_inv), f"Roundtrip identity failed: {orig} vs {double_inv}"
print("OK")
`;
                const verifyRes = spawnSync(pythonExec, ['-c', verifyScript, inPath, inv2Path], { encoding: 'utf-8' });
                assert.equal(verifyRes.status, 0, verifyRes.stderr);
                assert.ok(verifyRes.stdout.includes('OK'));
            } finally {
                if (fs.existsSync(inPath)) fs.unlinkSync(inPath);
                if (fs.existsSync(inv1Path)) fs.unlinkSync(inv1Path);
                if (fs.existsSync(inv2Path)) fs.unlinkSync(inv2Path);
            }
        });

        test('chained pipeline: invert -> smooth -> invert preserves 16-bit depth fidelity', () => {
            const inPath = path.join(testDir, 'test_chain_in.png');
            const inv1Path = path.join(testDir, 'test_chain_inv1.png');
            const smoothPath = path.join(testDir, 'test_chain_smooth.png');
            const inv2Path = path.join(testDir, 'test_chain_inv2.png');

            try {
                const createScript = `
import cv2, numpy as np, sys
# Create 16-bit depth gradient
img = np.linspace(0, 65535, 100, dtype=np.uint16).reshape((10, 10))
cv2.imwrite(sys.argv[1], img, [cv2.IMWRITE_PNG_COMPRESSION, 9])
`;
                const createRes = spawnSync(pythonExec, ['-c', createScript, inPath], { encoding: 'utf-8' });
                assert.equal(createRes.status, 0, createRes.stderr);

                // Step 1: invert
                const r1 = spawnSync(pythonExec, [path.join(rootDir, 'processor.py'), 'invert', inPath, inv1Path], { cwd: rootDir, encoding: 'utf-8' });
                assert.equal(r1.status, 0, r1.stderr);

                // Step 2: smooth (polish)
                const r2 = spawnSync(pythonExec, [path.join(rootDir, 'processor.py'), 'smooth', inv1Path, smoothPath], { cwd: rootDir, encoding: 'utf-8' });
                assert.equal(r2.status, 0, r2.stderr);

                // Step 3: invert again
                const r3 = spawnSync(pythonExec, [path.join(rootDir, 'processor.py'), 'invert', smoothPath, inv2Path], { cwd: rootDir, encoding: 'utf-8' });
                assert.equal(r3.status, 0, r3.stderr);

                // Verify output is full 16-bit depth with high range
                const verifyScript = `
import cv2, numpy as np, sys
res = cv2.imread(sys.argv[1], cv2.IMREAD_UNCHANGED)
assert res.dtype == np.uint16, f"Expected uint16, got {res.dtype}"
min_val, max_val, _, _ = cv2.minMaxLoc(res)
assert max_val > 60000, f"Expected high 16-bit max, got {max_val}"
print("OK")
`;
                const verifyRes = spawnSync(pythonExec, ['-c', verifyScript, inv2Path], { encoding: 'utf-8' });
                assert.equal(verifyRes.status, 0, verifyRes.stderr);
                assert.ok(verifyRes.stdout.includes('OK'));
            } finally {
                if (fs.existsSync(inPath)) fs.unlinkSync(inPath);
                if (fs.existsSync(inv1Path)) fs.unlinkSync(inv1Path);
                if (fs.existsSync(smoothPath)) fs.unlinkSync(smoothPath);
                if (fs.existsSync(inv2Path)) fs.unlinkSync(inv2Path);
            }
        });
    });

    describe('2. Express Server Endpoint /api/invert', () => {
        const testDir = path.join(rootDir, 'static', 'generated');

        test('returns 400 when image_url is missing', async () => {
            const server = app.listen(0);
            const port = server.address().port;

            try {
                const response = await fetch(`http://127.0.0.1:${port}/api/invert`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({})
                });

                assert.equal(response.status, 400);
                const data = await response.json();
                assert.equal(data.error, 'Missing image_url.');
            } finally {
                server.close();
            }
        });

        test('returns 404 when image is not found on server', async () => {
            const server = app.listen(0);
            const port = server.address().port;

            try {
                const response = await fetch(`http://127.0.0.1:${port}/api/invert`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ image_url: '/static/generated/nonexistent_image_123.png' })
                });

                assert.equal(response.status, 404);
                const data = await response.json();
                assert.equal(data.error, 'Image not found on server.');
            } finally {
                server.close();
            }
        });

        test('successfully inverts existing image and returns new image_url', async () => {
            const server = app.listen(0);
            const port = server.address().port;

            const testFile = 'unit_test_invert_sample.png';
            const testFilePath = path.join(testDir, testFile);
            const expectedOutputFile = `inv_${testFile}`;
            const expectedOutputPath = path.join(testDir, expectedOutputFile);

            // Create a mock image file
            const pythonExec = resolvePythonExecutable();
            const createRes = spawnSync(pythonExec, ['-c', `
import cv2, numpy as np, sys
img = np.array([[0, 255], [128, 64]], dtype=np.uint8)
cv2.imwrite(sys.argv[1], img)
`, testFilePath]);
            assert.equal(createRes.status, 0);

            try {
                const response = await fetch(`http://127.0.0.1:${port}/api/invert`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ image_url: `/static/generated/${testFile}` })
                });

                assert.equal(response.status, 200);
                const data = await response.json();
                assert.equal(data.status, 'success');
                assert.equal(data.image_url, `/static/generated/${expectedOutputFile}`);
                assert.ok(fs.existsSync(expectedOutputPath));
            } finally {
                server.close();
                if (fs.existsSync(testFilePath)) fs.unlinkSync(testFilePath);
                if (fs.existsSync(expectedOutputPath)) fs.unlinkSync(expectedOutputPath);
            }
        });

        test('returns 400 when image_url is blank or null', async () => {
            const server = app.listen(0);
            const port = server.address().port;

            try {
                const response = await fetch(`http://127.0.0.1:${port}/api/invert`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ image_url: '   ' })
                });

                assert.equal(response.status, 400);
                const data = await response.json();
                assert.equal(data.error, 'Missing image_url.');
            } finally {
                server.close();
            }
        });

        test('prevents path traversal outside generated directory (returns 404)', async () => {
            const server = app.listen(0);
            const port = server.address().port;

            try {
                const response = await fetch(`http://127.0.0.1:${port}/api/invert`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ image_url: '../../package.json' })
                });

                // Path basename resolves to package.json inside static/generated/ which doesn't exist
                assert.equal(response.status, 404);
            } finally {
                server.close();
            }
        });

        test('returns 400 when image_url has non-string or invalid data types', async () => {
            const server = app.listen(0);
            const port = server.address().port;

            try {
                for (const invalidPayload of [
                    { image_url: 12345 },
                    { image_url: true },
                    { image_url: null },
                    { image_url: ['/static/generated/test.png'] },
                    { image_url: { file: 'test.png' } }
                ]) {
                    const response = await fetch(`http://127.0.0.1:${port}/api/invert`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(invalidPayload)
                    });
                    assert.equal(response.status, 400);
                    const data = await response.json();
                    assert.equal(data.error, 'Missing image_url.');
                }
            } finally {
                server.close();
            }
        });

        test('gracefully falls back to original image url when python processor fails on corrupt file', async () => {
            const server = app.listen(0);
            const port = server.address().port;

            const corruptFile = 'corrupt_test_file.png';
            const corruptFilePath = path.join(testDir, corruptFile);
            // Write a corrupt 0-byte non-image file
            fs.writeFileSync(corruptFilePath, Buffer.from('NOT_AN_IMAGE_DATA'));

            try {
                const response = await fetch(`http://127.0.0.1:${port}/api/invert`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ image_url: `/static/generated/${corruptFile}` })
                });

                assert.equal(response.status, 200);
                const data = await response.json();
                assert.equal(data.status, 'success');
                assert.equal(data.image_url, `/static/generated/${corruptFile}`);
            } finally {
                server.close();
                if (fs.existsSync(corruptFilePath)) fs.unlinkSync(corruptFilePath);
            }
        });
    });

    describe('3. Web UI & Android Assets Parity', () => {
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

        test('HTML contains Invert button in the action bar', () => {
            assert.ok(webHtml.includes('id="invertBtn"'));
            assert.ok(webHtml.includes('onclick="invertDepthMap()"'));
            assert.ok(webHtml.includes('Invert'));
        });

        test('HTML JS defines invertDepthMap and calls /api/invert', () => {
            assert.ok(webHtml.includes('async function invertDepthMap()'));
            assert.ok(webHtml.includes("fetch('/api/invert'"));
            assert.ok(webHtml.includes('body: JSON.stringify({ image_url: currentImageUrl })'));
        });

        test('displayImageSuccess enables and shows Invert button', () => {
            assert.ok(webHtml.includes("document.getElementById('invertBtn').disabled = false"));
            assert.ok(webHtml.includes("document.getElementById('invertBtn').style.display = 'inline-flex'"));
        });
    });

    describe('4. Android Native UI & Client Integration', () => {
        const apiClientKt = fs.readFileSync(path.join(rootDir, 'android_app', 'app', 'src', 'main', 'kotlin', 'com', 'depthforge', 'app', 'ApiClient.kt'), 'utf-8');
        const mainActivityKt = fs.readFileSync(path.join(rootDir, 'android_app', 'app', 'src', 'main', 'kotlin', 'com', 'depthforge', 'app', 'MainActivity.kt'), 'utf-8');

        test('ApiClient.kt has invert method targeting /api/invert', () => {
            assert.ok(apiClientKt.includes('suspend fun invert(imageUrl: String): JSONObject'));
            assert.ok(apiClientKt.includes('postJson("/api/invert"'));
        });

        test('MainActivity.kt exposes Invert button and connects it to ApiClient.invert', () => {
            assert.ok(mainActivityKt.includes('isInverting'));
            assert.ok(mainActivityKt.includes('ApiClient.invert(currentImageUrl)'));
            assert.ok(mainActivityKt.includes('OrangeAccent'));
            assert.ok(mainActivityKt.includes('Text(if (isInverting) "Inverting..." else "Invert")'));
        });
    });
});
