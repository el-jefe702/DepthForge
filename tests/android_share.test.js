import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

describe('Feature F19 (Android Share Intent) - Unit & Integration Tests', () => {

    const mainActivityPath = path.join(
        rootDir,
        'android_app',
        'app',
        'src',
        'main',
        'kotlin',
        'com',
        'depthforge',
        'app',
        'MainActivity.kt'
    );
    const manifestPath = path.join(
        rootDir,
        'android_app',
        'app',
        'src',
        'main',
        'AndroidManifest.xml'
    );
    const filePathsXmlPath = path.join(
        rootDir,
        'android_app',
        'app',
        'src',
        'main',
        'res',
        'xml',
        'file_paths.xml'
    );

    const mainActivityContent = fs.readFileSync(mainActivityPath, 'utf-8');
    const manifestContent = fs.readFileSync(manifestPath, 'utf-8');
    const filePathsContent = fs.existsSync(filePathsXmlPath)
        ? fs.readFileSync(filePathsXmlPath, 'utf-8')
        : '';

    describe('1. FileProvider & Manifest Configuration', () => {
        test('AndroidManifest.xml registers androidx.core.content.FileProvider', () => {
            assert.ok(
                manifestContent.includes('androidx.core.content.FileProvider'),
                'AndroidManifest.xml must declare androidx.core.content.FileProvider'
            );
        });

        test('FileProvider defines authorities with applicationId and exported=false', () => {
            assert.ok(
                manifestContent.includes('android:authorities="${applicationId}.fileprovider"'),
                'FileProvider authorities must be ${applicationId}.fileprovider'
            );
            assert.ok(
                manifestContent.includes('android:exported="false"'),
                'FileProvider must have exported="false" for security'
            );
            assert.ok(
                manifestContent.includes('android:grantUriPermissions="true"'),
                'FileProvider must allow granting URI permissions'
            );
        });

        test('FileProvider links to @xml/file_paths meta-data', () => {
            assert.ok(
                manifestContent.includes('android:name="android.support.FILE_PROVIDER_PATHS"'),
                'FileProvider must specify FILE_PROVIDER_PATHS metadata'
            );
            assert.ok(
                manifestContent.includes('android:resource="@xml/file_paths"'),
                'FileProvider metadata resource must point to @xml/file_paths'
            );
        });

        test('res/xml/file_paths.xml exists and defines cache-path for sharing', () => {
            assert.ok(fs.existsSync(filePathsXmlPath), 'file_paths.xml must exist');
            assert.ok(
                filePathsContent.includes('<cache-path'),
                'file_paths.xml must include a cache-path element'
            );
            assert.ok(
                filePathsContent.includes('name="shared_images"'),
                'file_paths.xml cache-path should have a descriptive name'
            );
            assert.ok(
                filePathsContent.includes('path="share/"') || filePathsContent.includes('path="share"'),
                'file_paths.xml cache-path must map to share directory'
            );
        });
    });

    describe('2. MainActivity.kt Imports and shareDepthMap Implementation', () => {
        test('MainActivity.kt imports Intent and FileProvider', () => {
            assert.ok(
                mainActivityContent.includes('import android.content.Intent'),
                'MainActivity.kt must import android.content.Intent'
            );
            assert.ok(
                mainActivityContent.includes('import androidx.core.content.FileProvider'),
                'MainActivity.kt must import androidx.core.content.FileProvider'
            );
        });

        test('MainActivity.kt declares shareDepthMap(context: Context, bitmap: Bitmap)', () => {
            assert.ok(
                mainActivityContent.includes('fun shareDepthMap(context: Context, bitmap: Bitmap)'),
                'MainActivity.kt must define fun shareDepthMap(context: Context, bitmap: Bitmap)'
            );
        });

        test('shareDepthMap saves bitmap to cacheDir/share with timestamped PNG filename', () => {
            assert.ok(
                mainActivityContent.includes('File(context.cacheDir, "share")'),
                'shareDepthMap must use cacheDir/share directory'
            );
            assert.ok(
                mainActivityContent.includes('depth_share_') && mainActivityContent.includes('.png'),
                'shareDepthMap must save with depth_share_<timestamp>.png naming'
            );
            assert.ok(
                mainActivityContent.includes('bitmap.compress(Bitmap.CompressFormat.PNG'),
                'shareDepthMap must compress bitmap as PNG'
            );
        });

        test('shareDepthMap generates FileProvider content URI', () => {
            assert.ok(
                mainActivityContent.includes('FileProvider.getUriForFile'),
                'shareDepthMap must obtain URI using FileProvider.getUriForFile'
            );
            assert.ok(
                mainActivityContent.includes('fileprovider'),
                'shareDepthMap must use .fileprovider authority'
            );
        });

        test('shareDepthMap configures Intent.ACTION_SEND, MIME type, and read permissions', () => {
            assert.ok(
                mainActivityContent.includes('Intent(Intent.ACTION_SEND)'),
                'Intent must use Intent.ACTION_SEND'
            );
            assert.ok(
                mainActivityContent.includes('type = "image/png"'),
                'Intent type must be image/png'
            );
            assert.ok(
                mainActivityContent.includes('putExtra(Intent.EXTRA_STREAM, contentUri)'),
                'Intent must put EXTRA_STREAM with the content URI'
            );
            assert.ok(
                mainActivityContent.includes('Intent.FLAG_GRANT_READ_URI_PERMISSION'),
                'Intent must grant read URI permission flag'
            );
        });

        test('shareDepthMap creates chooser with "Share Depth Map" and launches activity', () => {
            assert.ok(
                mainActivityContent.includes('Intent.createChooser('),
                'shareDepthMap must use Intent.createChooser'
            );
            assert.ok(
                mainActivityContent.includes('"Share Depth Map"'),
                'Chooser title must be "Share Depth Map"'
            );
            assert.ok(
                mainActivityContent.includes('context.startActivity('),
                'shareDepthMap must launch chooser with context.startActivity'
            );
        });
    });

    describe('3. Action Button Row UI & State Management', () => {
        test('Action buttons include Share button with Text("Share")', () => {
            assert.ok(
                mainActivityContent.includes('Text("Share")'),
                'MainActivity.kt must include Share button label'
            );
            assert.ok(
                mainActivityContent.includes('Text("Download")'),
                'MainActivity.kt must retain Download button label'
            );
        });

        test('Share button is placed next to Download button in action buttons row', () => {
            const downloadIdx = mainActivityContent.indexOf('Text("Download")');
            const shareIdx = mainActivityContent.indexOf('Text("Share")');
            assert.ok(downloadIdx !== -1, 'Download button must exist');
            assert.ok(shareIdx !== -1, 'Share button must exist');
            // Check they are in close proximity in the action buttons layout
            assert.ok(
                Math.abs(downloadIdx - shareIdx) < 2000,
                'Share and Download buttons must be positioned adjacent in the action buttons layout'
            );
        });

        test('Share button is enabled only when !isBusy && currentBitmap != null', () => {
            const shareBlock = mainActivityContent.substring(
                mainActivityContent.indexOf('Text("Share")') - 300,
                mainActivityContent.indexOf('Text("Share")') + 50
            );
            assert.ok(
                shareBlock.includes('enabled = !isBusy && currentBitmap != null'),
                'Share button enabled condition must check !isBusy && currentBitmap != null'
            );
        });

        test('Share button invokes shareDepthMap within coroutine with error handling', () => {
            assert.ok(
                mainActivityContent.includes('shareDepthMap(context, bitmap)'),
                'Share button click handler must call shareDepthMap'
            );
            assert.ok(
                mainActivityContent.includes('Failed to share'),
                'Share button click handler must handle exceptions with a snackbar'
            );
        });
    });

    describe('4. State Transition and Multi-Feature Compatibility Simulation', () => {
        // Model the state machine of currentBitmap, isBusy, isGenerating, isPolished, bgRemoved
        function createSimulator() {
            let state = {
                currentBitmap: null,
                currentImageUrl: '',
                isBusy: false,
                isGenerating: false,
                isPolishing: false,
                isInverting: false,
                isRemovingBg: false,
                isPolished: false,
                bgRemoved: false
            };

            return {
                getState: () => ({ ...state }),
                setBusy: (busy) => { state.isBusy = busy; },
                generateSuccess: (url, bmp) => {
                    state.currentImageUrl = url;
                    state.currentBitmap = bmp;
                    state.isBusy = false;
                    state.isGenerating = false;
                },
                polishSuccess: (url, bmp) => {
                    state.currentImageUrl = url;
                    state.currentBitmap = bmp;
                    state.isPolished = true;
                    state.isBusy = false;
                    state.isPolishing = false;
                },
                invertSuccess: (url, bmp) => {
                    state.currentImageUrl = url;
                    state.currentBitmap = bmp;
                    state.isBusy = false;
                    state.isInverting = false;
                },
                removeBgSuccess: (url, bmp) => {
                    state.currentImageUrl = url;
                    state.currentBitmap = bmp;
                    state.bgRemoved = true;
                    state.isBusy = false;
                    state.isRemovingBg = false;
                },
                discard: () => {
                    state.currentBitmap = null;
                    state.currentImageUrl = '';
                    state.isPolished = false;
                    state.bgRemoved = false;
                },
                isShareEnabled: () => {
                    return !state.isBusy && state.currentBitmap !== null;
                },
                isShareVisible: () => {
                    return state.currentImageUrl.length > 0 && !state.isGenerating && !state.isPolishing;
                }
            };
        }

        test('Share button is hidden and disabled initially before any image is generated', () => {
            const sim = createSimulator();
            assert.equal(sim.isShareVisible(), false);
            assert.equal(sim.isShareEnabled(), false);
        });

        test('Share button is enabled and visible after initial map generation', () => {
            const sim = createSimulator();
            sim.generateSuccess('http://localhost:8000/static/generated/map1.png', { width: 512, height: 512 });
            assert.equal(sim.isShareVisible(), true);
            assert.equal(sim.isShareEnabled(), true);
        });

        test('Share button is disabled while busy (e.g. inverting or removing bg)', () => {
            const sim = createSimulator();
            sim.generateSuccess('http://localhost:8000/static/generated/map1.png', { width: 512, height: 512 });
            sim.setBusy(true);
            assert.equal(sim.isShareEnabled(), false);
            sim.setBusy(false);
            assert.equal(sim.isShareEnabled(), true);
        });

        test('Share button works seamlessly across Polish, Invert, and Remove BG workflows', () => {
            const sim = createSimulator();
            // 1. Generate
            sim.generateSuccess('/static/gen1.png', { id: 'orig' });
            assert.equal(sim.isShareEnabled(), true);

            // 2. Polish
            sim.polishSuccess('/static/polish1.png', { id: 'polished' });
            assert.equal(sim.isShareEnabled(), true);

            // 3. Invert
            sim.invertSuccess('/static/invert1.png', { id: 'inverted' });
            assert.equal(sim.isShareEnabled(), true);

            // 4. Remove BG
            sim.removeBgSuccess('/static/nobg1.png', { id: 'nobg' });
            assert.equal(sim.isShareEnabled(), true);
            assert.equal(sim.getState().currentBitmap.id, 'nobg');

            // 5. Discard
            sim.discard();
            assert.equal(sim.isShareVisible(), false);
            assert.equal(sim.isShareEnabled(), false);
        });
    });
});
