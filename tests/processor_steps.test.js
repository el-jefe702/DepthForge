import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

describe('processor.py Step Comments & Order (Feature F17) - Unit Tests', () => {
    const processorPath = path.join(rootDir, 'processor.py');
    const content = fs.readFileSync(processorPath, 'utf8');

    test('processor.py exists and contains step comment banners', () => {
        assert.ok(fs.existsSync(processorPath));
        assert.ok(content.includes('STEP 1: LOAD & CONVERT TO 16-BIT GRAYSCALE'));
        assert.ok(content.includes('STEP 2: CLEAN UP MISSING DATA (INPAINTING)'));
        assert.ok(content.includes('STEP 3: SPATIAL FILTERING (FIX BANDING)'));
        assert.ok(content.includes('STEP 4: NORMALIZE THE DEPTH RANGE'));
        assert.ok(content.includes('STEP 5: EXPORT AS LOSSLESS 16-BIT PNG'));
    });

    test('step comments appear in strictly ascending sequential order 1 -> 2 -> 3 -> 4 -> 5', () => {
        const step1Index = content.indexOf('STEP 1');
        const step2Index = content.indexOf('STEP 2');
        const step3Index = content.indexOf('STEP 3');
        const step4Index = content.indexOf('STEP 4');
        const step5Index = content.indexOf('STEP 5');

        assert.ok(step1Index !== -1, 'STEP 1 must be present');
        assert.ok(step2Index !== -1, 'STEP 2 must be present');
        assert.ok(step3Index !== -1, 'STEP 3 must be present');
        assert.ok(step4Index !== -1, 'STEP 4 must be present');
        assert.ok(step5Index !== -1, 'STEP 5 must be present');

        assert.ok(step1Index < step2Index, 'STEP 1 must precede STEP 2');
        assert.ok(step2Index < step3Index, 'STEP 2 must precede STEP 3');
        assert.ok(step3Index < step4Index, 'STEP 3 must precede STEP 4');
        assert.ok(step4Index < step5Index, 'STEP 4 must precede STEP 5');
    });

    test('print statements match step sequence [STEP 1/5] through [STEP 5/5]', () => {
        const p1 = content.indexOf('[STEP 1/5]');
        const p2 = content.indexOf('[STEP 2/5]');
        const p3 = content.indexOf('[STEP 3/5]');
        const p4 = content.indexOf('[STEP 4/5]');
        const p5 = content.indexOf('[STEP 5/5]');

        assert.ok(p1 < p2 && p2 < p3 && p3 < p4 && p4 < p5, 'Print logs must be ordered 1 to 5');
    });
});
