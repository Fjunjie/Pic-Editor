const MAX_RESULTS = 12;

function canvas(width, height) {
  const element = document.createElement('canvas');
  element.width = width;
  element.height = height;
  return element;
}

function requestFrame(image) {
  const ratio = image.naturalWidth / image.naturalHeight;
  const width = ratio > 1.25 ? 1536 : 1024;
  const height = ratio < 0.8 ? 1536 : 1024;
  const scale = Math.min(width / image.naturalWidth, height / image.naturalHeight);
  const photoWidth = Math.max(1, Math.round(image.naturalWidth * scale));
  const photoHeight = Math.max(1, Math.round(image.naturalHeight * scale));
  return {
    width, height, photoWidth, photoHeight,
    x: Math.floor((width - photoWidth) / 2),
    y: Math.floor((height - photoHeight) / 2),
  };
}

function paintGesture(ctx, gesture) {
  const { points, tool, diameter } = gesture;
  const first = points[0];
  const last = points.at(-1);
  ctx.save();
  if (tool === 'erase') ctx.globalCompositeOperation = 'destination-out';
  if (tool === 'rectangle') {
    ctx.fillRect(first.x, first.y, last.x - first.x, last.y - first.y);
  } else {
    ctx.beginPath();
    if (points.length === 1 && tool !== 'lasso') {
      ctx.arc(first.x, first.y, diameter / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.moveTo(first.x, first.y);
      for (let index = 1; index < points.length; index += 1) {
        ctx.lineTo(points[index].x, points[index].y);
      }
      if (tool === 'lasso') {
        ctx.closePath();
        ctx.fill();
      } else {
        ctx.lineWidth = diameter;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.stroke();
      }
    }
  }
  ctx.restore();
}

function pngBase64(element) {
  return element.toDataURL('image/png').split(',')[1];
}

function makeRequest(source, frame, selection, prompt, config) {
  const { width, height, photoWidth, photoHeight, x, y } = frame;
  const image = canvas(width, height);
  const imageContext = image.getContext('2d');
  imageContext.fillStyle = '#fff';
  imageContext.fillRect(0, 0, width, height);
  imageContext.drawImage(source, x, y, photoWidth, photoHeight);

  // The provider uses transparent pixels to mark the area it may edit.
  // The browser separately keeps the soft alpha mask for the final composite.
  const mask = canvas(width, height);
  const maskContext = mask.getContext('2d');
  maskContext.fillRect(0, 0, width, height);
  const alpha = selection.getContext('2d').getImageData(0, 0, photoWidth, photoHeight);
  const binary = maskContext.createImageData(photoWidth, photoHeight);
  let hasSelection = false;
  for (let i = 3; i < binary.data.length; i += 4) {
    const selected = alpha.data[i] > 0;
    binary.data[i] = selected ? 0 : 255;
    hasSelection ||= selected;
  }
  if (!hasSelection) return null;
  maskContext.putImageData(binary, x, y);
  return { image: pngBase64(image), mask: pngBase64(mask), prompt, endpoint: config.endpoint, model: config.model };
}

async function makeLayer(blob, frame, selection) {
  const image = await createImageBitmap(blob);
  try {
    const { width, height, photoWidth, photoHeight, x, y } = frame;
    if (image.width !== width || image.height !== height) throw new Error('结果尺寸与请求不一致。');
    const layer = canvas(photoWidth, photoHeight);
    const ctx = layer.getContext('2d');
    ctx.drawImage(image, x, y, photoWidth, photoHeight, 0, 0, photoWidth, photoHeight);
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(selection, 0, 0);
    return layer;
  } finally {
    image.close();
  }
}

export function createAiEditor({ render, apply, getApplied }) {
  const find = (id) => document.getElementById(id);
  const overlay = find('maskOverlay');
  const overlayContext = overlay.getContext('2d');
  const controls = find('maskControls');
  const feather = find('maskFeather');
  const prompt = find('aiPrompt');
  const status = find('aiStatus');
  const generateButton = find('generateEdit');
  const cancelButton = find('cancelEdit');
  const retryButton = find('retryEdit');
  const compareButton = find('compareEdit');
  const applyButton = find('applyEdit');

  let active = false;
  let originalVisible = false;
  let source;
  let frame;
  let mask;
  let scratch;
  let gesture;
  let tool = 'brush';
  let config;
  let pending;
  let retry;
  let candidate;
  let compare = false;
  let results = [];
  let overlayFrame = 0;

  function update() {
    const available = Boolean(source && config?.configured && !pending && results.length < MAX_RESULTS);
    controls.disabled = !source || Boolean(pending);
    generateButton.disabled = !available;
    cancelButton.hidden = !pending;
    retryButton.hidden = !retry || !available;
    overlay.hidden = !active || !source || originalVisible || Boolean(candidate);
    overlay.classList.toggle('passive', Boolean(pending));
    find('aiResultControls').hidden = !candidate;
    compareButton.textContent = compare ? '查看生成结果' : '查看应用前';
    compareButton.setAttribute('aria-pressed', String(compare));
    applyButton.disabled = !candidate || getApplied().includes(candidate.id);
  }

  async function refreshConfig() {
    try {
      const response = await fetch('/api/image-edits/config');
      if (!response.ok) throw new Error();
      config = await response.json();
      const description = config.configured
        ? `生成时发送原图、蒙版与指令至 ${config.endpoint}（${config.model}）。`
        : '本地代理尚未配置图片供应商。';
      find('aiDestination').textContent = description;
      find('aiSettingsStatus').textContent = description;
    } catch {
      config = null;
      const message = '无法读取 AI 代理，请使用 node server.mjs 启动工作区。';
      find('aiDestination').textContent = message;
      find('aiSettingsStatus').textContent = message;
    }
    update();
  }

  function drawOverlay() {
    if (overlay.hidden || !mask) return;
    const ctx = scratch.getContext('2d');
    ctx.clearRect(0, 0, scratch.width, scratch.height);
    ctx.drawImage(mask, 0, 0);
    if (gesture) paintGesture(ctx, gesture);
    overlayContext.clearRect(0, 0, overlay.width, overlay.height);
    const blur = Number(feather.value) * Math.max(overlay.width, overlay.height) / 1500;
    overlayContext.filter = blur ? `blur(${blur}px)` : 'none';
    overlayContext.drawImage(scratch, 0, 0);
    overlayContext.filter = 'none';
    overlayContext.globalCompositeOperation = 'source-in';
    overlayContext.fillStyle = 'rgba(203,255,101,.42)';
    overlayContext.fillRect(0, 0, overlay.width, overlay.height);
    overlayContext.globalCompositeOperation = 'source-over';
  }

  function queueOverlay() {
    if (overlayFrame) return;
    overlayFrame = requestAnimationFrame(() => {
      overlayFrame = 0;
      drawOverlay();
    });
  }

  function discard() {
    candidate = null;
    compare = false;
    update();
    drawOverlay();
    render();
  }

  function show(result) {
    cancelGesture();
    candidate = result;
    compare = false;
    status.textContent = getApplied().includes(result.id)
      ? '这条结果已在当前编辑中应用。'
      : results.length === MAX_RESULTS
        ? '生成已完成。本张图片的生成历史已达 12 条，可以比较或应用已有结果。'
        : '生成已完成。比较前后效果，或应用结果。';
    update();
    render();
  }

  function renderHistory() {
    const list = find('aiHistory');
    list.replaceChildren(...results.slice().reverse().map((result) => {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'history-entry';
      button.textContent = result.prompt;
      button.disabled = Boolean(pending);
      button.addEventListener('click', () => show(result));
      item.append(button);
      return item;
    }));
  }

  async function generate(request) {
    if (pending || !config?.configured || results.length >= MAX_RESULTS) return;
    const controller = new AbortController();
    pending = controller;
    retry = null;
    discard();
    renderHistory();
    status.textContent = '正在等待供应商生成…';
    try {
      const response = await fetch('/api/image-edits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request.payload),
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        if (response.status === 409) await refreshConfig();
        throw new Error(body?.error || '本地代理无法生成，请检查启动和连接状态。');
      }
      const layer = await makeLayer(await response.blob(), request.frame, request.selection);
      if (pending !== controller || controller.signal.aborted) return;
      const result = { id: results.length + 1, prompt: request.payload.prompt, layer };
      results.push(result);
      show(result);
    } catch (error) {
      if (pending !== controller) return;
      if (controller.signal.aborted) {
        status.textContent = '已取消等待。';
      } else {
        retry = request;
        status.textContent = error instanceof TypeError
          ? '生成失败，请检查本地代理是否仍在运行。'
          : `生成失败。 ${error.message}`;
      }
    } finally {
      if (pending === controller) {
        pending = null;
        update();
        renderHistory();
      }
    }
  }

  function submit(event) {
    event.preventDefault();
    if (generateButton.disabled || gesture) return;
    const text = prompt.value.trim();
    if (!text) {
      status.textContent = '请填写编辑指令。';
      return;
    }
    const selection = canvas(mask.width, mask.height);
    const ctx = selection.getContext('2d', { willReadFrequently: true });
    const blur = Number(feather.value) * Math.max(mask.width, mask.height) / 1500;
    ctx.filter = blur ? `blur(${blur}px)` : 'none';
    ctx.drawImage(mask, 0, 0);
    try {
      const payload = makeRequest(source, frame, selection, text, config);
      if (payload) void generate({ payload, frame, selection });
      else status.textContent = '请在图片上画出选区后再生成。';
    } catch {
      status.textContent = '无法准备图片和蒙版，请重新载入图片。';
    }
  }

  function point(event) {
    const bounds = overlay.getBoundingClientRect();
    return {
      x: (event.clientX - bounds.left) * mask.width / bounds.width,
      y: (event.clientY - bounds.top) * mask.height / bounds.height,
    };
  }

  overlay.addEventListener('pointerdown', (event) => {
    if (pending || gesture || event.button !== 0) return;
    gesture = {
      tool, pointer: event.pointerId, points: [point(event)],
      diameter: Math.max(1, Number(find('maskSize').value) * Math.max(mask.width, mask.height) / 100),
    };
    overlay.setPointerCapture(event.pointerId);
    queueOverlay();
  });
  overlay.addEventListener('pointermove', (event) => {
    if (gesture?.pointer !== event.pointerId) return;
    gesture.points.push(point(event));
    queueOverlay();
  });
  overlay.addEventListener('pointerup', (event) => {
    if (gesture?.pointer !== event.pointerId) return;
    const last = point(event);
    if (last.x !== gesture.points.at(-1).x || last.y !== gesture.points.at(-1).y) gesture.points.push(last);
    paintGesture(mask.getContext('2d'), gesture);
    gesture = null;
    queueOverlay();
  });
  function cancelGesture(pointer = gesture?.pointer) {
    if (!gesture || gesture.pointer !== pointer) return;
    gesture = null;
    if (overlay.hasPointerCapture(pointer)) overlay.releasePointerCapture(pointer);
    queueOverlay();
  }
  for (const eventName of ['pointercancel', 'lostpointercapture']) {
    overlay.addEventListener(eventName, (event) => cancelGesture(event.pointerId));
  }
  document.querySelectorAll('[data-mask-tool]').forEach((button) => {
    button.addEventListener('click', () => {
      cancelGesture();
      tool = button.dataset.maskTool;
      document.querySelectorAll('[data-mask-tool]').forEach((item) => {
        item.setAttribute('aria-pressed', String(item.dataset.maskTool === tool));
      });
      if (candidate) discard();
    });
  });
  document.querySelectorAll('[data-ai-suggestion]').forEach((button) => {
    button.addEventListener('click', () => {
      prompt.value = button.dataset.aiSuggestion;
      prompt.focus();
    });
  });
  find('clearMask').addEventListener('click', () => {
    cancelGesture();
    mask.getContext('2d').clearRect(0, 0, mask.width, mask.height);
    discard();
  });
  feather.addEventListener('input', () => {
    if (candidate) discard();
    else queueOverlay();
  });
  find('aiForm').addEventListener('submit', submit);
  cancelButton.addEventListener('click', () => pending?.abort());
  retryButton.addEventListener('click', () => {
    if (!retry) return;
    if (retry.payload.endpoint !== config?.endpoint || retry.payload.model !== config?.model) {
      retry = null;
      status.textContent = '供应商配置已变更。确认新地址后，请再次点击生成。';
      update();
      return;
    }
    void generate(retry);
  });
  compareButton.addEventListener('click', () => {
    compare = !compare;
    update();
    render();
  });
  find('discardEdit').addEventListener('click', () => {
    discard();
    status.textContent = '已关闭预览，可以从生成历史重新打开。';
  });
  applyButton.addEventListener('click', () => {
    if (!candidate || applyButton.disabled) return;
    apply(candidate.id, candidate.prompt);
    discard();
    status.textContent = results.length === MAX_RESULTS
      ? '已应用结果。本张图片的生成历史已达 12 条。'
      : '已应用结果，可在编辑历史中撤销。';
  });

  return {
    load(image) {
      pending?.abort();
      pending = retry = candidate = null;
      cancelGesture();
      results = [];
      compare = originalVisible = false;
      source = image;
      frame = requestFrame(image);
      overlay.width = frame.photoWidth;
      overlay.height = frame.photoHeight;
      mask = canvas(overlay.width, overlay.height);
      scratch = canvas(overlay.width, overlay.height);
      prompt.value = '';
      status.textContent = '在画布上圈选区域，再输入你想做的修改。';
      update();
      renderHistory();
    },
    activate(isActive) {
      active = isActive;
      cancelGesture();
      update();
      queueOverlay();
      if (active) void refreshConfig();
    },
    original(isVisible) {
      originalVisible = isVisible;
      if (isVisible) cancelGesture();
      update();
      queueOverlay();
    },
    draw(ctx, width, height, applied, preview = false) {
      let ids = applied;
      if (preview && active && candidate) {
        if (compare) ids = applied.filter((id) => id !== candidate.id);
        else if (!applied.includes(candidate.id)) ids = [...applied, candidate.id];
      }
      for (const id of ids) ctx.drawImage(results[id - 1].layer, 0, 0, width, height);
    },
    discard,
    cancelGesture,
    refreshConfig,
  };
}
