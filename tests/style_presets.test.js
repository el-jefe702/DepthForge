import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import {
    STYLE_PRESETS,
    sanitizeStylePreset,
    getStyleGuidance,
    buildImprovePrompt
} from '../server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

describe('Style Presets (F12) - Unit & Integration Tests', () => {

    const webHtml = fs.readFileSync(path.join(rootDir, 'static', 'index.html'), 'utf-8');
    const androidHtml = fs.readFileSync(path.join(rootDir, 'android_app', 'app', 'src', 'main', 'assets', 'index.html'), 'utf-8');
    const webCss = fs.readFileSync(path.join(rootDir, 'static', 'style.css'), 'utf-8');
    const androidCss = fs.readFileSync(path.join(rootDir, 'android_app', 'app', 'src', 'main', 'assets', 'style.css'), 'utf-8');
    const androidStaticCss = fs.readFileSync(path.join(rootDir, 'android_app', 'app', 'src', 'main', 'assets', 'static', 'style.css'), 'utf-8');
    const mainActivity = fs.readFileSync(path.join(rootDir, 'android_app', 'app', 'src', 'main', 'kotlin', 'com', 'depthforge', 'app', 'MainActivity.kt'), 'utf-8');
    const apiClient = fs.readFileSync(path.join(rootDir, 'android_app', 'app', 'src', 'main', 'kotlin', 'com', 'depthforge', 'app', 'ApiClient.kt'), 'utf-8');

    describe('1. Server Architecture & Style Presets Definition', () => {
        test('STYLE_PRESETS contains all 15 required presets', () => {
            const keys = Object.keys(STYLE_PRESETS);
            const expected = [
                'portrait', 'wildlife', 'ornamental', 'floral', 'architecture', 'abstract',
                'coin_medallion', 'heraldic_crest', 'celtic_knot', 'western_scroll',
                'signs_plaques', 'address_plaque', 'rustic_sign', 'tavern_sign', 'commercial_sign'
            ];
            assert.deepEqual(keys.sort(), expected.sort());
            assert.equal(keys.length, 15);
        });

        test('each preset defines id, label, icon, and specific CNC guidance', () => {
            for (const [key, preset] of Object.entries(STYLE_PRESETS)) {
                assert.equal(preset.id, key);
                assert.ok(typeof preset.label === 'string' && preset.label.length > 0);
                assert.ok(typeof preset.icon === 'string' && preset.icon.length > 0);
                assert.ok(typeof preset.guidance === 'string' && preset.guidance.includes('STYLE:'));
            }
        });

        test('sanitizeStylePreset accepts valid preset keys (case and whitespace insensitive)', () => {
            assert.equal(sanitizeStylePreset('portrait'), 'portrait');
            assert.equal(sanitizeStylePreset('Portrait'), 'portrait');
            assert.equal(sanitizeStylePreset(' WILDLIFE '), 'wildlife');
            assert.equal(sanitizeStylePreset('ornamental'), 'ornamental');
            assert.equal(sanitizeStylePreset('floral'), 'floral');
            assert.equal(sanitizeStylePreset('architecture'), 'architecture');
            assert.equal(sanitizeStylePreset('abstract'), 'abstract');
            assert.equal(sanitizeStylePreset('coin_medallion'), 'coin_medallion');
            assert.equal(sanitizeStylePreset('heraldic_crest'), 'heraldic_crest');
            assert.equal(sanitizeStylePreset('celtic_knot'), 'celtic_knot');
            assert.equal(sanitizeStylePreset('western_scroll'), 'western_scroll');
            assert.equal(sanitizeStylePreset('signs_plaques'), 'signs_plaques');
            assert.equal(sanitizeStylePreset('address_plaque'), 'address_plaque');
            assert.equal(sanitizeStylePreset('rustic_sign'), 'rustic_sign');
            assert.equal(sanitizeStylePreset('tavern_sign'), 'tavern_sign');
            assert.equal(sanitizeStylePreset('commercial_sign'), 'commercial_sign');
        });

        test('sanitizeStylePreset rejects invalid or empty presets cleanly', () => {
            assert.equal(sanitizeStylePreset(''), null);
            assert.equal(sanitizeStylePreset('   '), null);
            assert.equal(sanitizeStylePreset('cyberpunk'), null);
            assert.equal(sanitizeStylePreset(null), null);
            assert.equal(sanitizeStylePreset(undefined), null);
            assert.equal(sanitizeStylePreset(123), null);
            assert.equal(sanitizeStylePreset({}), null);
        });

        test('getStyleGuidance returns matching guidance or empty string', () => {
            assert.ok(getStyleGuidance('portrait').includes('Portraiture relief carving'));
            assert.ok(getStyleGuidance('ornamental').includes('baroque scrollwork'));
            assert.equal(getStyleGuidance('unknown'), '');
            assert.equal(getStyleGuidance(null), '');
        });

        test('buildImprovePrompt incorporates style guidance when preset provided', () => {
            const promptWithStyle = buildImprovePrompt('eagle in flight', 'wildlife');
            assert.ok(promptWithStyle.includes('User Idea: eagle in flight'));
            assert.ok(promptWithStyle.includes('STYLE: Wildlife and animal relief carving'));
            assert.ok(promptWithStyle.includes("Output in JSON format with key 'improved_prompt'."));

            const promptWithoutStyle = buildImprovePrompt('eagle in flight', null);
            assert.ok(promptWithoutStyle.includes('User Idea: eagle in flight'));
            assert.ok(!promptWithoutStyle.includes('STYLE:'));
        });
    });

    describe('2. Web UI & Assets Parity', () => {
        test('index.html is identical byte-for-byte between static/ and android assets', () => {
            assert.equal(webHtml, androidHtml);
        });

        test('style.css is identical byte-for-byte between static/ and android assets', () => {
            assert.equal(webCss, androidCss);
            assert.equal(webCss, androidStaticCss);
        });

        test('HTML contains style presets container and all 15 preset buttons across primary and subpreset rows', () => {
            assert.ok(webHtml.includes('id="textStylePresets"'));
            assert.ok(webHtml.includes('data-preset="portrait"'));
            assert.ok(webHtml.includes('data-preset="wildlife"'));
            assert.ok(webHtml.includes('data-preset="ornamental"'));
            assert.ok(webHtml.includes('data-preset="floral"'));
            assert.ok(webHtml.includes('data-preset="architecture"'));
            assert.ok(webHtml.includes('data-preset="abstract"'));
            assert.ok(webHtml.includes('data-preset="coin_medallion"'));
            assert.ok(webHtml.includes('data-preset="heraldic_crest"'));
            assert.ok(webHtml.includes('data-preset="celtic_knot"'));
            assert.ok(webHtml.includes('data-preset="western_scroll"'));
            assert.ok(webHtml.includes('data-preset="signs_plaques"'));
            assert.ok(webHtml.includes('data-preset="address_plaque"'));
            assert.ok(webHtml.includes('data-preset="rustic_sign"'));
            assert.ok(webHtml.includes('data-preset="tavern_sign"'));
            assert.ok(webHtml.includes('data-preset="commercial_sign"'));
        });

        test('HTML contains style presets container in photoPanel', () => {
            assert.ok(webHtml.includes('id="photoStylePresets"'));
            assert.ok(webHtml.includes('id="photoSignsParentChip"'));
            assert.ok(webHtml.includes('id="photoSignSubpresets"'));
        });

        test('CSS defines .style-presets-row, .preset-chip, .style-subpresets-row, and .subpreset-chip', () => {
            assert.ok(webCss.includes('.style-presets-container'));
            assert.ok(webCss.includes('.style-presets-row'));
            assert.ok(webCss.includes('.preset-chip'));
            assert.ok(webCss.includes('.preset-chip.active'));
            assert.ok(webCss.includes('.style-subpresets-row'));
            assert.ok(webCss.includes('.subpreset-chip'));
        });
    });

    describe('3. Client-Side JavaScript Logic & State Management', () => {
        // Extract script code from index.html
        const scriptBlocks = Array.from(webHtml.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/gi));
        assert.ok(scriptBlocks.length > 0);
        const scriptCode = scriptBlocks.map(m => m[1]).join('\n');

        test('JS defines activeStylePreset state and selectStylePreset function', () => {
            assert.ok(scriptCode.includes('let activeStylePreset = null'));
            assert.ok(scriptCode.includes('function selectStylePreset('));
            assert.ok(scriptCode.includes('function updateStylePresetUI('));
        });

        test('Simulation: toggling style preset in mock DOM', () => {
            const chips = [
                { preset: 'portrait', classes: new Set(), attrs: {}, getAttribute: function(a) { return this.preset; }, setAttribute: function(k, v) { this.attrs[k] = v; }, classList: { toggle: function(c, v) { if (v) chips[0].classes.add(c); else chips[0].classes.delete(c); } } },
                { preset: 'wildlife', classes: new Set(), attrs: {}, getAttribute: function(a) { return this.preset; }, setAttribute: function(k, v) { this.attrs[k] = v; }, classList: { toggle: function(c, v) { if (v) chips[1].classes.add(c); else chips[1].classes.delete(c); } } }
            ];

            const mockContext = {
                activeStylePreset: null,
                isProcessing: () => false,
                document: {
                    querySelectorAll: () => chips
                }
            };

            const toggleCode = `
                function selectStylePreset(presetName) {
                    if (isProcessing()) return;
                    if (activeStylePreset === presetName) {
                        activeStylePreset = null;
                    } else {
                        activeStylePreset = presetName;
                    }
                    updateStylePresetUI();
                }

                function updateStylePresetUI() {
                    const allChips = document.querySelectorAll('.preset-chip');
                    allChips.forEach(chip => {
                        const preset = chip.getAttribute('data-preset');
                        const isActive = activeStylePreset === preset;
                        chip.classList.toggle('active', isActive);
                        chip.setAttribute('aria-pressed', isActive ? 'true' : 'false');
                    });
                }
            `;

            vm.createContext(mockContext);
            vm.runInContext(toggleCode, mockContext);

            // Initially null
            assert.equal(mockContext.activeStylePreset, null);

            // Select portrait
            mockContext.selectStylePreset('portrait');
            assert.equal(mockContext.activeStylePreset, 'portrait');
            assert.ok(chips[0].classes.has('active'));
            assert.equal(chips[0].attrs['aria-pressed'], 'true');
            assert.ok(!chips[1].classes.has('active'));

            // Click portrait again -> deselects
            mockContext.selectStylePreset('portrait');
            assert.equal(mockContext.activeStylePreset, null);
            assert.ok(!chips[0].classes.has('active'));
            assert.equal(chips[0].attrs['aria-pressed'], 'false');

            // Select wildlife
            mockContext.selectStylePreset('wildlife');
            assert.equal(mockContext.activeStylePreset, 'wildlife');
            assert.ok(chips[1].classes.has('active'));
        });

        test('generateMap and convertPhoto pass style_preset in payload', () => {
            assert.ok(webHtml.includes('style_preset: activeStylePreset'));
            assert.ok(webHtml.includes("formData.append('style_preset', activeStylePreset)"));
        });
    });

    describe('4. Android Native UI & ApiClient Integration', () => {
        test('ApiClient.kt generate method accepts stylePreset parameter', () => {
            assert.ok(apiClient.includes('stylePreset: String? = null'));
            assert.ok(apiClient.includes('put("style_preset", stylePreset)'));
            assert.ok(apiClient.includes('put("stylePreset", stylePreset)'));
        });

        test('ApiClient.kt photoToDepth method accepts stylePreset parameter', () => {
            assert.ok(apiClient.includes('photoToDepth('));
            assert.ok(apiClient.includes('stylePreset: String? = null'));
            assert.ok(apiClient.includes('params["style_preset"] = stylePreset'));
        });

        test('MainActivity.kt defines StylePresetSelector composable with presets and subpresets', () => {
            assert.ok(mainActivity.includes('fun StylePresetSelector('));
            assert.ok(mainActivity.includes('"portrait" to "👤 Portrait"'));
            assert.ok(mainActivity.includes('"wildlife" to "🦁 Wildlife"'));
            assert.ok(mainActivity.includes('"ornamental" to "⚜️ Ornamental"'));
            assert.ok(mainActivity.includes('"floral" to "🌸 Floral"'));
            assert.ok(mainActivity.includes('"architecture" to "🏛️ Architecture"'));
            assert.ok(mainActivity.includes('"abstract" to "🌀 Abstract"'));
            assert.ok(mainActivity.includes('"coin_medallion" to "🪙 Coin & Medallion"'));
            assert.ok(mainActivity.includes('"heraldic_crest" to "🛡️ Heraldic Crest"'));
            assert.ok(mainActivity.includes('"celtic_knot" to "🪢 Celtic Knot"'));
            assert.ok(mainActivity.includes('"western_scroll" to "🤠 Western Scroll"'));
            assert.ok(mainActivity.includes('"signs_plaques" to "🪧 Signs & Plaques ▾"'));
            assert.ok(mainActivity.includes('"address_plaque" to "🏠 Address Plaque"'));
            assert.ok(mainActivity.includes('"rustic_sign" to "🪵 Cabin / Blank Banner"'));
            assert.ok(mainActivity.includes('"tavern_sign" to "🍺 Tavern & Shield"'));
            assert.ok(mainActivity.includes('"commercial_sign" to "🏢 Commercial 2.5D"'));
        });

        test('MainActivity.kt tracks selectedStylePreset state and renders selector in text and photo modes', () => {
            assert.ok(mainActivity.includes('var selectedStylePreset by remember { mutableStateOf<String?>(null) }'));
            assert.ok(mainActivity.includes('StylePresetSelector('));
            assert.ok(mainActivity.includes('selectedPreset = selectedStylePreset'));
            assert.ok(mainActivity.includes('stylePreset = selectedStylePreset'));
        });
    });
});
