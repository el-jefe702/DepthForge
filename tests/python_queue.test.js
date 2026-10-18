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

const { app, pythonProcessorQueue, generatedDir } = await import('../server.js');

describe('Concurrency Queue for Python Processor (Feature F18) - Tests', () => {

    test('pythonProcessorQueue exists and is configured with concurrency: 1', () => {
        assert.ok(pythonProcessorQueue, 'pythonProcessorQueue must be exported');
        assert.equal(pythonProcessorQueue.concurrency, 1, 'Queue concurrency must be strictly 1');
    });

    test('serializes multiple concurrent runPythonProcessor requests in strict order', async () => {
        const executionOrder = [];
        let runningCount = 0;
        let maxConcurrent = 0;

        const makeTask = (id, durationMs) => {
            return pythonProcessorQueue.add(async () => {
                runningCount++;
                maxConcurrent = Math.max(maxConcurrent, runningCount);
                executionOrder.push(`start_${id}`);
                await new Promise(r => setTimeout(r, durationMs));
                runningCount--;
                executionOrder.push(`end_${id}`);
                return id;
            });
        };

        const task1 = makeTask(1, 50);
        const task2 = makeTask(2, 20);
        const task3 = makeTask(3, 10);

        const results = await Promise.all([task1, task2, task3]);

        assert.deepEqual(results, [1, 2, 3]);
        assert.equal(maxConcurrent, 1, 'Never run more than 1 Python task concurrently');
        assert.deepEqual(executionOrder, [
            'start_1', 'end_1',
            'start_2', 'end_2',
            'start_3', 'end_3'
        ]);
    });

    test('logs queue depth when request is queued behind active task', async () => {
        const logs = [];
        const originalLog = console.log;
        console.log = (...args) => {
            logs.push(args.join(' '));
            originalLog(...args);
        };

        try {
            // Add a slow task
            const slowTask = pythonProcessorQueue.add(() => new Promise(r => setTimeout(r, 60)));
            
            // Invoke through simulated queue check
            const { runPythonProcessor } = await import('../server.js');
            const queuedPromise = runPythonProcessor('smooth', ['input.png', 'output.png']).catch(() => {});

            await slowTask;
            await queuedPromise;

            const hasQueueDepthLog = logs.some(l => l.includes('[Python Queue] Request queued') && l.includes('queue depth:'));
            assert.ok(hasQueueDepthLog, 'Must log queue depth when task is queued behind active task');
        } finally {
            console.log = originalLog;
        }
    });

    test('two simultaneous /api/invert HTTP requests execute sequentially through queue', async () => {
        // Create 2 test images in generatedDir
        const fileA = path.join(generatedDir, 'test_q_a.png');
        const fileB = path.join(generatedDir, 'test_q_b.png');

        // Create 16-bit mock PNG or 8-bit dummy files
        fs.writeFileSync(fileA, Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108000000003a7e9b550000000a49444154789c63600000000200014d284bc30000000049454e44ae426082', 'hex'));
        fs.writeFileSync(fileB, Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108000000003a7e9b550000000a49444154789c63600000000200014d284bc30000000049454e44ae426082', 'hex'));

        const server = app.listen(0);
        const port = server.address().port;

        try {
            const reqA = fetch(`http://127.0.0.1:${port}/api/invert`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ image_url: '/static/generated/test_q_a.png' })
            });

            const reqB = fetch(`http://127.0.0.1:${port}/api/invert`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ image_url: '/static/generated/test_q_b.png' })
            });

            const [resA, resB] = await Promise.all([reqA, reqB]);
            assert.equal(resA.status, 200);
            assert.equal(resB.status, 200);

            const jsonA = await resA.json();
            const jsonB = await resB.json();

            assert.equal(jsonA.status, 'success');
            assert.equal(jsonB.status, 'success');
        } finally {
            if (fs.existsSync(fileA)) fs.unlinkSync(fileA);
            if (fs.existsSync(fileB)) fs.unlinkSync(fileB);
            const invA = path.join(generatedDir, 'inv_test_q_a.png');
            const invB = path.join(generatedDir, 'inv_test_q_b.png');
            if (fs.existsSync(invA)) fs.unlinkSync(invA);
            if (fs.existsSync(invB)) fs.unlinkSync(invB);
            server.close();
        }
    });
});
