import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { crc32 } from './png-crc.mjs';

const MAX_IMAGE = 10 * 1024 * 1024;
const MAX_MASK = 4 * 1024 * 1024;
const base64Limit = (bytes) => Math.ceil(bytes / 3) * 4;
const MAX_REQUEST = base64Limit(MAX_IMAGE) + base64Limit(MAX_MASK) + 32768;
const MAX_RESPONSE = base64Limit(MAX_IMAGE) + 65536;
const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');
const SIZES = new Set(['1024x1024', '1024x1536', '1536x1024']);
const STATIC = new Map([
  ['/', ['index.html', 'text/html']],
  ['/index.html', ['index.html', 'text/html']],
  ['/styles.css', ['styles.css', 'text/css']],
  ['/app.js', ['app.js', 'text/javascript']],
  ['/ai-editor.js', ['ai-editor.js', 'text/javascript']],
]);

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function readConfig(env = process.env) {
  const port = Number(env.PORT || 4173);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须为 1–65535。');
  const { IMAGE_EDIT_BASE_URL: base, IMAGE_EDIT_MODEL: model, IMAGE_EDIT_API_KEY: key } = env;
  if (!base && !model && !key) return { port };
  if (!base?.trim() || !model?.trim() || !key?.trim()) {
    throw new Error('请同时设置 IMAGE_EDIT_BASE_URL、IMAGE_EDIT_MODEL 和 IMAGE_EDIT_API_KEY。');
  }
  let endpoint;
  try { endpoint = new URL(base); } catch { throw new Error('IMAGE_EDIT_BASE_URL 必须是有效的 HTTPS 地址。'); }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('供应商地址必须是 HTTPS，且不得包含凭据、查询参数或片段。');
  }
  endpoint.pathname = endpoint.pathname.replace(/\/+$/, '') + '/images/edits';
  return { port, endpoint: endpoint.href, model: model.trim(), key: key.trim() };
}

async function readLimited(stream, limit, status, message) {
  const chunks = [];
  let length = 0;
  // Pausing the incoming HTTP stream on early exit lets the server return 413.
  const iterator = stream.iterator?.({ destroyOnReturn: false }) ?? stream;
  for await (const chunk of iterator) {
    length += chunk.length;
    if (length > limit) throw new RequestError(status, message);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
}

function hasCompletePngChunks(png) {
  let imageBytes = 0;
  let seenImageData = false;
  let imageDataEnded = false;
  for (let offset = PNG_SIGNATURE.length; png.length - offset >= 12;) {
    const length = png.readUInt32BE(offset);
    if (length > png.length - offset - 12) return false;
    const crcOffset = offset + 8 + length;
    const next = crcOffset + 4;
    const type = png.toString('latin1', offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) return false;
    if (crc32(png.subarray(offset + 4, crcOffset)) !== png.readUInt32BE(crcOffset)) return false;

    if (type === 'IHDR' && offset !== PNG_SIGNATURE.length) return false;
    if (type === 'IEND') return length === 0 && imageBytes > 0 && next === png.length;
    if (type === 'IDAT') {
      if (imageDataEnded) return false;
      seenImageData = true;
      imageBytes += length;
    } else if (seenImageData) {
      imageDataEnded = true;
    }
    offset = next;
  }
  return false;
}

function readPng(value, limit, status, message) {
  if (typeof value !== 'string' || !value || value.length > base64Limit(limit) ||
      value.length % 4 || /[^a-zA-Z0-9+/=]/.test(value)) {
    throw new RequestError(status, message);
  }
  const png = Buffer.from(value, 'base64');
  if (png.length < 33 || png.length > limit || png.toString('base64') !== value ||
      !png.subarray(0, 8).equals(PNG_SIGNATURE) || png.readUInt32BE(8) !== 13 ||
      png.toString('latin1', 12, 16) !== 'IHDR' || !hasCompletePngChunks(png)) {
    throw new RequestError(status, message);
  }
  return { png, size: `${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`, colorType: png[25] };
}

function providerError(status) {
  if (status === 401 || status === 403) return '供应商鉴权失败，请检查代理的密钥和模型权限。';
  if (status === 429) return '供应商限流或配额不足，请稍后重试或检查配额。';
  if (status === 400 || status === 413 || status === 422) return '供应商拒绝了编辑请求，请检查模型是否支持蒙版编辑，或调整提示词。';
  return '图片供应商暂时无法完成请求，请稍后重试。';
}

async function editImage(req, res, config, fetchProvider) {
  if (!config.endpoint) throw new RequestError(503, '本地代理尚未配置图片供应商。');
  if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
    throw new RequestError(415, '编辑请求必须使用 JSON。');
  }
  const tooLarge = '编辑请求过大，请使用较小的图片。';
  if (Number(req.headers['content-length']) > MAX_REQUEST) throw new RequestError(413, tooLarge);
  const bytes = await readLimited(req, MAX_REQUEST, 413, tooLarge);
  let input;
  try { input = JSON.parse(bytes.toString('utf8')); } catch { throw new RequestError(400, '编辑请求格式无效。'); }
  if (input?.endpoint !== config.endpoint || input?.model !== config.model) {
    throw new RequestError(409, '供应商配置已变更，请确认当前显示的地址后重新生成。');
  }
  const prompt = typeof input?.prompt === 'string' ? input.prompt.trim() : '';
  if (!prompt || prompt.length > 2000) throw new RequestError(400, '请输入 1–2000 个字符的编辑指令。');
  const image = readPng(input.image, MAX_IMAGE, 400, '原图必须是有效的 PNG。');
  const mask = readPng(input.mask, MAX_MASK, 400, '蒙版必须是有效的 PNG。');
  if (!SIZES.has(image.size) || image.size !== mask.size || ![4, 6].includes(mask.colorType)) {
    throw new RequestError(400, '原图尺寸不受支持，或蒙版尺寸/透明通道不匹配。');
  }

  const body = new FormData();
  body.set('image[]', new Blob([image.png], { type: 'image/png' }), 'image.png');
  body.set('mask', new Blob([mask.png], { type: 'image/png' }), 'mask.png');
  body.set('model', config.model);
  body.set('prompt', prompt);
  body.set('size', image.size);
  body.set('output_format', 'png');
  const controller = new AbortController();
  const disconnect = () => { if (!res.writableEnded) controller.abort(); };
  res.once('close', disconnect);
  const timeout = AbortSignal.timeout(120_000);
  const signal = AbortSignal.any([controller.signal, timeout]);
  try {
    if (res.destroyed) return;
    const upstream = await fetchProvider(config.endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.key}` },
      body,
      signal,
      redirect: 'error',
    });
    if (!upstream.ok) {
      await upstream.body?.cancel();
      throw new RequestError(upstream.status === 429 ? 429 : 502, providerError(upstream.status));
    }
    const invalid = '供应商返回的 PNG 无效或尺寸与请求不一致。';
    if (!upstream.body) throw new RequestError(502, invalid);
    const resultBytes = await readLimited(upstream.body, MAX_RESPONSE, 502, invalid);
    let result;
    try { result = JSON.parse(resultBytes.toString('utf8')); } catch { throw new RequestError(502, invalid); }
    const output = readPng(result?.data?.[0]?.b64_json, MAX_IMAGE, 502, invalid);
    if (output.size !== image.size) throw new RequestError(502, invalid);
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': output.png.length });
    res.end(output.png);
  } catch (error) {
    if (error instanceof RequestError) throw error;
    if (timeout.aborted) throw new RequestError(504, '等待供应商超时，请稍后重试。');
    throw new RequestError(502, '无法连接图片供应商，请检查代理的网络和接口地址。');
  } finally {
    res.off('close', disconnect);
  }
}

export function createEditorServer(config, fetchProvider = fetch) {
  let generating = false;
  return createServer({ requestTimeout: 30_000 }, async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'");
    try {
      // A loopback-only service with a fixed Host also rejects DNS rebinding.
      const address = req.socket.localPort;
      if (![`127.0.0.1:${address}`, `localhost:${address}`].includes(req.headers.host)) {
        throw new RequestError(403, '请通过本机工作区地址访问。');
      }
      if (req.method === 'GET' && req.url === '/api/image-edits/config') {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ configured: Boolean(config.endpoint), endpoint: config.endpoint, model: config.model }));
      } else if (req.method === 'POST' && req.url === '/api/image-edits') {
        if (req.headers.origin !== `http://${req.headers.host}`) {
          throw new RequestError(403, '编辑请求须来自本机编辑器页面。');
        }
        if (generating) throw new RequestError(429, '已有生成请求，请等待或取消后重试。');
        generating = true;
        try { await editImage(req, res, config, fetchProvider); } finally { generating = false; }
      } else if (req.method === 'GET' && STATIC.has(req.url)) {
        const [file, type] = STATIC.get(req.url);
        const data = await readFile(new URL(`./dist/${file}`, import.meta.url));
        res.setHeader('Content-Type', `${type}; charset=utf-8`);
        res.end(data);
      } else {
        throw new RequestError(404, '找不到此资源。');
      }
    } catch (error) {
      if (res.destroyed) return;
      const status = error instanceof RequestError ? error.status : 500;
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        ...(req.complete ? {} : { Connection: 'close' }),
      });
      res.end(JSON.stringify({ error: status === 500 ? '本地代理处理失败。' : error.message }));
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const config = readConfig();
    const server = createEditorServer(config);
    server.on('error', (error) => {
      console.error(`启动本地代理失败 (${error.code ?? 'UNKNOWN'})。`);
      process.exitCode = 1;
    });
    server.listen(config.port, '127.0.0.1', () => {
      console.log(`Luma Studio: http://127.0.0.1:${config.port}`);
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
