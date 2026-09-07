import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

describe('Batch Generation (F13) - Unit & Integration Tests', () => {

    const webHtml = fs.readFileSync(path.join(rootDir, 'static', 'index.html'), 'utf-8');
    const androidHtml = fs.readFileSync(path.join(rootDir, 'android_app', 'app', 'src', 'main', 'assets', 'index.html'), 'utf-8');
    const webCss = fs.readFileSync(path.join(rootDir, 'static', 'style.css'), 'utf-8');
    const androidCss = fs.readFileSync(path.join(rootDir, 'android_app', 'app', 'src', 'main', 'assets', 'style.css'), 'utf-8');
    const androidStaticCss = fs.readFileSync(path.join(rootDir, 'android_app', 'app', 'src', 'main', 'assets', 'static', 'style.css'), 'utf-8');
    const serverJs = fs.readFileSync(path.join(rootDir, 'server.js'), 'utf-8');
    const mainActivity = fs.readFileSync(path.join(rootDir, 'android_app', 'app', 'src', 'main', 'kotlin', 'com', 'depthforge', 'app', 'MainActivity.kt'), 'utf-8');
    const apiClient = fs.readFileSync(path.join(rootDir, 'android_app', 'app', 'src', 'main', 'kotlin', 'com', 'depthforge', 'app', 'ApiClient.kt'), 'utf-8');

    describe('1. Server Batch Implementation in server.js', () => {
        test('POST /api/generate checks req.body.batch flag and passes numberOfImages', () => {
            assert.ok(serverJs.includes('isBatch = req.body.batch === true'), 'server.js must detect req.body.batch');
            assert.ok(serverJs.includes('numberOfImages: numImages'), 'server.js must pass numImages to generateImages config');
            assert.ok(serverJs.includes('images: imageUrls'), 'server.js must return images array in response');
            assert.ok(serverJs.includes('batch: isBatch'), 'server.js must return batch boolean in response');
        });

        test('POST /api/photo-to-depth checks req.body.batch flag and passes numberOfImages', () => {
            const photoEndpoint = serverJs.substring(serverJs.indexOf("app.post('/api/photo-to-depth'"));
            assert.ok(photoEndpoint.includes('isBatch = req.body.batch === true'), 'photo-to-depth must detect batch flag');
            assert.ok(photoEndpoint.includes('numberOfImages: numImages'), 'photo-to-depth must pass numImages to Imagen');
            assert.ok(photoEndpoint.includes('images: imageUrls'), 'photo-to-depth must return images array');
            assert.ok(photoEndpoint.includes('batch: isBatch'), 'photo-to-depth must return batch boolean');
        });
    });

    describe('2. Web UI Elements & Batch Controls in static/index.html', () => {
        test('Generate ×4 button exists in text generation panel', () => {
            assert.ok(webHtml.includes('id="generateBatchBtn"'), 'Must have #generateBatchBtn');
            assert.ok(webHtml.includes('Generate ×4'), 'Must have label Generate ×4');
            assert.ok(webHtml.includes("generateMap(true)"), 'Clicking #generateBatchBtn must call generateMap(true)');
        });

        test('Convert ×4 button exists in photo upload panel', () => {
            assert.ok(webHtml.includes('id="convertBatchBtn"'), 'Must have #convertBatchBtn');
            assert.ok(webHtml.includes('Convert ×4'), 'Must have label Convert ×4');
            assert.ok(webHtml.includes("convertPhoto(true)"), 'Clicking #convertBatchBtn must call convertPhoto(true)');
        });

        test('Batch candidates container and grid elements exist in DOM', () => {
            assert.ok(webHtml.includes('id="batchGridContainer"'), 'Must have #batchGridContainer');
            assert.ok(webHtml.includes('id="batchGrid"'), 'Must have #batchGrid');
            assert.ok(webHtml.includes('id="batchGridCount"'), 'Must have #batchGridCount');
        });

        test('JavaScript manages batch candidates state and candidate selection', () => {
            assert.ok(webHtml.includes('let batchCandidates = []'), 'Must declare batchCandidates array');
            assert.ok(webHtml.includes('function renderBatchCandidates('), 'Must define renderBatchCandidates function');
            assert.ok(webHtml.includes('function selectBatchCandidate('), 'Must define selectBatchCandidate function');
            assert.ok(webHtml.includes('function clearBatchCandidates()'), 'Must define clearBatchCandidates function');
        });

        test('Photo selection enables and disables convertBatchBtn properly', () => {
            assert.ok(webHtml.includes("document.getElementById('convertBatchBtn')"), 'Must reference convertBatchBtn in photo select/clear');
        });
    });

    describe('3. CSS Styles in static/style.css', () => {
        test('Defines batch grid layout with 2 columns', () => {
            assert.ok(webCss.includes('.batch-grid'), 'Must define .batch-grid');
            assert.ok(webCss.includes('grid-template-columns: repeat(2, 1fr)'), 'Must use 2-column repeat grid');
        });

        test('Defines batch tile, selected state, badge, and button styles', () => {
            assert.ok(webCss.includes('.batch-tile'), 'Must define .batch-tile');
            assert.ok(webCss.includes('.batch-tile.selected'), 'Must define .batch-tile.selected');
            assert.ok(webCss.includes('.batch-badge'), 'Must define .batch-badge');
            assert.ok(webCss.includes('.btn-batch'), 'Must define .btn-batch');
        });
    });

    describe('4. Android Native Jetpack Compose App Parity', () => {
        test('ApiClient.kt supports batch parameter in generate and photoToDepth', () => {
            assert.ok(apiClient.includes('batch: Boolean = false'), 'generate must take optional batch parameter');
            assert.ok(apiClient.includes('put("batch", true)'), 'generate must put batch into JSON body');
            assert.ok(apiClient.includes('put("numberOfImages", 4)'), 'generate must set numberOfImages to 4');
            assert.ok(apiClient.includes('params["batch"] = "true"'), 'photoToDepth must set batch param');
            assert.ok(apiClient.includes('params["numberOfImages"] = "4"'), 'photoToDepth must set numberOfImages param');
        });

        test('MainActivity.kt contains batchCandidateUrls state and buttons', () => {
            assert.ok(mainActivity.includes('batchCandidateUrls by remember'), 'Must remember batchCandidateUrls state');
            assert.ok(mainActivity.includes('⚡ Generate ×4'), 'Must render Generate x4 button');
            assert.ok(mainActivity.includes('⚡ Convert ×4'), 'Must render Convert x4 button');
            assert.ok(mainActivity.includes('BatchCandidateGrid('), 'Must render BatchCandidateGrid composable');
        });

        test('BatchCandidateGrid composable defines candidate selection and #N badges', () => {
            assert.ok(mainActivity.includes('fun BatchCandidateGrid('), 'Must define BatchCandidateGrid composable');
            assert.ok(mainActivity.includes('Candidate #$itemIndex'), 'Must have candidate label');
            assert.ok(mainActivity.includes('#$itemIndex'), 'Must show #N badge');
            assert.ok(mainActivity.includes('candidateUrls.chunked(2)'), 'Must chunk into 2 columns');
        });
    });

    describe('5. Web Asset Parity between static/ and Android assets/', () => {
        test('index.html is identical in static/ and android_app assets', () => {
            assert.equal(webHtml, androidHtml, 'static/index.html and android assets index.html must be identical');
        });

        test('style.css is identical in static/ and android_app assets', () => {
            assert.equal(webCss, androidCss, 'static/style.css and android assets style.css must be identical');
            assert.equal(webCss, androidStaticCss, 'static/style.css and android assets static/style.css must be identical');
        });
    });
});
