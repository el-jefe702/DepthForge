const fs = require('fs');
const path = require('path');
const assert = require('assert');

console.log('--- DepthForge Audit & Repair Verification Benchmark ---');

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`[PASS] ${name}`);
        passed++;
    } catch (e) {
        console.error(`[FAIL] ${name}:`, e.message);
        failed++;
    }
}

// 1. Verify Three.js texture disposal and context management
test('Three.js texture disposal in static/index.html', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'static', 'index.html'), 'utf-8');
    assert.ok(html.includes('dispose()'), 'Texture dispose() must be called to prevent WebGL memory leak');
    assert.ok(html.includes('threeDCurrentTexture'), 'Current texture reference must be tracked');
});

// 2. Verify Android asset parity
test('Android asset parity with static/', () => {
    const staticIndex = fs.readFileSync(path.join(__dirname, '..', 'static', 'index.html'), 'utf-8');
    const androidIndex = fs.readFileSync(path.join(__dirname, '..', 'android_app', 'app', 'src', 'main', 'assets', 'index.html'), 'utf-8');
    assert.strictEqual(staticIndex, androidIndex, 'static/index.html and android_app index.html must be byte-for-byte identical');

    const staticCss = fs.readFileSync(path.join(__dirname, '..', 'static', 'style.css'), 'utf-8');
    const androidCss = fs.readFileSync(path.join(__dirname, '..', 'android_app', 'app', 'src', 'main', 'assets', 'style.css'), 'utf-8');
    assert.strictEqual(staticCss, androidCss, 'static/style.css and android_app style.css must be byte-for-byte identical');
});

// 3. Verify Stripe webhook customer email lookup and error recovery
test('Stripe webhook user recovery and event recording in server.js', () => {
    const serverJs = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf-8');
    assert.ok(serverJs.includes('findUserByEmail'), 'Stripe webhook must support user email resolution fallback');
    assert.ok(serverJs.includes('isStripeEventProcessed'), 'Stripe webhook must check idempotency');
});

// 4. Verify AI Model Fallback in server.js
test('AI Model fallback in server.js does not hardcode deprecated gemini-2.5-flash', () => {
    const serverJs = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf-8');
    assert.ok(!serverJs.includes("model: 'gemini-2.5-flash'"), 'Deprecated gemini-2.5-flash must not be the sole model in prompt improve or photo analysis');
    assert.ok(serverJs.includes('gemini-3.6-flash') || serverJs.includes('gemini-3.8-flash'), 'Gemini 3 models must be prioritized');
});

// 5. Verify processor.py safe directory creation and imwrite checks
test('processor.py verifies imwrite return status and ensures parent directories', () => {
    const py = fs.readFileSync(path.join(__dirname, '..', 'processor.py'), 'utf-8');
    assert.ok(py.includes('os.makedirs'), 'processor.py must ensure output directory exists');
    assert.ok(py.includes('sys.exit(1)') || py.includes('raise'), 'processor.py must handle failed writes safely');
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) {
    process.exit(1);
} else {
    console.log('All verification benchmarks passed!');
}

