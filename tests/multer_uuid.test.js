import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { authenticatedFetch as fetch } from './authenticated-fetch.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

process.env.NODE_ENV = 'test';
process.env.GEMINI_API_KEY = 'test_key';

const { app, ai, uploadStorage } = await import('../server.js');

describe('Multer UUID Filenames with Extension (Feature F16) - Tests', () => {
    const uploadsDir = path.join(rootDir, 'static', 'uploads');

    describe('1. uploadStorage filename generator unit tests', () => {
        test('generates filename with upload_ prefix, uuid, and preserved extension', (t, done) => {
            uploadStorage.getFilename({}, { originalname: 'portrait_sample.PNG' }, (err, filename) => {
                assert.ifError(err);
                assert.match(filename, /^upload_[a-f0-9-]{12}\.png$/);
                assert.equal(path.extname(filename), '.png');
                done();
            });
        });

        test('preserves .jpeg and .webp extensions accurately', (t, done) => {
            uploadStorage.getFilename({}, { originalname: 'cat.JPEG' }, (err, filename) => {
                assert.ifError(err);
                assert.equal(path.extname(filename), '.jpeg');
                assert.match(filename, /^upload_[a-f0-9-]{12}\.jpeg$/);

                uploadStorage.getFilename({}, { originalname: 'scenery.webp' }, (err2, filename2) => {
                    assert.ifError(err2);
                    assert.equal(path.extname(filename2), '.webp');
                    assert.match(filename2, /^upload_[a-f0-9-]{12}\.webp$/);
                    done();
                });
            });
        });

        test('falls back to .jpg for missing extension or invalid extension characters', (t, done) => {
            uploadStorage.getFilename({}, { originalname: 'no_extension' }, (err, filename) => {
                assert.ifError(err);
                assert.equal(path.extname(filename), '.jpg');

                uploadStorage.getFilename({}, { originalname: 'bad_ext.exe$#' }, (err2, filename2) => {
                    assert.ifError(err2);
                    assert.equal(path.extname(filename2), '.jpg');
                    done();
                });
            });
        });

        test('sets destination correctly to static/uploads', (t, done) => {
            uploadStorage.getDestination({}, {}, (err, dest) => {
                assert.ifError(err);
                assert.equal(path.resolve(dest), path.resolve(uploadsDir));
                done();
            });
        });
    });

    describe('2. POST /api/photo-to-depth integration tests with file creation & cleanup', () => {
        let originalGenerateContent;
        let originalGenerateImages;
        let capturedUploadedPath = null;

        beforeEach(() => {
            capturedUploadedPath = null;
            originalGenerateContent = ai.models.generateContent;
            originalGenerateImages = ai.models.generateImages;

            ai.models.generateContent = async (params) => {
                return {
                    text: JSON.stringify({
                        depth_prompt: 'sculpted rose relief',
                        subject_description: 'rose flower'
                    })
                };
            };

            ai.models.generateImages = async () => {
                return {
                    generatedImages: [
                        { image: { imageBytes: Buffer.from('mock_depth_png').toString('base64') } }
                    ]
                };
            };
        });

        afterEach(() => {
            ai.models.generateContent = originalGenerateContent;
            ai.models.generateImages = originalGenerateImages;
        });

        test('creates upload file with UUID and extension in static/uploads and unlinks after success', async () => {
            const server = app.listen(0);
            const port = server.address().port;

            let uploadedFileSeen = null;
            const originalReadFile = fs.promises.readFile;
            fs.promises.readFile = async (filePath, ...args) => {
                if (typeof filePath === 'string' && filePath.includes('static') && filePath.includes('uploads')) {
                    uploadedFileSeen = filePath;
                }
                return originalReadFile(filePath, ...args);
            };

            try {
                const formData = new FormData();
                formData.append('photo', new Blob([Buffer.from('test_image_bytes')], { type: 'image/png' }), 'custom_flower.PNG');
                formData.append('aspectRatio', '1:1');

                const response = await fetch(`http://127.0.0.1:${port}/api/photo-to-depth`, {
                    method: 'POST',
                    body: formData
                });

                assert.equal(response.status, 200);
                const data = await response.json();
                assert.equal(data.status, 'success');
                assert.ok(data.image_url);

                // Verify file name format: upload_<uuid>.png
                assert.ok(uploadedFileSeen, 'A file should have been written to uploadsDir');
                const baseName = path.basename(uploadedFileSeen);
                assert.match(baseName, /^upload_[a-f0-9-]{12}\.png$/i);
                assert.equal(path.extname(baseName).toLowerCase(), '.png');

                // Verify cleanup (file should be deleted after processing)
                assert.equal(fs.existsSync(uploadedFileSeen), false, 'Uploaded file should be unlinked after processing');
            } finally {
                fs.promises.readFile = originalReadFile;
                server.close();
            }
        });
    });
});
