import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { createEditorServer } from '../server.mjs';

const playwrightModule = process.env.LUMA_PLAYWRIGHT_PATH;

test('local AI round trip preserves pixels outside the mask and applies only confirmed results', {
  skip: !playwrightModule && 'Set LUMA_PLAYWRIGHT_PATH to playwright-core/index.mjs to run the Chrome test',
  timeout: 45_000,
}, async (t) => {
  const { chromium } = await import(pathToFileURL(playwrightModule).href);
  let providerImage;
  let requests = 0;
  let requestMask;
  const upstreamStarted = Promise.withResolvers();
  const upstreamCancelled = Promise.withResolvers();
  const server = createEditorServer({
    endpoint: 'https://provider.example/v1/images/edits', model: 'fixture', key: 'test-key',
  }, async (_endpoint, { body, signal }) => {
    requests++;
    if (requests === 1) {
      await new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          upstreamCancelled.resolve();
          reject(signal.reason);
        }, { once: true });
        upstreamStarted.resolve();
      });
    }
    if (requests === 2) return new Response(null, { status: 429 });
    requestMask = Buffer.from(await body.get('mask').arrayBuffer()).toString('base64');
    return Response.json({ data: [{ b64_json: providerImage }] });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    return new Promise((done) => server.close(done));
  });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const solidPng = (size, color) => page.evaluate(({ size, color }) => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, size, size);
    return canvas.toDataURL().split(',')[1];
  }, { size, color });
  providerImage = await solidPng(1024, '#6414c8');
  const original = await solidPng(1200, '#204060');
  await page.locator('#fileInput').setInputFiles({
    name: 'synthetic.png', mimeType: 'image/png', buffer: Buffer.from(original, 'base64'),
  });
  await page.locator('[data-tool="ai"]').click();
  await page.locator('#generateEdit:enabled').waitFor();
  await page.locator('[data-mask-tool="rectangle"]').click();
  const overlay = await page.locator('#maskOverlay').boundingBox();
  assert.ok(overlay);
  const position = (x, y) => [overlay.x + overlay.width * x, overlay.y + overlay.height * y];
  await page.mouse.move(...position(0.25, 0.25));
  await page.mouse.down();
  await page.mouse.move(...position(0.75, 0.75), { steps: 8 });
  await page.mouse.up();
  await page.locator('[data-mask-tool="brush"]').click();
  await page.mouse.click(...position(0.12, 0.5));
  await page.locator('[data-mask-tool="erase"]').click();
  await page.mouse.click(...position(0.4, 0.4));
  await page.locator('[data-mask-tool="lasso"]').click();
  await page.mouse.move(...position(0.82, 0.35));
  await page.mouse.down();
  await page.mouse.move(...position(0.94, 0.35));
  await page.mouse.move(...position(0.88, 0.55));
  await page.mouse.up();
  await page.locator('#aiPrompt').fill('合成测试');
  await page.locator('#generateEdit').click();
  await upstreamStarted.promise;
  await page.locator('#cancelEdit').click();
  await upstreamCancelled.promise;
  await page.waitForFunction(() => document.querySelector('#aiStatus').textContent.includes('已取消'));

  await page.locator('#generateEdit').click();
  await page.locator('#retryEdit').waitFor();
  await page.locator('#retryEdit').click();
  await page.locator('#applyEdit').waitFor();
  const originalColor = [32, 64, 96, 255];
  const generatedColor = [100, 20, 200, 255];
  const pixel = (x, y) => page.evaluate(([x, y]) =>
    Array.from(document.querySelector('#editorCanvas').getContext('2d').getImageData(x, y, 1, 1).data), [x, y]);
  const waitColor = (color) => page.waitForFunction((color) =>
    document.querySelector('#editorCanvas').getContext('2d').getImageData(600, 600, 1, 1).data.every((v, i) => v === color[i]), color);
  await waitColor(generatedColor);
  assert.deepEqual(await pixel(50, 50), originalColor);
  assert.deepEqual(await pixel(144, 600), generatedColor);
  assert.deepEqual(await pixel(480, 480), originalColor);
  assert.deepEqual(await pixel(1056, 492), generatedColor);
  const feathered = await pixel(300, 600);
  assert.ok(feathered[0] > originalColor[0] && feathered[0] < generatedColor[0]);
  const sampledMask = await page.evaluate(async (encoded) => {
    const image = await createImageBitmap(new Blob([Uint8Array.from(atob(encoded), (ch) => ch.charCodeAt(0))], { type: 'image/png' }));
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1024;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    return [ctx.getImageData(512, 512, 1, 1).data[3], ctx.getImageData(10, 10, 1, 1).data[3]];
  }, requestMask);
  assert.deepEqual(sampledMask, [0, 255]);
  await page.locator('#compareEdit').click();
  await waitColor(originalColor);
  await page.locator('#discardEdit').click();
  assert.deepEqual(await pixel(600, 600), originalColor);
  await page.locator('.ai-history summary').click();
  await page.locator('#aiHistory button').click();
  await page.locator('#applyEdit').click();
  await waitColor(generatedColor);
  await page.locator('#aiPrompt').focus();
  await page.keyboard.press('Control+z');
  assert.deepEqual(await pixel(600, 600), generatedColor);
  await page.locator('#undoButton').click();
  await waitColor(originalColor);
  await page.locator('#redoButton').click();
  await waitColor(generatedColor);
  const downloadReady = page.waitForEvent('download');
  await page.locator('#exportButton').click();
  const png = await readFile(await (await downloadReady).path());
  const exported = await page.evaluate(async (encoded) => {
    const image = await createImageBitmap(new Blob([Uint8Array.from(atob(encoded), (ch) => ch.charCodeAt(0))], { type: 'image/png' }));
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    const sample = (point) => Array.from(ctx.getImageData(point, point, 1, 1).data);
    return [image.width, image.height, sample(50), sample(600)];
  }, png.toString('base64'));
  assert.deepEqual(exported, [1200, 1200, originalColor, generatedColor]);
  assert.equal(requests, 3);
  assert.deepEqual(errors, []);
});
