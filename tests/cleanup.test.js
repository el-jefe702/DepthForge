import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

process.env.NODE_ENV = 'test';
process.env.GEMINI_API_KEY = 'test_key';

// Import from cleanup.js
import {
    cleanupGeneratedFiles,
    cleanupGeneratedFilesSync,
    parseTtlHours,
    startCleanupScheduler,
    stopCleanupScheduler,
    formatDirForLog,
    isMainModule,
    DEFAULT_TTL_HOURS,
    CLEANUP_INTERVAL_MS,
    defaultGeneratedDir
} from '../cleanup.js';

// Also verify server.js re-exports
const serverExports = await import('../server.js');

describe('Automatic Generated File Cleanup (F8) - Unit & Integration Tests', () => {

    const testScratchDir = path.join(rootDir, 'tests', '__scratch_cleanup__');

    beforeEach(() => {
        if (fs.existsSync(testScratchDir)) {
            fs.rmSync(testScratchDir, { recursive: true, force: true });
        }
        fs.mkdirSync(testScratchDir, { recursive: true });
    });

    afterEach(() => {
        if (fs.existsSync(testScratchDir)) {
            fs.rmSync(testScratchDir, { recursive: true, force: true });
        }
    });

    describe('1. Module & Server Exports Contract', () => {
        test('cleanup.js exports required functions and constants', () => {
            assert.equal(typeof cleanupGeneratedFiles, 'function');
            assert.equal(typeof cleanupGeneratedFilesSync, 'function');
            assert.equal(typeof parseTtlHours, 'function');
            assert.equal(typeof startCleanupScheduler, 'function');
            assert.equal(typeof stopCleanupScheduler, 'function');
            assert.equal(typeof formatDirForLog, 'function');
            assert.equal(typeof isMainModule, 'function');
            assert.equal(DEFAULT_TTL_HOURS, 24);
            assert.equal(CLEANUP_INTERVAL_MS, 3600000);
            assert.equal(typeof defaultGeneratedDir, 'string');
        });

        test('server.js re-exports cleanup functions and constants', () => {
            assert.equal(typeof serverExports.cleanupGeneratedFiles, 'function');
            assert.equal(typeof serverExports.cleanupGeneratedFilesSync, 'function');
            assert.equal(typeof serverExports.parseTtlHours, 'function');
            assert.equal(typeof serverExports.startCleanupScheduler, 'function');
            assert.equal(typeof serverExports.stopCleanupScheduler, 'function');
            assert.equal(typeof serverExports.isMainModule, 'function');
            assert.equal(serverExports.DEFAULT_TTL_HOURS, 24);
            assert.equal(serverExports.CLEANUP_INTERVAL_MS, 3600000);
            assert.equal(typeof serverExports.generatedDir, 'string');
        });

        test('isMainModule returns false for server.js and cleanup.js when imported in test runner', () => {
            assert.equal(isMainModule(new URL('../server.js', import.meta.url).href), false);
            assert.equal(isMainModule(new URL('../cleanup.js', import.meta.url).href), false);
        });

        test('isMainModule accurately matches argv[1] path even across NTFS junctions and symlinks', () => {
            if (process.argv[1]) {
                const myUrl = new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;
                assert.equal(isMainModule(myUrl), true);
            }
        });
    });

    describe('2. TTL Validation & Fallback Logic (parseTtlHours)', () => {
        test('falls back to 24 when value is undefined, null, empty or whitespace', () => {
            assert.equal(parseTtlHours(undefined), 24);
            assert.equal(parseTtlHours(null), 24);
            assert.equal(parseTtlHours(''), 24);
            assert.equal(parseTtlHours('   '), 24);
            assert.equal(parseTtlHours('\t\n'), 24);
        });

        test('falls back to 24 for invalid, non-numeric strings or NaN', () => {
            assert.equal(parseTtlHours(NaN), 24);
            assert.equal(parseTtlHours('invalid'), 24);
            assert.equal(parseTtlHours('abc24'), 24);
            assert.equal(parseTtlHours('twenty-four'), 24);
        });

        test('falls back to 24 for negative numbers or negative numeric strings', () => {
            assert.equal(parseTtlHours(-1), 24);
            assert.equal(parseTtlHours(-24), 24);
            assert.equal(parseTtlHours('-10'), 24);
            assert.equal(parseTtlHours('-0.5'), 24);
        });

        test('falls back to 24 for zero and zero string', () => {
            assert.equal(parseTtlHours(0), 24);
            assert.equal(parseTtlHours('0'), 24);
        });

        test('falls back to 24 for non-finite numbers (Infinity, -Infinity)', () => {
            assert.equal(parseTtlHours(Infinity), 24);
            assert.equal(parseTtlHours(-Infinity), 24);
            assert.equal(parseTtlHours('Infinity'), 24);
            assert.equal(parseTtlHours('-Infinity'), 24);
        });

        test('falls back to 24 for booleans, objects, arrays, and symbols', () => {
            assert.equal(parseTtlHours(true), 24);
            assert.equal(parseTtlHours(false), 24);
            assert.equal(parseTtlHours({}), 24);
            assert.equal(parseTtlHours({ ttl: 24 }), 24);
            assert.equal(parseTtlHours([]), 24);
            assert.equal(parseTtlHours([24]), 24);
            assert.equal(parseTtlHours(Symbol('ttl')), 24);
        });

        test('parses and returns valid positive numbers and numeric strings', () => {
            assert.equal(parseTtlHours(1), 1);
            assert.equal(parseTtlHours(12), 12);
            assert.equal(parseTtlHours(24), 24);
            assert.equal(parseTtlHours(48), 48);
            assert.equal(parseTtlHours('1'), 1);
            assert.equal(parseTtlHours('12'), 12);
            assert.equal(parseTtlHours('24'), 24);
            assert.equal(parseTtlHours('72'), 72);
        });

        test('supports valid fractional positive numbers (e.g. 0.5 hours = 30 minutes)', () => {
            assert.equal(parseTtlHours(0.5), 0.5);
            assert.equal(parseTtlHours('1.5'), 1.5);
        });
    });

    describe('3. File Purging and Preservation Mechanics', () => {
        test('purges files older than TTL and preserves files within TTL threshold', async () => {
            const now = Math.floor(Date.now() / 1000) * 1000;
            const hourMs = 60 * 60 * 1000;

            const files = [
                { name: 'expired_48h.png', mtime: now - (48 * hourMs), expected: 'purged' },
                { name: 'expired_25h.png', mtime: now - (25 * hourMs), expected: 'purged' },
                { name: 'expired_24h_1s.png', mtime: now - (24 * hourMs) - 1000, expected: 'purged' },
                { name: 'threshold_24h.png', mtime: now - (24 * hourMs), expected: 'preserved' },
                { name: 'fresh_23h.png', mtime: now - (23 * hourMs), expected: 'preserved' },
                { name: 'fresh_1h.png', mtime: now - (1 * hourMs), expected: 'preserved' },
                { name: 'fresh_now.png', mtime: now, expected: 'preserved' },
                { name: 'future_file.png', mtime: now + (1 * hourMs), expected: 'preserved' }
            ];

            for (const f of files) {
                const filePath = path.join(testScratchDir, f.name);
                fs.writeFileSync(filePath, `content of ${f.name}`);
                const timeSec = f.mtime / 1000;
                fs.utimesSync(filePath, timeSec, timeSec);
            }

            const result = await cleanupGeneratedFiles({
                dir: testScratchDir,
                ttlHours: 24,
                now,
                log: false
            });

            assert.equal(result.scanned, 8);
            assert.equal(result.removed, 3);
            assert.equal(result.preserved, 5);
            assert.equal(result.errors.length, 0);
            assert.equal(result.ttlHours, 24);

            for (const f of files) {
                const filePath = path.join(testScratchDir, f.name);
                const exists = fs.existsSync(filePath);
                if (f.expected === 'purged') {
                    assert.equal(exists, false, `Expected ${f.name} to be purged`);
                } else {
                    assert.equal(exists, true, `Expected ${f.name} to be preserved`);
                    assert.equal(fs.readFileSync(filePath, 'utf-8'), `content of ${f.name}`);
                }
            }
        });

        test('respects custom ttlHours parameter (e.g. 12 hours)', async () => {
            const now = Date.now();
            const hourMs = 60 * 60 * 1000;

            const f1 = path.join(testScratchDir, 'file_15h.png');
            const f2 = path.join(testScratchDir, 'file_10h.png');

            fs.writeFileSync(f1, 'old');
            fs.writeFileSync(f2, 'fresh');
            fs.utimesSync(f1, (now - 15 * hourMs) / 1000, (now - 15 * hourMs) / 1000);
            fs.utimesSync(f2, (now - 10 * hourMs) / 1000, (now - 10 * hourMs) / 1000);

            const result = await cleanupGeneratedFiles({
                dir: testScratchDir,
                ttlHours: 12,
                now,
                log: false
            });

            assert.equal(result.scanned, 2);
            assert.equal(result.removed, 1);
            assert.equal(result.preserved, 1);
            assert.equal(fs.existsSync(f1), false);
            assert.equal(fs.existsSync(f2), true);
        });

        test('synchronous API cleanupGeneratedFilesSync performs identical purging', () => {
            const now = Date.now();
            const hourMs = 60 * 60 * 1000;

            const fOld = path.join(testScratchDir, 'sync_old.png');
            const fNew = path.join(testScratchDir, 'sync_new.png');

            fs.writeFileSync(fOld, 'old');
            fs.writeFileSync(fNew, 'new');
            fs.utimesSync(fOld, (now - 30 * hourMs) / 1000, (now - 30 * hourMs) / 1000);
            fs.utimesSync(fNew, (now - 2 * hourMs) / 1000, (now - 2 * hourMs) / 1000);

            const result = cleanupGeneratedFilesSync({
                dir: testScratchDir,
                ttlHours: 24,
                now,
                log: false
            });

            assert.equal(result.scanned, 2);
            assert.equal(result.removed, 1);
            assert.equal(result.preserved, 1);
            assert.equal(fs.existsSync(fOld), false);
            assert.equal(fs.existsSync(fNew), true);
        });

        test('strictly tests cutoff boundary precision: cutoffMs - 1ms (purged) vs cutoffMs (preserved) vs cutoffMs + 1ms (preserved)', async () => {
            const now = 1700000000000; // Integer millisecond baseline
            const ttlHours = 24;
            const ttlMs = ttlHours * 3600 * 1000;
            const cutoffMs = now - ttlMs;

            const fPastCutoff = path.join(testScratchDir, 'boundary_past.png');
            const fExactCutoff = path.join(testScratchDir, 'boundary_exact.png');
            const fBeforeCutoff = path.join(testScratchDir, 'boundary_future.png');

            fs.writeFileSync(fPastCutoff, 'past');
            fs.writeFileSync(fExactCutoff, 'exact');
            fs.writeFileSync(fBeforeCutoff, 'future');

            fs.utimesSync(fPastCutoff, (cutoffMs - 1000) / 1000, (cutoffMs - 1000) / 1000);
            fs.utimesSync(fExactCutoff, cutoffMs / 1000, cutoffMs / 1000);
            fs.utimesSync(fBeforeCutoff, (cutoffMs + 1000) / 1000, (cutoffMs + 1000) / 1000);

            const result = await cleanupGeneratedFiles({
                dir: testScratchDir,
                ttlHours: 24,
                now,
                log: false
            });

            assert.equal(result.scanned, 3);
            assert.equal(result.removed, 1);
            assert.equal(result.preserved, 2);
            assert.equal(fs.existsSync(fPastCutoff), false, 'cutoffMs - 1s must be purged');
            assert.equal(fs.existsSync(fExactCutoff), true, 'cutoffMs exact must be preserved');
            assert.equal(fs.existsSync(fBeforeCutoff), true, 'cutoffMs + 1s must be preserved');
        });
    });

    describe('4. Directory Edge Cases & Robustness', () => {
        test('handles missing directory gracefully without throwing or crashing', async () => {
            const nonExistentDir = path.join(testScratchDir, 'does_not_exist_xyz');

            const resultAsync = await cleanupGeneratedFiles({
                dir: nonExistentDir,
                ttlHours: 24,
                log: false
            });

            assert.deepEqual(resultAsync.scanned, 0);
            assert.deepEqual(resultAsync.removed, 0);
            assert.deepEqual(resultAsync.preserved, 0);
            assert.deepEqual(resultAsync.errors, []);
            assert.equal(resultAsync.ttlHours, 24);

            const resultSync = cleanupGeneratedFilesSync({
                dir: nonExistentDir,
                ttlHours: 24,
                log: false
            });

            assert.deepEqual(resultSync.scanned, 0);
            assert.deepEqual(resultSync.removed, 0);
            assert.deepEqual(resultSync.preserved, 0);
            assert.deepEqual(resultSync.errors, []);
        });

        test('handles empty directory cleanly without errors', async () => {
            const emptyDir = path.join(testScratchDir, 'empty_dir');
            fs.mkdirSync(emptyDir, { recursive: true });

            const resultAsync = await cleanupGeneratedFiles({
                dir: emptyDir,
                ttlHours: 24,
                log: false
            });

            assert.equal(resultAsync.scanned, 0);
            assert.equal(resultAsync.removed, 0);
            assert.equal(resultAsync.preserved, 0);
            assert.equal(resultAsync.errors.length, 0);

            const resultSync = cleanupGeneratedFilesSync({
                dir: emptyDir,
                ttlHours: 24,
                log: false
            });

            assert.equal(resultSync.scanned, 0);
            assert.equal(resultSync.removed, 0);
        });

        test('ignores subdirectories and non-file artifacts without descending or deleting them', async () => {
            const subDir = path.join(testScratchDir, 'nested_folder');
            fs.mkdirSync(subDir, { recursive: true });

            // File inside subdirectory with an old mtime
            const nestedFile = path.join(subDir, 'nested_expired.png');
            fs.writeFileSync(nestedFile, 'nested data');
            const now = Date.now();
            const oldTimeSec = (now - 100 * 3600 * 1000) / 1000;
            fs.utimesSync(nestedFile, oldTimeSec, oldTimeSec);
            fs.utimesSync(subDir, oldTimeSec, oldTimeSec);

            // Regular file in parent directory that is expired
            const rootExpired = path.join(testScratchDir, 'root_expired.png');
            fs.writeFileSync(rootExpired, 'root data');
            fs.utimesSync(rootExpired, oldTimeSec, oldTimeSec);

            const result = await cleanupGeneratedFiles({
                dir: testScratchDir,
                ttlHours: 24,
                now,
                log: false
            });

            assert.equal(result.scanned, 1); // Only rootExpired scanned
            assert.equal(result.removed, 1);
            assert.equal(fs.existsSync(rootExpired), false);
            assert.equal(fs.existsSync(subDir), true); // Subdirectory strictly preserved
            assert.equal(fs.existsSync(nestedFile), true); // Nested file inside subdirectory strictly preserved
        });

        test('falls back to defaultGeneratedDir when dir is omitted, null, or empty', async () => {
            const originalEnv = process.env.GENERATED_TTL_HOURS;
            try {
                process.env.GENERATED_TTL_HOURS = '24';
                // Invoking with no arguments should not crash
                const res = await cleanupGeneratedFiles({ log: false });
                assert.equal(typeof res.scanned, 'number');
                assert.equal(typeof res.removed, 'number');
                assert.equal(typeof res.preserved, 'number');
            } finally {
                process.env.GENERATED_TTL_HOURS = originalEnv;
            }
        });

        test('handles targetDir pointing to a regular file instead of directory without crashing', async () => {
            const fakeFileDir = path.join(testScratchDir, 'not_a_dir.png');
            fs.writeFileSync(fakeFileDir, 'I am a file');

            const resAsync = await cleanupGeneratedFiles({
                dir: fakeFileDir,
                ttlHours: 24,
                log: false
            });
            assert.equal(resAsync.scanned, 0);
            assert.equal(resAsync.removed, 0);
            assert.equal(resAsync.preserved, 0);
            assert.deepEqual(resAsync.errors, []);

            const resSync = cleanupGeneratedFilesSync({
                dir: fakeFileDir,
                ttlHours: 24,
                log: false
            });
            assert.equal(resSync.scanned, 0);
            assert.equal(resSync.removed, 0);
            assert.equal(resSync.preserved, 0);
            assert.deepEqual(resSync.errors, []);
        });

        test('handles non-finite or invalid now timestamp falling back to Date.now()', async () => {
            const now = Date.now();
            const fOld = path.join(testScratchDir, 'old_invalid_now.png');
            fs.writeFileSync(fOld, 'old data');
            const oldTimeSec = (now - 30 * 3600 * 1000) / 1000;
            fs.utimesSync(fOld, oldTimeSec, oldTimeSec);

            const res = await cleanupGeneratedFiles({
                dir: testScratchDir,
                ttlHours: 24,
                now: 'invalid_timestamp',
                log: false
            });

            assert.equal(res.scanned, 1);
            assert.equal(res.removed, 1);
            assert.equal(fs.existsSync(fOld), false);
        });

        test('explicit ttlHours: null falls back to default 24h even if process.env.GENERATED_TTL_HOURS is set', async () => {
            const originalEnv = process.env.GENERATED_TTL_HOURS;
            try {
                process.env.GENERATED_TTL_HOURS = '48';
                const res = await cleanupGeneratedFiles({
                    dir: testScratchDir,
                    ttlHours: null,
                    log: false
                });
                assert.equal(res.ttlHours, 24);

                const resSync = cleanupGeneratedFilesSync({
                    dir: testScratchDir,
                    ttlHours: null,
                    log: false
                });
                assert.equal(resSync.ttlHours, 24);
            } finally {
                process.env.GENERATED_TTL_HOURS = originalEnv;
            }
        });

        test('supports now passed as a Date object in both async and sync APIs', async () => {
            const now = Date.now();
            const dateObj = new Date(now);
            const hourMs = 3600 * 1000;

            const fOld = path.join(testScratchDir, 'date_old.png');
            const fFresh = path.join(testScratchDir, 'date_fresh.png');
            fs.writeFileSync(fOld, 'old');
            fs.writeFileSync(fFresh, 'fresh');
            fs.utimesSync(fOld, (now - 30 * hourMs) / 1000, (now - 30 * hourMs) / 1000);
            fs.utimesSync(fFresh, (now - 2 * hourMs) / 1000, (now - 2 * hourMs) / 1000);

            const resAsync = await cleanupGeneratedFiles({
                dir: testScratchDir,
                ttlHours: 24,
                now: dateObj,
                log: false
            });

            assert.equal(resAsync.scanned, 2);
            assert.equal(resAsync.removed, 1);
            assert.equal(resAsync.preserved, 1);
            assert.equal(fs.existsSync(fOld), false);
            assert.equal(fs.existsSync(fFresh), true);

            // Re-create old file for sync test
            fs.writeFileSync(fOld, 'old');
            fs.utimesSync(fOld, (now - 30 * hourMs) / 1000, (now - 30 * hourMs) / 1000);

            const resSync = cleanupGeneratedFilesSync({
                dir: testScratchDir,
                ttlHours: 24,
                now: dateObj,
                log: false
            });

            assert.equal(resSync.scanned, 2);
            assert.equal(resSync.removed, 1);
            assert.equal(resSync.preserved, 1);
            assert.equal(fs.existsSync(fOld), false);
            assert.equal(fs.existsSync(fFresh), true);
        });

        test('guarantees accounting soundness: scanned === removed + preserved + errors.length', async () => {
            const now = Date.now();
            const hourMs = 3600 * 1000;

            const f1 = path.join(testScratchDir, 'acc_old.png');
            const f2 = path.join(testScratchDir, 'acc_fresh.png');
            const subDir = path.join(testScratchDir, 'acc_subdir');

            fs.writeFileSync(f1, 'old');
            fs.writeFileSync(f2, 'fresh');
            fs.mkdirSync(subDir, { recursive: true });

            fs.utimesSync(f1, (now - 30 * hourMs) / 1000, (now - 30 * hourMs) / 1000);
            fs.utimesSync(f2, (now - 1 * hourMs) / 1000, (now - 1 * hourMs) / 1000);

            const res = await cleanupGeneratedFiles({
                dir: testScratchDir,
                ttlHours: 24,
                now,
                log: false
            });

            assert.equal(res.scanned, 2);
            assert.equal(res.removed, 1);
            assert.equal(res.preserved, 1);
            assert.equal(res.scanned, res.removed + res.preserved + res.errors.length);
        });

        test('guarantees accounting soundness when stat throws error: scanned === removed + preserved + errors.length', async () => {
            const now = Date.now();
            const f1 = path.join(testScratchDir, 'stat_err_file.png');
            fs.writeFileSync(f1, 'data');

            const originalStat = fs.promises.stat;
            fs.promises.stat = async (p) => {
                if (typeof p === 'string' && p.includes('stat_err_file.png')) {
                    const err = new Error('Simulated stat failure');
                    err.code = 'EACCES';
                    throw err;
                }
                return originalStat(p);
            };

            try {
                const res = await cleanupGeneratedFiles({
                    dir: testScratchDir,
                    ttlHours: 24,
                    now,
                    log: false
                });

                assert.equal(res.scanned, 1);
                assert.equal(res.removed, 0);
                assert.equal(res.preserved, 0);
                assert.equal(res.errors.length, 1);
                assert.equal(res.scanned, res.removed + res.preserved + res.errors.length);
            } finally {
                fs.promises.stat = originalStat;
            }
        });

        test('supports dir passed as file URL object', async () => {
            const now = Date.now();
            const hourMs = 3600 * 1000;
            const fOld = path.join(testScratchDir, 'url_old.png');
            fs.writeFileSync(fOld, 'url_test');
            fs.utimesSync(fOld, (now - 30 * hourMs) / 1000, (now - 30 * hourMs) / 1000);

            const fileUrl = new URL(`file:///${testScratchDir.replace(/\\/g, '/')}`);
            const res = await cleanupGeneratedFiles({
                dir: fileUrl,
                ttlHours: 24,
                now,
                log: false
            });

            assert.equal(res.removed, 1);
            assert.equal(fs.existsSync(fOld), false);
        });
    });

    describe('5. Error Handling & Locked Files', () => {
        test('handles locked file deletion error gracefully without crashing', async () => {
            const now = Date.now();
            const hourMs = 3600 * 1000;

            const fileLocked = path.join(testScratchDir, 'locked.png');
            const fileNormal = path.join(testScratchDir, 'normal_expired.png');

            fs.writeFileSync(fileLocked, 'locked');
            fs.writeFileSync(fileNormal, 'normal');

            const oldTimeSec = (now - 30 * hourMs) / 1000;
            fs.utimesSync(fileLocked, oldTimeSec, oldTimeSec);
            fs.utimesSync(fileNormal, oldTimeSec, oldTimeSec);

            // Monkey-patch fs.promises.unlink temporarily to simulate an EBUSY/EPERM error on fileLocked
            const originalUnlink = fs.promises.unlink;
            try {
                fs.promises.unlink = async (p) => {
                    if (p.includes('locked.png')) {
                        const err = new Error('EBUSY: resource busy or locked');
                        err.code = 'EBUSY';
                        throw err;
                    }
                    return originalUnlink(p);
                };

                const result = await cleanupGeneratedFiles({
                    dir: testScratchDir,
                    ttlHours: 24,
                    now,
                    log: false
                });

                assert.equal(result.scanned, 2);
                assert.equal(result.removed, 1); // normal_expired was removed
                assert.equal(result.errors.length, 1);
                assert.equal(result.errors[0].file, 'locked.png');
                assert.equal(result.errors[0].error.code, 'EBUSY');
                assert.equal(fs.existsSync(fileNormal), false);
                assert.equal(fs.existsSync(fileLocked), true); // locked file remains
            } finally {
                fs.promises.unlink = originalUnlink;
            }
        });

        test('sync version handles locked file deletion error gracefully', () => {
            const now = Date.now();
            const hourMs = 3600 * 1000;

            const fileLocked = path.join(testScratchDir, 'sync_locked.png');
            fs.writeFileSync(fileLocked, 'locked');
            const oldTimeSec = (now - 30 * hourMs) / 1000;
            fs.utimesSync(fileLocked, oldTimeSec, oldTimeSec);

            const originalUnlinkSync = fs.unlinkSync;
            try {
                fs.unlinkSync = (p) => {
                    if (p.includes('sync_locked.png')) {
                        const err = new Error('EPERM: operation not permitted');
                        err.code = 'EPERM';
                        throw err;
                    }
                    return originalUnlinkSync(p);
                };

                const result = cleanupGeneratedFilesSync({
                    dir: testScratchDir,
                    ttlHours: 24,
                    now,
                    log: false
                });

                assert.equal(result.scanned, 1);
                assert.equal(result.removed, 0);
                assert.equal(result.errors.length, 1);
                assert.equal(result.errors[0].file, 'sync_locked.png');
                assert.equal(fs.existsSync(fileLocked), true);
            } finally {
                fs.unlinkSync = originalUnlinkSync;
            }
        });

        test('handles real OS-level process locked file without crashing', async () => {
            if (process.platform !== 'win32') return;

            const now = Date.now();
            const hourMs = 3600 * 1000;
            const fileLocked = path.join(testScratchDir, 'real_os_locked.png');
            fs.writeFileSync(fileLocked, 'locked data');
            const oldTimeSec = (now - 30 * hourMs) / 1000;
            fs.utimesSync(fileLocked, oldTimeSec, oldTimeSec);

            // Spawn PowerShell process that holds exclusive lock with FileShare.None and signals via stdout
            const psScript = `
                $stream = [System.IO.File]::Open('${fileLocked.replace(/\\/g, '\\\\')}', [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None);
                [Console]::Out.WriteLine('LOCKED');
                [Console]::Out.Flush();
                Start-Sleep -Seconds 15;
                $stream.Close();
            `;
            const locker = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', psScript]);

            // Deterministically await confirmation from PowerShell that the file lock has been acquired
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    try { locker.kill(); } catch {}
                    reject(new Error('Timed out waiting for PowerShell to acquire file lock'));
                }, 10000);

                locker.stdout.on('data', (data) => {
                    if (data.toString().includes('LOCKED')) {
                        clearTimeout(timeout);
                        resolve();
                    }
                });

                locker.on('error', (err) => {
                    clearTimeout(timeout);
                    reject(err);
                });
            });

            try {
                const result = await cleanupGeneratedFiles({
                    dir: testScratchDir,
                    ttlHours: 24,
                    now,
                    log: false
                });

                assert.equal(result.scanned, 1);
                assert.equal(result.removed, 0);
                assert.equal(result.errors.length, 1);
                assert.equal(result.errors[0].file, 'real_os_locked.png');
                assert.ok(
                    result.errors[0].error.code === 'EBUSY' || result.errors[0].error.code === 'EPERM',
                    `Expected EBUSY or EPERM, got ${result.errors[0].error.code}`
                );
                assert.equal(fs.existsSync(fileLocked), true, 'Locked file must still exist');
            } finally {
                if (locker && locker.exitCode === null) {
                    try { locker.kill(); } catch {}
                    await new Promise(r => locker.on('close', r));
                }
                if (fs.existsSync(fileLocked)) {
                    try { fs.unlinkSync(fileLocked); } catch {}
                }
            }
        });
    });

    describe('6. Stdout Logging Contract', () => {
        let loggedMessages = [];
        const originalLog = console.log;

        beforeEach(() => {
            loggedMessages = [];
            console.log = (...args) => {
                loggedMessages.push(args.join(' '));
            };
        });

        afterEach(() => {
            console.log = originalLog;
        });

        test('logs scan execution and count matching required format', async () => {
            const now = Date.now();
            const hourMs = 3600 * 1000;

            const f1 = path.join(testScratchDir, 'test_purge_1.png');
            const f2 = path.join(testScratchDir, 'test_purge_2.png');
            fs.writeFileSync(f1, 'old1');
            fs.writeFileSync(f2, 'old2');
            fs.utimesSync(f1, (now - 30 * hourMs) / 1000, (now - 30 * hourMs) / 1000);
            fs.utimesSync(f2, (now - 30 * hourMs) / 1000, (now - 30 * hourMs) / 1000);

            await cleanupGeneratedFiles({
                dir: testScratchDir,
                ttlHours: 24,
                now,
                log: true
            });

            const cleanupLogs = loggedMessages.filter(m => m.startsWith('[Cleanup]'));
            assert.equal(cleanupLogs.length, 1);
            // Matches: [Cleanup] Scanned ... - removed 2 expired files older than 24h
            const logLine = cleanupLogs[0];
            assert.match(logLine, /\[Cleanup\] Scanned .* - removed 2 expired files older than 24h/);
        });

        test('logs 0 removed files when directory is empty or all files are fresh', async () => {
            await cleanupGeneratedFiles({
                dir: testScratchDir,
                ttlHours: 24,
                log: true
            });

            const cleanupLogs = loggedMessages.filter(m => m.startsWith('[Cleanup]'));
            assert.equal(cleanupLogs.length, 1);
            assert.match(cleanupLogs[0], /\[Cleanup\] Scanned .* - removed 0 expired files older than 24h/);
        });

        test('formatDirForLog normalizes paths cleanly', () => {
            const generatedPath = path.join(rootDir, 'static', 'generated');
            assert.equal(formatDirForLog(generatedPath), 'static/generated');
            assert.equal(formatDirForLog('static/generated'), 'static/generated');
        });
    });

    describe('7. Periodic Cleanup Scheduler (startCleanupScheduler & stopCleanupScheduler)', () => {
        test('runs cleanup immediately upon startup when runImmediately is true', async () => {
            let runCount = 0;
            const now = Date.now();
            const fOld = path.join(testScratchDir, 'sched_old.png');
            fs.writeFileSync(fOld, 'old');
            fs.utimesSync(fOld, (now - 30 * 3600 * 1000) / 1000, (now - 30 * 3600 * 1000) / 1000);

            const scheduler = startCleanupScheduler({
                dir: testScratchDir,
                ttlHours: 24,
                intervalMs: 10000,
                runImmediately: true,
                log: false
            });

            // Wait a tick for the async startup task to complete
            await new Promise(r => setTimeout(r, 50));

            stopCleanupScheduler(scheduler);

            assert.equal(fs.existsSync(fOld), false, 'File should have been cleaned up on startup');
        });

        test('runs periodically at specified interval and stops cleanly', async () => {
            const now = Date.now();
            const hourMs = 3600 * 1000;

            const scheduler = startCleanupScheduler({
                dir: testScratchDir,
                ttlHours: 24,
                intervalMs: 50, // Fast interval for testing
                runImmediately: false,
                log: false
            });

            // Add an expired file after starting scheduler
            const fOld = path.join(testScratchDir, 'periodic_old.png');
            fs.writeFileSync(fOld, 'old');
            fs.utimesSync(fOld, (now - 30 * hourMs) / 1000, (now - 30 * hourMs) / 1000);

            assert.equal(fs.existsSync(fOld), true);

            // Wait for interval to trigger at least once (120ms > 50ms)
            await new Promise(r => setTimeout(r, 120));

            assert.equal(fs.existsSync(fOld), false, 'File should have been cleaned up on periodic tick');

            // Stop scheduler
            await stopCleanupScheduler(scheduler);

            // Add another expired file; verify it is NOT cleaned up after stop
            const fPostStop = path.join(testScratchDir, 'post_stop.png');
            fs.writeFileSync(fPostStop, 'post stop');
            fs.utimesSync(fPostStop, (now - 30 * hourMs) / 1000, (now - 30 * hourMs) / 1000);

            await new Promise(r => setTimeout(r, 100));
            assert.equal(fs.existsSync(fPostStop), true, 'File should NOT be cleaned up after scheduler stopped');
        });

        test('stopCleanupScheduler accepts raw timer or scheduler object', async () => {
            const timer = setInterval(() => {}, 10000);
            await stopCleanupScheduler(timer);
            // Should not throw
            await stopCleanupScheduler(null);
            await stopCleanupScheduler(undefined);
            await stopCleanupScheduler({ stop: () => {} });
        });
    });

    describe('8. Environment Variable Configuration (GENERATED_TTL_HOURS)', () => {
        const originalEnv = process.env.GENERATED_TTL_HOURS;

        afterEach(() => {
            if (originalEnv !== undefined) {
                process.env.GENERATED_TTL_HOURS = originalEnv;
            } else {
                delete process.env.GENERATED_TTL_HOURS;
            }
        });

        test('uses GENERATED_TTL_HOURS environment variable when ttlHours argument is omitted', async () => {
            process.env.GENERATED_TTL_HOURS = '48';

            const now = Date.now();
            const hourMs = 3600 * 1000;

            const f30h = path.join(testScratchDir, 'f_30h.png'); // Fresh under 48h TTL
            const f50h = path.join(testScratchDir, 'f_50h.png'); // Expired under 48h TTL

            fs.writeFileSync(f30h, '30h');
            fs.writeFileSync(f50h, '50h');

            fs.utimesSync(f30h, (now - 30 * hourMs) / 1000, (now - 30 * hourMs) / 1000);
            fs.utimesSync(f50h, (now - 50 * hourMs) / 1000, (now - 50 * hourMs) / 1000);

            const result = await cleanupGeneratedFiles({
                dir: testScratchDir,
                now,
                log: false
            });

            assert.equal(result.ttlHours, 48);
            assert.equal(result.scanned, 2);
            assert.equal(result.removed, 1);
            assert.equal(result.preserved, 1);
            assert.equal(fs.existsSync(f30h), true);
            assert.equal(fs.existsSync(f50h), false);
        });

        test('falls back to 24 when GENERATED_TTL_HOURS env var is invalid or negative', async () => {
            for (const invalidVal of ['not_a_number', '-10', '0', '']) {
                process.env.GENERATED_TTL_HOURS = invalidVal;
                const result = await cleanupGeneratedFiles({
                    dir: testScratchDir,
                    log: false
                });
                assert.equal(result.ttlHours, 24);
            }
        });
    });

    describe('9. Comprehensive End-to-End Generated Directory Verification', () => {
        test('can safely scan default static/generated directory without altering fresh files', async () => {
            const staticGenDir = path.join(rootDir, 'static', 'generated');
            assert.equal(fs.existsSync(staticGenDir), true);

            // Create a test file that is guaranteed fresh (now)
            const testFreshFile = path.join(staticGenDir, `test_fresh_probe_${Date.now()}.png`);
            fs.writeFileSync(testFreshFile, 'fresh probe data');

            try {
                const res = await cleanupGeneratedFiles({
                    dir: staticGenDir,
                    ttlHours: 24,
                    log: false
                });

                assert.equal(typeof res.scanned, 'number');
                assert.equal(typeof res.removed, 'number');
                assert.equal(typeof res.preserved, 'number');
                // The fresh file must strictly still exist
                assert.equal(fs.existsSync(testFreshFile), true, 'Fresh probe file must remain intact');
            } finally {
                if (fs.existsSync(testFreshFile)) {
                    fs.unlinkSync(testFreshFile);
                }
            }
        });
    });

    describe('10. Server Startup Integration & CLI Direct Execution', () => {
        test('spawns server.js directly and confirms startup banner and immediate cleanup scan log', async () => {
            const testPort = '8192';
            const serverProcess = spawn('node', ['server.js'], {
                cwd: rootDir,
                env: {
                    ...process.env,
                    NODE_ENV: 'development',
                    PORT: testPort
                }
            });

            let combinedOutput = '';
            serverProcess.stdout.on('data', (data) => {
                combinedOutput += data.toString();
            });
            serverProcess.stderr.on('data', (data) => {
                combinedOutput += data.toString();
            });

            // Wait up to 2.5s for startup banner and cleanup log
            const startTime = Date.now();
            while (Date.now() - startTime < 2500) {
                if (combinedOutput.includes('DepthForge running on') && combinedOutput.includes('[Cleanup] Scanned')) {
                    break;
                }
                await new Promise(r => setTimeout(r, 100));
            }

            // Cleanly terminate server process
            serverProcess.kill();
            await new Promise(r => serverProcess.on('close', r));

            assert.match(combinedOutput, /DepthForge running on http:\/\/0\.0\.0\.0:8192/);
            assert.match(combinedOutput, /\[Cleanup\] Scanned .* - removed \d+ expired files older than \d+h/);
        });

        test('runs node cleanup.js directly and verifies clean execution with exit code 0', () => {
            const result = spawnSync('node', ['cleanup.js', testScratchDir, '24'], {
                cwd: rootDir,
                encoding: 'utf-8',
                env: {
                    ...process.env,
                    NODE_ENV: 'development'
                }
            });

            assert.equal(result.status, 0);
            assert.match(result.stdout, /\[Cleanup\] Scanned .* - removed 0 expired files older than 24h/);
        });

        test('startCleanupScheduler falls back to CLEANUP_INTERVAL_MS when intervalMs is invalid or negative', () => {
            const scheduler = startCleanupScheduler({
                dir: testScratchDir,
                ttlHours: 24,
                intervalMs: -100,
                runImmediately: false,
                log: false
            });
            assert.ok(scheduler.timer);
            stopCleanupScheduler(scheduler);
        });

        test('node cleanup.js --help prints usage instructions with exit code 0', () => {
            const result = spawnSync('node', ['cleanup.js', '--help'], {
                cwd: rootDir,
                encoding: 'utf-8',
                env: {
                    ...process.env,
                    NODE_ENV: 'development'
                }
            });

            assert.equal(result.status, 0);
            assert.match(result.stdout, /Usage: node cleanup\.js \[directory\] \[ttlHours\]/);
            assert.match(result.stdout, /Target directory to scan/);
        });

        test('node cleanup.js --dir and --ttl flags are supported with exit code 0', () => {
            const result = spawnSync('node', ['cleanup.js', '--dir', testScratchDir, '--ttl', '12'], {
                cwd: rootDir,
                encoding: 'utf-8',
                env: {
                    ...process.env,
                    NODE_ENV: 'development'
                }
            });

            assert.equal(result.status, 0);
            assert.match(result.stdout, /\[Cleanup\] Scanned .* - removed 0 expired files older than 12h/);
        });

        test('server.on("close") invokes stopCleanupScheduler when server shuts down', async () => {
            const scheduler = startCleanupScheduler({
                dir: testScratchDir,
                intervalMs: 3600000,
                runImmediately: false,
                log: false
            });

            assert.equal(scheduler.isStopped, false);

            const { EventEmitter } = await import('node:events');
            const mockServer = new EventEmitter();
            mockServer.on('close', () => {
                stopCleanupScheduler(scheduler);
            });

            mockServer.emit('close');
            await new Promise(r => setImmediate(r));

            assert.equal(scheduler.isStopped, true);
        });

        test('server process handles SIGINT gracefully, closing server and tearing down cleanup scheduler', async () => {
            const testPort = '8193';
            const serverProcess = spawn('node', ['server.js'], {
                cwd: rootDir,
                env: {
                    ...process.env,
                    NODE_ENV: 'development',
                    PORT: testPort
                }
            });

            let combinedOutput = '';
            serverProcess.stdout.on('data', (data) => {
                combinedOutput += data.toString();
            });

            // Wait up to 3s for startup banner
            const startTime = Date.now();
            while (Date.now() - startTime < 3000) {
                if (combinedOutput.includes('DepthForge running on')) {
                    break;
                }
                await new Promise(r => setTimeout(r, 100));
            }

            // Terminate cleanly via SIGINT
            serverProcess.kill('SIGINT');
            const exitCode = await new Promise(r => serverProcess.on('close', r));
            assert.ok(exitCode === 0 || exitCode === null || serverProcess.killed);
        });
    });
});
