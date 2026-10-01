import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

describe('Vercel Serverless Deployment - Unit & Contract Tests', () => {
    test('vercel.json exists and contains required serverless configuration', () => {
        const vercelConfigPath = path.join(rootDir, 'vercel.json');
        assert.ok(fs.existsSync(vercelConfigPath), 'vercel.json must exist in root directory');
        const config = JSON.parse(fs.readFileSync(vercelConfigPath, 'utf8'));
        assert.equal(config.version, 2, 'Must specify version 2');
        assert.ok(config.functions && config.functions['api/index.js'], 'Must configure functions for api/index.js');
        assert.ok(config.rewrites && Array.isArray(config.rewrites), 'Must configure rewrites');
        const apiRewrite = config.rewrites.find(r => r.source === '/api/:match*');
        assert.ok(apiRewrite, 'Must rewrite /api/* to /api/index.js');
        assert.equal(apiRewrite.destination, '/api/index.js');
        const rootRewrite = config.rewrites.find(r => r.source === '/');
        assert.ok(rootRewrite, 'Must rewrite / to /static/index.html');
    });

    test('api/index.js exists and exports a valid serverless function handler', async () => {
        const apiIndexPath = path.join(rootDir, 'api', 'index.js');
        assert.ok(fs.existsSync(apiIndexPath), 'api/index.js must exist');
        const module = await import(pathToFileURL(apiIndexPath).href);
        assert.equal(typeof module.default, 'function', 'api/index.js must export a default handler function');
    });

    test('server.js exports isVercel flag and supports VERCEL environment detection', async () => {
        const { isVercel } = await import('../server.js');
        assert.equal(typeof isVercel, 'boolean', 'isVercel must be a boolean');
    });
});
