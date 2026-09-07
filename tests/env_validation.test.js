import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateEnvironment } from '../server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

test('validateEnvironment unit tests', async (t) => {
    await t.test('passes when GEMINI_API_KEY is present and non-empty and python is available', () => {
        const errors = [];
        const warnings = [];
        const mockLogger = {
            error: (msg) => errors.push(msg),
            warn: (msg) => warnings.push(msg)
        };

        const result = validateEnvironment(
            { GEMINI_API_KEY: 'test-valid-key-123' },
            {
                exitOnError: false,
                logger: mockLogger,
                isPythonAvailable: () => true
            }
        );

        assert.equal(result.valid, true);
        assert.equal(result.errors.length, 0);
        assert.equal(result.warnings.length, 0);
        assert.equal(errors.length, 0);
        assert.equal(warnings.length, 0);
    });

    await t.test('fails when GEMINI_API_KEY is missing', () => {
        const errors = [];
        const mockLogger = {
            error: (msg) => errors.push(msg),
            warn: () => {}
        };

        const result = validateEnvironment(
            {},
            {
                exitOnError: false,
                logger: mockLogger,
                isPythonAvailable: () => true
            }
        );

        assert.equal(result.valid, false);
        assert.equal(result.errors.length, 1);
        assert.match(result.errors[0], /GEMINI_API_KEY is missing or empty/);
        assert.match(result.errors[0], /https:\/\/aistudio\.google\.com\//);
        assert.ok(errors.some(msg => typeof msg === 'string' && msg.includes('Environment validation failed')));
    });

    await t.test('fails when GEMINI_API_KEY is empty string or only whitespace', () => {
        for (const emptyKey of ['', '   ', '\t\n']) {
            const result = validateEnvironment(
                { GEMINI_API_KEY: emptyKey },
                {
                    exitOnError: false,
                    logger: { error: () => {}, warn: () => {} },
                    isPythonAvailable: () => true
                }
            );

            assert.equal(result.valid, false);
            assert.equal(result.errors.length, 1);
            assert.match(result.errors[0], /GEMINI_API_KEY is missing or empty/);
        }
    });

    await t.test('warns when Python is not available but does not invalidate startup', () => {
        const warnings = [];
        const mockLogger = {
            error: () => {},
            warn: (msg) => warnings.push(msg)
        };

        const result = validateEnvironment(
            { GEMINI_API_KEY: 'test-valid-key' },
            {
                exitOnError: false,
                logger: mockLogger,
                isPythonAvailable: () => false
            }
        );

        assert.equal(result.valid, true);
        assert.equal(result.errors.length, 0);
        assert.equal(result.warnings.length, 1);
        assert.match(result.warnings[0], /Python 3 executable or processor\.py not found/);
        assert.ok(warnings.some(msg => typeof msg === 'string' && msg.includes('STARTUP WARNING')));
    });

    await t.test('exits with process.exit(1) when exitOnError is true and validation fails', () => {
        let exitCalledWith = null;
        const originalExit = process.exit;
        process.exit = (code) => {
            exitCalledWith = code;
            throw new Error(`process.exit called with ${code}`);
        };

        try {
            assert.throws(() => {
                validateEnvironment(
                    { GEMINI_API_KEY: '' },
                    {
                        exitOnError: true,
                        logger: { error: () => {}, warn: () => {} },
                        isPythonAvailable: () => true
                    }
                );
            }, /process.exit called with 1/);
            assert.equal(exitCalledWith, 1);
        } finally {
            process.exit = originalExit;
        }
    });
});

test('server startup CLI validation integration tests', async (t) => {
    await t.test('exits with status code 1 when GEMINI_API_KEY is missing via CLI run', () => {
        const proc = spawnSync(process.execPath, ['server.js'], {
            cwd: rootDir,
            env: {
                ...process.env,
                NODE_ENV: 'production',
                GEMINI_API_KEY: ''
            },
            encoding: 'utf8'
        });

        assert.equal(proc.status, 1, 'Expected process to exit with code 1');
        const combinedOutput = `${proc.stdout}\n${proc.stderr}`;
        assert.match(combinedOutput, /GEMINI_API_KEY is missing or empty/i);
        assert.match(combinedOutput, /Environment validation failed/i);
    });
});
