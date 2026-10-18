import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIGHTBURN_PRESETS, buildLbrn2Xml, laserQueue } from '../lib/lightburn.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// 1x1 16-bit transparent/grayscale test PNG buffer
const samplePngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const samplePngBuffer = Buffer.from(samplePngBase64, 'base64');

describe('LightBurn API & Integration Suite (SLCreations, LLC © 2026)', () => {
    describe('1. Unit Tests: buildLbrn2Xml & Presets', () => {
        it('exposes calibrated laser material presets', () => {
            assert.ok(LIGHTBURN_PRESETS.hardwood, 'Must include hardwood preset');
            assert.ok(LIGHTBURN_PRESETS.acrylic, 'Must include acrylic preset');
            assert.ok(LIGHTBURN_PRESETS.fiber_slate, 'Must include fiber/slate preset');
            assert.ok(LIGHTBURN_PRESETS.softwood, 'Must include softwood preset');

            assert.equal(LIGHTBURN_PRESETS.hardwood.mode, 'Grayscale');
            assert.ok(LIGHTBURN_PRESETS.hardwood.speed > 0);
            assert.ok(LIGHTBURN_PRESETS.hardwood.maxPower > LIGHTBURN_PRESETS.hardwood.minPower);
        });

        it('generates valid LightBurn 2 XML project structure with embedded depth bitmap', () => {
            const xml = buildLbrn2Xml({
                imageBuffer: samplePngBuffer,
                widthMm: 120,
                heightMm: 80,
                presetKey: 'hardwood',
                jobName: 'Test Relief Carving',
                makerName: 'Jeff Maker',
                notes: 'Walnut deep 3D test'
            });

            assert.match(xml, /<\?xml version="1.0" encoding="UTF-8"\?>/);
            assert.match(xml, /<LightBurnProject/);
            assert.match(xml, /<CutSetting type="Cut">/);
            assert.match(xml, /<mode Value="Grayscale"\/>/);
            assert.match(xml, /<Shape Type="Bitmap">/);
            assert.match(xml, /<Width Value="120"\/>/);
            assert.match(xml, /<Height Value="80"\/>/);
            assert.match(xml, /<Data Format="Base64" Type="PNG">/);
            assert.ok(xml.includes(samplePngBase64), 'Must embed base64 image data');
            assert.match(xml, /Jeff Maker/);
            assert.match(xml, /SLCreations, LLC © 2026/);
        });

        it('in-memory laser queue tracks jobs and status transitions', () => {
            const job = laserQueue.addJob({
                makerName: 'Laser Artisan',
                makerEmail: 'artisan@slcreations.llc',
                prompt: 'Baroque Floral Rosette',
                imageUrl: '/static/generated/test.png',
                lbrn2Url: '/static/generated/test.lbrn2',
                preset: 'acrylic',
                material: 'Acrylic',
                widthMm: 150,
                heightMm: 150
            });

            assert.ok(job.id.startsWith('lbrn_'));
            assert.equal(job.status, 'queued');

            const updated = laserQueue.updateStatus(job.id, 'engraving');
            assert.equal(updated.status, 'engraving');

            const completed = laserQueue.updateStatus(job.id, 'completed');
            assert.equal(completed.status, 'completed');

            const list = laserQueue.listJobs(10);
            assert.ok(list.some(j => j.id === job.id));
        });
    });

    describe('2. Integration Tests: Server Endpoints', () => {
        let server = null;
        let baseUrl = '';
        let skipped = false;
        const testImgFilename = 'test_lightburn_src.png';
        const testImgPath = path.join(rootDir, 'static', 'generated', testImgFilename);

        before(async () => {
            // Write a dummy test image to static/generated/
            fs.mkdirSync(path.join(rootDir, 'static', 'generated'), { recursive: true });
            fs.writeFileSync(testImgPath, samplePngBuffer);

            process.env.NODE_ENV = 'test';
            process.env.JWT_SECRET = 'test-lightburn-secret-key';
            process.env.RATE_LIMIT_MAX = '1000';

            try {
                const { app } = await import('../server.js');
                await new Promise((resolve) => {
                    server = app.listen(0, '127.0.0.1', () => {
                        const addr = server.address();
                        baseUrl = `http://127.0.0.1:${addr.port}`;
                        resolve();
                    });
                });
            } catch (err) {
                if (err.code === 'ERR_MODULE_NOT_FOUND') {
                    skipped = true;
                    return;
                }
                throw err;
            }
        });

        after(async () => {
            try {
                if (fs.existsSync(testImgPath)) fs.unlinkSync(testImgPath);
            } catch {}
            if (server) {
                await new Promise((resolve) => server.close(resolve));
            }
        });

        it('GET /api/laser/lightburn/presets returns 200 and all material presets', async (t) => {
            if (skipped) return t.skip('Dependencies not installed locally');
            const res = await fetch(`${baseUrl}/api/laser/lightburn/presets`);
            assert.equal(res.status, 200);
            const data = await res.json();
            assert.equal(data.status, 'ok');
            assert.ok(data.presets.hardwood);
            assert.ok(data.presets.acrylic);
        });

        it('POST /api/laser/lightburn/export generates a valid .lbrn2 file and returns 201', async (t) => {
            if (skipped) return t.skip('Dependencies not installed locally');
            const res = await fetch(`${baseUrl}/api/laser/lightburn/export`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    image_url: `/static/generated/${testImgFilename}`,
                    preset: 'hardwood',
                    widthMm: 110,
                    heightMm: 95,
                    makerName: 'Studio Craftsman',
                    notes: 'Carved on CNC Fiber Laser'
                })
            });

            assert.equal(res.status, 201);
            const data = await res.json();
            assert.equal(data.status, 'success');
            assert.ok(data.lbrn2_url.startsWith('/static/generated/lightburn_'));
            assert.ok(data.filename.endsWith('.lbrn2'));

            // Verify file exists on disk
            const createdFilePath = path.join(rootDir, 'static', 'generated', data.filename);
            assert.ok(fs.existsSync(createdFilePath), 'Generated .lbrn2 file must exist on disk');
            const fileContent = fs.readFileSync(createdFilePath, 'utf8');
            assert.match(fileContent, /<LightBurnProject/);
            assert.match(fileContent, /Studio Craftsman/);

            // Clean up
            try { fs.unlinkSync(createdFilePath); } catch {}
        });

        it('GET /api/laser/lightburn/export serves XML attachment directly', async (t) => {
            if (skipped) return t.skip('Dependencies not installed locally');
            const res = await fetch(`${baseUrl}/api/laser/lightburn/export?image_url=/static/generated/${testImgFilename}&preset=acrylic&widthMm=80&heightMm=80`);
            assert.equal(res.status, 200);
            assert.match(res.headers.get('content-type'), /xml/i);
            assert.match(res.headers.get('content-disposition'), /attachment.*\.lbrn2/i);
            const xml = await res.text();
            assert.match(xml, /<LightBurnProject/);
            assert.match(xml, /<mode Value="Grayscale"\/>/);
        });

        it('POST /api/laser/lightburn/queue adds job to laser queue and GET lists it', async (t) => {
            if (skipped) return t.skip('Dependencies not installed locally');
            const postRes = await fetch(`${baseUrl}/api/laser/lightburn/queue`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    studentName: 'Alex Student',
                    makerEmail: 'alex@makerspace.edu',
                    prompt: 'Celtic Knot Medallion',
                    image_url: `/static/generated/${testImgFilename}`,
                    preset: 'hardwood',
                    widthMm: 100,
                    heightMm: 100
                })
            });

            assert.equal(postRes.status, 201);
            const postData = await postRes.json();
            assert.equal(postData.status, 'success');
            assert.ok(postData.job.id);
            assert.equal(postData.job.makerName, 'Alex Student');

            const listRes = await fetch(`${baseUrl}/api/laser/lightburn/queue`);
            assert.equal(listRes.status, 200);
            const listData = await listRes.json();
            assert.ok(listData.queue.some(j => j.id === postData.job.id));
        });
    });
});
