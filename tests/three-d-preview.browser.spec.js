import { test, expect } from '@playwright/test';

test('Three.js preview initializes in Chromium', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));

  const baseUrl = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:8080';
  await page.goto(`${baseUrl}/static/index.html`);
  await page.waitForFunction(() => typeof window.THREE !== 'undefined', null, { timeout: 20000 });

  const webglSupported = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    return Boolean(canvas.getContext('webgl') || canvas.getContext('experimental-webgl'));
  });
  expect(webglSupported).toBeTruthy();

  await expect(page.locator('#threeDContainer')).toHaveCount(1);
  await expect(page.locator('#threeDCanvas')).toHaveCount(1);
  await expect(page.locator('#threeDPreviewBtn')).toContainText('3D Preview');

  await page.locator('#threeDPreviewBtn').click();
  await expect(page.locator('#threeDContainer')).toBeVisible();

  const canvasReady = await page.evaluate(() => {
    const canvas = document.getElementById('threeDCanvas');
    return Boolean(canvas && canvas.width > 0 && canvas.height > 0);
  });
  expect(canvasReady).toBeTruthy();

  expect(pageErrors).toEqual([]);
});
