import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { test } from 'node:test';
import { crc32, deflateSync } from 'node:zlib';
import { createEditorServer, readConfig } from '../server.mjs';

const config = readConfig({
  IMAGE_EDIT_BASE_URL: 'https://provider.example/v1/',
  IMAGE_EDIT_MODEL: 'test-model',
  IMAGE_EDIT_API_KEY: 'test-secret',
});

function png(width, height, alpha) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const pixels = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) pixels[y * (1 + width * 4) + 4 + x * 4] = alpha;
  }
  const chunk = (type, data) => {
    const content = Buffer.concat([Buffer.from(type), data]);
    const result = Buffer.alloc(data.length + 12);
    result.writeUInt32BE(data.length);
    content.copy(result, 4);
    result.writeUInt32BE(crc32(content), result.length - 4);
    return result;
  };
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const image = png(1024, 1024, 255);
const mask = png(1024, 1024, 0);
const payload = {
  image: image.toString('base64'),
  mask: mask.toString('base64'),
  prompt: '替换天空',
  endpoint: config.endpoint,
  model: config.model,
};

async function start(t, mock, settings = config) {
  const server = createEditorServer(settings, mock);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    return new Promise((done) => server.close(done));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    edit: (body = payload, options = {}) => fetch(`${origin}/api/image-edits`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', origin, ...options.headers },
      signal: options.signal,
    }),
  };
}

test('serves the editor and forwards only the confirmed image edit to the configured endpoint', async (t) => {
  const { origin, edit } = await start(t, async (url, options) => {
    assert.equal(url, 'https://provider.example/v1/images/edits');
    assert.equal(options.headers.Authorization, 'Bearer test-secret');
    assert.equal(options.redirect, 'error');
    assert.equal(options.method, 'POST');
    assert.deepEqual([...options.body.keys()].sort(), ['image[]', 'mask', 'model', 'output_format', 'prompt', 'size']);
    assert.deepEqual(Buffer.from(await options.body.get('image[]').arrayBuffer()), image);
    assert.deepEqual(Buffer.from(await options.body.get('mask').arrayBuffer()), mask);
    assert.equal(options.body.get('prompt'), payload.prompt);
    assert.equal(options.body.get('size'), '1024x1024');
    return Response.json({ data: [{ b64_json: payload.image }] });
  });
  const settings = await (await fetch(origin + '/api/image-edits/config')).json();
  assert.deepEqual(settings, { configured: true, endpoint: config.endpoint, model: config.model });
  const page = await fetch(origin);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /id="maskOverlay"/);
  assert.equal((await fetch(origin + '/server.mjs')).status, 404);
  const result = await edit();
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('Content-Type'), 'image/png');
  assert.deepEqual(Buffer.from(await result.arrayBuffer()), image);
});

test('rejects cross-origin, stale destinations, oversized and malformed requests before forwarding', async (t) => {
  let forwarded = 0;
  const { origin, edit } = await start(t, () => { forwarded++; });
  const cases = [
    [403, payload, { headers: { origin: 'https://unrelated.example' } }],
    [409, { ...payload, endpoint: 'https://unrelated.example/images/edits' }],
    [400, { ...payload, prompt: ' ' }],
    [400, { ...payload, mask: 'invalid' }],
    [400, { ...payload, mask: png(1, 1, 0).toString('base64') }],
  ];
  for (const [expected, body, options] of cases) {
    const response = await edit(body, options);
    assert.equal(response.status, expected);
    assert.equal(typeof (await response.json()).error, 'string');
  }
  const oversizedStatus = await new Promise((resolve, reject) => {
    const req = request(origin + '/api/image-edits', {
      method: 'POST',
      headers: { origin, 'Content-Type': 'application/json', 'Content-Length': 20 * 1024 * 1024 },
    }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.flushHeaders();
  });
  assert.equal(oversizedStatus, 413);
  assert.equal(forwarded, 0);
});

test('handles an unconfigured proxy and sanitizes upstream errors and invalid results', async (t) => {
  const offline = await start(t, () => assert.fail('no provider expected'), {});
  assert.equal((await offline.edit()).status, 503);
  const responses = [
    new Response('test-secret', { status: 401 }),
    new Response('test-secret', { status: 429 }),
    Response.json({ data: [{ url: 'https://unrelated.example/result.png' }] }),
    Response.json({ data: [{ b64_json: png(1, 1, 255).toString('base64') }] }),
  ];
  const { edit } = await start(t, () => responses.shift());
  for (const [code, pattern] of [[502, /鉴权/], [429, /限流/], [502, /PNG/], [502, /尺寸/]]) {
    const response = await edit();
    assert.equal(response.status, code);
    const { error } = await response.json();
    assert.match(error, pattern);
    assert.doesNotMatch(error, /test-secret/);
  }
});

test('aborts the upstream request when the browser disconnects', { timeout: 5000 }, async (t) => {
  const upstreamStarted = Promise.withResolvers();
  const upstreamCancelled = Promise.withResolvers();
  const { edit } = await start(t, (_url, { signal }) => {
    upstreamStarted.resolve();
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        upstreamCancelled.resolve();
        reject(signal.reason);
      }, { once: true });
    });
  });
  const controller = new AbortController();
  const rejected = assert.rejects(edit(payload, { signal: controller.signal }), { name: 'AbortError' });
  await upstreamStarted.promise;
  controller.abort();
  await rejected;
  await upstreamCancelled.promise;
});
