import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const readmePath = path.join(rootDir, 'README.md');

describe('Feature F20 (Comprehensive README Documentation Update) - Tests', () => {
    const readmeContent = fs.readFileSync(readmePath, 'utf-8');

    describe('1. Core Features Documentation (F1 through F20)', () => {
        const requiredFeatures = [
            { id: 'F1', name: 'Aspect Ratio Selector' },
            { id: 'F2', name: 'Invert Depth Map' },
            { id: 'F3', name: 'Prompt History' },
            { id: 'F4', name: 'Real-Time Pipeline Progress via SSE' },
            { id: 'F5', name: 'Session Gallery / History Panel' },
            { id: 'F6', name: 'Depth Intensity Slider' },
            { id: 'F7', name: 'Side-by-Side Comparison View' },
            { id: 'F8', name: 'Automatic Generated File Cleanup' },
            { id: 'F9', name: 'Health Check Endpoint' },
            { id: 'F10', name: 'Rate Limiting' },
            { id: 'F11', name: '3D Live Preview' },
            { id: 'F12', name: 'Style Presets' },
            { id: 'F13', name: 'Batch Generation' },
            { id: 'F14', name: 'Environment Validation at Startup' },
            { id: 'F15', name: 'Gemini Prompt Response Robustness' },
            { id: 'F16', name: 'Multer UUID Filenames with Extension' },
            { id: 'F17', name: 'processor.py Step Order & Structure' },
            { id: 'F18', name: 'Concurrency Queue for Python Processor' },
            { id: 'F19', name: 'Android Share Intent' },
            { id: 'F20', name: 'Comprehensive README Documentation Update' }
        ];

        for (let i = 1; i <= 20; i++) {
            const feat = requiredFeatures[i - 1];
            test(`README documents Feature F${i} (${feat.name})`, () => {
                const marker = `(F${i})`;
                assert.ok(
                    readmeContent.includes(marker),
                    `README.md must explicitly contain feature marker ${marker}`
                );
                assert.ok(
                    readmeContent.toLowerCase().includes(feat.name.toLowerCase().split(' ')[0]),
                    `README.md must describe Feature F${i} (${feat.name})`
                );
            });
        }
    });

    describe('2. API Endpoints Table Documentation', () => {
        const requiredRoutes = [
            '/api/health',
            '/api/generate',
            '/api/photo-to-depth',
            '/api/postprocess',
            '/api/postprocess-stream',
            '/api/invert',
            '/api/remove_bg'
        ];

        requiredRoutes.forEach(route => {
            test(`API Endpoints table documents ${route}`, () => {
                assert.ok(
                    readmeContent.includes(route),
                    `README.md must document endpoint ${route} in the API Endpoints table`
                );
            });
        });
    });

    describe('3. Prerequisites, Environment Variables, and Dependencies', () => {
        test('Documents Prerequisites including Node.js and Python', () => {
            assert.ok(
                readmeContent.includes('Node.js') && readmeContent.includes('18+'),
                'Must document Node.js 18+ prerequisite'
            );
            assert.ok(
                readmeContent.includes('Python') && readmeContent.includes('3.10+'),
                'Must document Python 3.10+ prerequisite'
            );
        });

        test('Documents all required environment variables', () => {
            const requiredEnvVars = [
                'GEMINI_API_KEY',
                'GENERATED_TTL_HOURS',
                'RATE_LIMIT_WINDOW_MS',
                'RATE_LIMIT_MAX',
                'TRUST_PROXY'
            ];
            requiredEnvVars.forEach(envVar => {
                assert.ok(
                    readmeContent.includes(envVar),
                    `README.md must document environment variable ${envVar}`
                );
            });
        });

        test('Documents required npm packages', () => {
            const requiredNpm = [
                'p-queue',
                'express-rate-limit',
                'multer'
            ];
            requiredNpm.forEach(pkg => {
                assert.ok(
                    readmeContent.includes(pkg),
                    `README.md must document npm package ${pkg}`
                );
            });
        });

        test('Documents required Python packages', () => {
            const requiredPython = [
                'opencv-python',
                'numpy',
                'rembg'
            ];
            requiredPython.forEach(pkg => {
                assert.ok(
                    readmeContent.includes(pkg),
                    `README.md must document Python package ${pkg}`
                );
            });
        });
    });

    describe('4. Android App Features Documentation', () => {
        const requiredAndroidFeatures = [
            'Share Sheet',
            'Session Gallery',
            '3D Preview WebView',
            'Aspect Ratio',
            'Depth Intensity',
            'Style Presets',
            'Batch Candidate Grid'
        ];

        requiredAndroidFeatures.forEach(feature => {
            test(`Documents Android feature: ${feature}`, () => {
                assert.ok(
                    readmeContent.toLowerCase().includes(feature.toLowerCase()),
                    `README.md must document Android feature '${feature}'`
                );
            });
        });
    });

    describe('5. Project Directory Structure', () => {
        test('Directory tree includes new test suites and modules', () => {
            assert.ok(readmeContent.includes('Project Directory Tree Structure'), 'Must have Directory Structure header');
            assert.ok(readmeContent.includes('tests/'), 'Must list tests directory');
            assert.ok(readmeContent.includes('readme_verification.test.js'), 'Must list readme_verification.test.js');
            assert.ok(readmeContent.includes('android_share.test.js'), 'Must list android_share.test.js');
            assert.ok(readmeContent.includes('python_queue.test.js'), 'Must list python_queue.test.js');
            assert.ok(readmeContent.includes('processor_steps.test.js'), 'Must list processor_steps.test.js');
            assert.ok(readmeContent.includes('server.js'), 'Must list server.js');
            assert.ok(readmeContent.includes('cleanup.js'), 'Must list cleanup.js');
            assert.ok(readmeContent.includes('processor.py'), 'Must list processor.py');
            assert.ok(readmeContent.includes('android_app/'), 'Must list android_app directory');
        });
    });
});
