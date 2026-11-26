const MAX_PREVIEW_EDGE = 2400;
const RENDER_TILE_HEIGHT = 160;
const HISTORY_LIMIT = 50;

const state = {
  originalImage: null,
  originalPixels: null,
  width: 0,
  height: 0,
  fileName: '',
  adjustments: { temperature: 0, vibrance: 0, saturation: 0, contrast: 0 },
  beauty: { slim: 0, whiten: 0, smooth: 0 },
  faces: [],
  selectedFaceIndex: -1,
  selectingFace: false,
  manualDraft: null,
  showOriginal: false,
  renderQueued: false,
  history: [],
  historyIndex: -1,
};

const elements = {
  canvas: document.querySelector('#editorCanvas'), overlay: document.querySelector('#faceOverlay'),
  canvasWrap: document.querySelector('#canvasWrap'), emptyState: document.querySelector('#emptyState'),
  dropZone: document.querySelector('#dropZone'), fileInput: document.querySelector('#fileInput'),
  documentLabel: document.querySelector('#documentLabel'), exportButton: document.querySelector('#exportButton'),
  undoButton: document.querySelector('#undoButton'), redoButton: document.querySelector('#redoButton'),
  originalButton: document.querySelector('#originalButton'), fitButton: document.querySelector('#fitButton'),
  statusText: document.querySelector('#statusText'), performanceText: document.querySelector('#performanceText'),
  renderingIndicator: document.querySelector('#renderingIndicator'), toast: document.querySelector('#toast'),
  settingsDialog: document.querySelector('#settingsDialog'), settingsForm: document.querySelector('#settingsForm'),
  adjustPanel: document.querySelector('#adjustPanel'), beautyPanel: document.querySelector('#beautyPanel'),
  historyPanel: document.querySelector('#historyPanel'), comingSoonPanel: document.querySelector('#comingSoonPanel'),
  panelTitle: document.querySelector('#panelTitle'), panelDescription: document.querySelector('#panelDescription'),
  comingTitle: document.querySelector('#comingTitle'), comingDescription: document.querySelector('#comingDescription'),
  faceStatus: document.querySelector('#faceStatus'), faceGuidance: document.querySelector('#faceGuidance'),
  faceSelect: document.querySelector('#faceSelect'), detectFacesButton: document.querySelector('#detectFacesButton'),
  manualFaceButton: document.querySelector('#manualFaceButton'), historyList: document.querySelector('#historyList'),
};

const context = elements.canvas.getContext('2d', { willReadFrequently: true });
const overlayContext = elements.overlay.getContext('2d');
let toastTimer;
let historyTimer;

function formatValue(value) { return Number(value) > 0 ? `+${value}` : String(value); }
function setStatus(message) { elements.statusText.textContent = message; }
function setRendering(isRendering, message = '正在渲染…') { elements.renderingIndicator.textContent = message; elements.renderingIndicator.hidden = !isRendering; }
function waitForPaint() { return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))); }
function cloneFaces(faces) { return faces.map(({ x, y, width, height }) => ({ x, y, width, height })); }

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => elements.toast.classList.remove('show'), 2600);
}

function updateRangeVisual(input) {
  const percent = ((Number(input.value) - Number(input.min)) / (Number(input.max) - Number(input.min))) * 100;
  input.style.setProperty('--fill', `${percent}%`);
  document.querySelector(`#${input.id}Value`).value = formatValue(input.value);
}

function updateControls() {
  for (const group of [state.adjustments, state.beauty]) {
    for (const [name, value] of Object.entries(group)) {
      const input = document.querySelector(`#${name}`);
      input.value = value;
      updateRangeVisual(input);
    }
  }
}

function captureSnapshot() {
  return { adjustments: { ...state.adjustments }, beauty: { ...state.beauty }, faces: cloneFaces(state.faces), selectedFaceIndex: state.selectedFaceIndex };
}
function sameSnapshot(first, second) { return JSON.stringify(first) === JSON.stringify(second); }

function updateHistoryControls() {
  const hasImage = Boolean(state.originalPixels);
  elements.undoButton.disabled = !hasImage || state.historyIndex <= 0;
  elements.redoButton.disabled = !hasImage || state.historyIndex >= state.history.length - 1;
}

function renderHistory() {
  elements.historyList.replaceChildren();
  state.history.map((entry, index) => ({ entry, index })).reverse().forEach(({ entry, index }) => {
    const button = document.createElement('button');
    button.className = `history-entry${index === state.historyIndex ? ' current' : ''}`;
    button.type = 'button';
    button.dataset.historyIndex = String(index);
    button.append(document.createTextNode(entry.label));
    const time = document.createElement('time');
    time.textContent = index === state.historyIndex ? '当前步骤' : `步骤 ${index + 1}`;
    button.append(time);
    elements.historyList.append(button);
  });
  updateHistoryControls();
}

function recordHistory(label, force = false) {
  if (!state.originalPixels) return;
  const snapshot = captureSnapshot();
  const current = state.history[state.historyIndex];
  if (!force && current && sameSnapshot(snapshot, current.snapshot)) return;
  state.history.splice(state.historyIndex + 1);
  state.history.push({ label, snapshot });
  if (state.history.length > HISTORY_LIMIT) state.history.shift();
  state.historyIndex = state.history.length - 1;
  renderHistory();
}

function queueHistory(label) {
  window.clearTimeout(historyTimer);
  historyTimer = window.setTimeout(() => recordHistory(label), 380);
}

function restoreHistory(index) {
  const entry = state.history[index];
  if (!entry) return;
  window.clearTimeout(historyTimer);
  state.adjustments = { ...entry.snapshot.adjustments };
  state.beauty = { ...entry.snapshot.beauty };
  state.faces = cloneFaces(entry.snapshot.faces);
  state.selectedFaceIndex = entry.snapshot.selectedFaceIndex;
  state.historyIndex = index;
  updateControls(); updateFaceUi(); renderHistory(); scheduleRender();
}
function undo() { if (state.historyIndex > 0) { restoreHistory(state.historyIndex - 1); setStatus('已撤销'); } }
function redo() { if (state.historyIndex < state.history.length - 1) { restoreHistory(state.historyIndex + 1); setStatus('已重做'); } }

function applyAdjustments(sourcePixels, width, height, values = state.adjustments) {
  const output = new ImageData(new Uint8ClampedArray(sourcePixels.data), width, height);
  const pixels = output.data;
  const { temperature, vibrance, saturation, contrast } = values;
  const temperatureShift = temperature * 1.18;
  const saturationAmount = saturation / 100;
  const vibranceAmount = vibrance / 100;
  const contrastFactor = 1 + contrast / 100;
  for (let rowStart = 0; rowStart < height; rowStart += RENDER_TILE_HEIGHT) {
    const rowEnd = Math.min(height, rowStart + RENDER_TILE_HEIGHT);
    for (let index = rowStart * width * 4; index < rowEnd * width * 4; index += 4) {
      let red = pixels[index] + temperatureShift;
      let green = pixels[index + 1] + temperatureShift * 0.08;
      let blue = pixels[index + 2] - temperatureShift;
      const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722;
      const max = Math.max(red, green, blue);
      const min = Math.min(red, green, blue);
      const colourful = max <= 0 ? 0 : (max - min) / max;
      const adaptiveSaturation = saturationAmount + vibranceAmount * (1 - colourful);
      red = luminance + (red - luminance) * (1 + adaptiveSaturation);
      green = luminance + (green - luminance) * (1 + adaptiveSaturation);
      blue = luminance + (blue - luminance) * (1 + adaptiveSaturation);
      pixels[index] = (red - 128) * contrastFactor + 128;
      pixels[index + 1] = (green - 128) * contrastFactor + 128;
      pixels[index + 2] = (blue - 128) * contrastFactor + 128;
    }
  }
  return output;
}

function constrainFace(face, width, height) {
  const x = Math.max(0, Math.min(width - 1, Math.round(face.x)));
  const y = Math.max(0, Math.min(height - 1, Math.round(face.y)));
  return { x, y, width: Math.max(1, Math.min(width - x, Math.round(face.width))), height: Math.max(1, Math.min(height - y, Math.round(face.height))) };
}
function activeFaces(width, height, scale = 1) {
  if (state.selectedFaceIndex < 0 || !state.faces[state.selectedFaceIndex]) return [];
  const face = state.faces[state.selectedFaceIndex];
  return [constrainFace({ x: face.x * scale, y: face.y * scale, width: face.width * scale, height: face.height * scale }, width, height)];
}
function faceStrengthAt(face, x, y) {
  const dx = (x - (face.x + face.width / 2)) / (face.width / 2);
  const dy = (y - (face.y + face.height / 2)) / (face.height / 2);
  const distance = dx * dx + dy * dy;
  return distance >= 1 ? 0 : (1 - distance) * (1 - distance);
}

function applyBeauty(imageData, width, height, scale = 1) {
  const faces = activeFaces(width, height, scale);
  const { slim, whiten, smooth } = state.beauty;
  if (!faces.length || (!slim && !whiten && !smooth)) return imageData;
  const pixels = imageData.data;
  if (slim) {
    const source = new Uint8ClampedArray(pixels);
    for (const face of faces) {
      const xEnd = Math.min(width - 1, face.x + face.width - 1), yEnd = Math.min(height - 1, face.y + face.height - 1), centerX = face.x + face.width / 2;
      for (let y = face.y; y <= yEnd; y += 1) for (let x = face.x; x <= xEnd; x += 1) {
        const mask = faceStrengthAt(face, x, y); if (!mask) continue;
        const sampleX = Math.max(face.x, Math.min(xEnd, Math.round(centerX + (x - centerX) * (1 + slim / 100 * 0.16 * mask))));
        const target = (y * width + x) * 4, sourceIndex = (y * width + sampleX) * 4;
        pixels[target] = source[sourceIndex]; pixels[target + 1] = source[sourceIndex + 1]; pixels[target + 2] = source[sourceIndex + 2];
      }
    }
  }
  if (whiten) {
    const amount = whiten / 100 * 62;
    for (const face of faces) {
      const xEnd = Math.min(width - 1, face.x + face.width - 1), yEnd = Math.min(height - 1, face.y + face.height - 1);
      for (let y = face.y; y <= yEnd; y += 1) for (let x = face.x; x <= xEnd; x += 1) {
        const mask = faceStrengthAt(face, x, y); if (!mask) continue;
        const index = (y * width + x) * 4;
        pixels[index] += amount * mask; pixels[index + 1] += amount * mask; pixels[index + 2] += amount * mask * 0.92;
      }
    }
  }
  if (smooth) {
    const source = new Uint8ClampedArray(pixels), blend = smooth / 100 * 0.6;
    for (const face of faces) {
      const xStart = Math.max(1, face.x), xEnd = Math.min(width - 2, face.x + face.width - 1), yStart = Math.max(1, face.y), yEnd = Math.min(height - 2, face.y + face.height - 1);
      for (let y = yStart; y <= yEnd; y += 1) for (let x = xStart; x <= xEnd; x += 1) {
        const mask = faceStrengthAt(face, x, y); if (!mask) continue;
        const index = (y * width + x) * 4;
        for (let channel = 0; channel < 3; channel += 1) {
          let total = 0;
          for (let offsetY = -1; offsetY <= 1; offsetY += 1) for (let offsetX = -1; offsetX <= 1; offsetX += 1) total += source[((y + offsetY) * width + x + offsetX) * 4 + channel];
          pixels[index + channel] = source[index + channel] + (total / 9 - source[index + channel]) * blend * mask;
        }
      }
    }
  }
  return imageData;
}

function renderImage() {
  if (!state.originalPixels) return;
  const startedAt = performance.now();
  if (state.showOriginal) context.putImageData(state.originalPixels, 0, 0);
  else context.putImageData(applyBeauty(applyAdjustments(state.originalPixels, state.width, state.height), state.width, state.height), 0, 0);
  elements.performanceText.textContent = `${Math.round(performance.now() - startedAt)} ms 预览 · 本地分块处理`;
  renderFaceOverlay();
}
function scheduleRender() {
  if (!state.originalPixels || state.renderQueued) return;
  state.renderQueued = true; setRendering(true);
  requestAnimationFrame(() => requestAnimationFrame(() => { state.renderQueued = false; renderImage(); setRendering(false); }));
}

function fitCanvas() {
  if (!state.width) return;
  const style = window.getComputedStyle(elements.dropZone);
  const availableWidth = Math.max(120, elements.dropZone.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight));
  const availableHeight = Math.max(120, elements.dropZone.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom));
  const scale = Math.min(1, availableWidth / state.width, availableHeight / state.height);
  elements.canvas.style.width = `${Math.floor(state.width * scale)}px`;
  elements.canvas.style.height = `${Math.floor(state.height * scale)}px`;
}

function resetHistory() { state.history = []; state.historyIndex = -1; recordHistory('导入原图', true); }
function loadImage(file) {
  if (!file || !file.type.startsWith('image/')) return;
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) { showToast('请使用 JPEG、PNG 或 WebP 图片'); return; }
  setStatus('正在载入图片…');
  const reader = new FileReader();
  reader.onload = () => {
    const image = new Image();
    image.onload = () => {
      const scale = Math.min(1, MAX_PREVIEW_EDGE / Math.max(image.naturalWidth, image.naturalHeight));
      state.width = Math.max(1, Math.round(image.naturalWidth * scale)); state.height = Math.max(1, Math.round(image.naturalHeight * scale));
      state.fileName = file.name; state.originalImage = image;
      state.adjustments = { temperature: 0, vibrance: 0, saturation: 0, contrast: 0 }; state.beauty = { slim: 0, whiten: 0, smooth: 0 };
      state.faces = []; state.selectedFaceIndex = -1; state.showOriginal = false; state.selectingFace = false;
      elements.canvas.width = state.width; elements.canvas.height = state.height; elements.overlay.width = state.width; elements.overlay.height = state.height;
      context.drawImage(image, 0, 0, state.width, state.height); state.originalPixels = context.getImageData(0, 0, state.width, state.height);
      elements.emptyState.hidden = true; elements.canvasWrap.hidden = false; elements.exportButton.disabled = false; elements.originalButton.disabled = false; elements.fitButton.disabled = false;
      elements.documentLabel.textContent = `${file.name} · ${image.naturalWidth} × ${image.naturalHeight}`;
      updateControls(); updateFaceUi(); resetHistory(); fitCanvas(); renderFaceOverlay();
      setStatus(scale < 1 ? `已载入预览（为流畅编辑缩放至 ${state.width} × ${state.height}）` : '已载入，所有调整实时显示');
    };
    image.onerror = () => showToast('无法读取这张图片，请换一张再试。'); image.src = reader.result;
  };
  reader.readAsDataURL(file);
}

function resetAdjustments() { state.adjustments = { temperature: 0, vibrance: 0, saturation: 0, contrast: 0 }; updateControls(); recordHistory('重置调整'); scheduleRender(); setStatus('已重置所有调整'); }
function applyPreset(name) {
  const presets = { warm: { temperature: 24, vibrance: 13, saturation: 3, contrast: 4 }, clear: { temperature: -5, vibrance: 19, saturation: 8, contrast: 15 }, soft: { temperature: 9, vibrance: -7, saturation: -9, contrast: -14 } };
  state.adjustments = { ...presets[name] }; updateControls(); recordHistory(`调整预设：${name === 'warm' ? '暖阳' : name === 'clear' ? '通透' : '柔和'}`); scheduleRender(); setStatus('已应用预设，可继续微调');
}
function applyBeautyPreset(name) {
  if (!state.faces.length) { showToast('请先识别或框选一张脸'); return; }
  state.beauty = name === 'natural' ? { slim: 10, whiten: 12, smooth: 14 } : { slim: 18, whiten: 24, smooth: 28 };
  updateControls(); recordHistory(`美颜预设：${name === 'natural' ? '自然' : '轻透'}`); scheduleRender(); setStatus('已应用美颜预设，可继续微调');
}
function resetBeauty() { state.beauty = { slim: 0, whiten: 0, smooth: 0 }; updateControls(); recordHistory('重置美颜'); scheduleRender(); setStatus('已重置美颜'); }

function updateFaceUi(message) {
  elements.faceSelect.replaceChildren();
  if (!state.faces.length) {
    elements.faceSelect.add(new Option('尚未选择脸部', '')); elements.faceSelect.disabled = true;
    elements.faceStatus.textContent = message || '未找到脸部。可点击“识别人脸”，或选择“手动框选”。';
  } else {
    state.selectedFaceIndex = Math.max(0, Math.min(state.selectedFaceIndex, state.faces.length - 1));
    state.faces.forEach((_, index) => elements.faceSelect.add(new Option(`脸部 ${index + 1}`, String(index), false, index === state.selectedFaceIndex)));
    elements.faceSelect.disabled = false; elements.faceStatus.textContent = message || `已选择脸部 ${state.selectedFaceIndex + 1}，所有效果只作用于这张脸。`;
  }
  renderFaceOverlay();
}
function renderFaceOverlay() {
  if (!state.width || !overlayContext) return;
  overlayContext.clearRect(0, 0, state.width, state.height);
  const shouldShow = state.faces.length || state.selectingFace || state.manualDraft;
  elements.overlay.hidden = !shouldShow; elements.overlay.classList.toggle('selecting', state.selectingFace);
  if (!shouldShow) return;
  overlayContext.lineWidth = Math.max(2, state.width / 600);
  state.faces.forEach((face, index) => {
    overlayContext.strokeStyle = index === state.selectedFaceIndex ? '#cbff65' : 'rgba(244,242,237,.72)'; overlayContext.fillStyle = index === state.selectedFaceIndex ? 'rgba(203,255,101,.09)' : 'rgba(244,242,237,.035)';
    overlayContext.beginPath(); overlayContext.ellipse(face.x + face.width / 2, face.y + face.height / 2, face.width / 2, face.height / 2, 0, 0, Math.PI * 2); overlayContext.fill(); overlayContext.stroke();
    overlayContext.font = `${Math.max(13, state.width / 75)}px system-ui`; overlayContext.fillStyle = '#f4f2ed'; overlayContext.fillText(`脸部 ${index + 1}`, face.x, Math.max(16, face.y - 7));
  });
  if (state.manualDraft) {
    const { x, y, width, height } = state.manualDraft;
    overlayContext.setLineDash([8, 5]); overlayContext.strokeStyle = '#cbff65'; overlayContext.strokeRect(x, y, width, height); overlayContext.setLineDash([]);
  }
}
function canvasPoint(event) {
  const rect = elements.overlay.getBoundingClientRect();
  return { x: Math.max(0, Math.min(state.width, (event.clientX - rect.left) * state.width / rect.width)), y: Math.max(0, Math.min(state.height, (event.clientY - rect.top) * state.height / rect.height)) };
}
function faceFromPoints(start, end) { return { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) }; }
function startManualSelection() {
  if (!state.originalPixels) { showToast('请先导入图片'); return; }
  state.selectingFace = true; state.manualDraft = null; elements.faceStatus.textContent = '请在画布上拖动，框选一张脸。'; renderFaceOverlay();
}
async function detectFaces() {
  if (!state.originalPixels) { showToast('请先导入图片'); return; }
  if (!('FaceDetector' in window)) {
    elements.faceStatus.textContent = '此浏览器未提供本地人脸检测。请使用“手动框选”，美颜仍会完全在本机完成。';
    elements.faceGuidance.textContent = '检测能力在不同浏览器中可用性不同；手动框选不会上传图片，也能准确指定处理区域。'; showToast('请手动框选脸部'); return;
  }
  setRendering(true, '正在本机识别人脸…'); elements.detectFacesButton.disabled = true;
  try {
    const detector = new FaceDetector({ fastMode: true, maxDetectedFaces: 6 });
    const found = await detector.detect(elements.canvas);
    state.faces = found.map(({ boundingBox }) => constrainFace({ x: boundingBox.x, y: boundingBox.y, width: boundingBox.width, height: boundingBox.height }, state.width, state.height));
    state.selectedFaceIndex = state.faces.length ? 0 : -1;
    updateFaceUi(state.faces.length ? `已在本机识别到 ${state.faces.length} 张脸。` : '未检测到脸部。请尝试手动框选，或换一张正面、光线更充足的照片。');
    if (state.faces.length) recordHistory(`识别 ${state.faces.length} 张脸`);
  } catch (error) { elements.faceStatus.textContent = '人脸识别未完成。请使用“手动框选”继续编辑。'; console.warn('Local face detection failed:', error); }
  finally { elements.detectFacesButton.disabled = false; setRendering(false); }
}

async function exportImage() {
  if (!state.originalImage || elements.exportButton.disabled) return;
  const name = (state.fileName || 'luma-edit').replace(/\.[^.]+$/, ''), sourceImage = state.originalImage;
  const { naturalWidth, naturalHeight } = sourceImage;
  elements.exportButton.disabled = true; setStatus('正在准备原始分辨率 PNG…'); setRendering(true, '正在导出原始分辨率…'); await waitForPaint();
  try {
    const exportCanvas = document.createElement('canvas'); exportCanvas.width = naturalWidth; exportCanvas.height = naturalHeight;
    const exportContext = exportCanvas.getContext('2d', { willReadFrequently: true }); if (!exportContext) throw new Error('Canvas is unavailable');
    exportContext.drawImage(sourceImage, 0, 0, naturalWidth, naturalHeight);
    const originalPixels = exportContext.getImageData(0, 0, naturalWidth, naturalHeight);
    exportContext.putImageData(applyBeauty(applyAdjustments(originalPixels, naturalWidth, naturalHeight), naturalWidth, naturalHeight, naturalWidth / state.width), 0, 0);
    const blob = await new Promise((resolve) => exportCanvas.toBlob(resolve, 'image/png')); if (!blob) throw new Error('PNG encoding failed');
    const url = URL.createObjectURL(blob), link = document.createElement('a'); link.download = `${name}-edited.png`; link.href = url; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 0);
    setStatus(`已导出原始分辨率 PNG（${naturalWidth} × ${naturalHeight}）`); showToast('已导出原始分辨率 PNG');
  } catch (error) { console.error('Image export failed:', error); setStatus('导出失败，请尝试较小的图片'); showToast('导出失败，请尝试较小的图片'); }
  finally { setRendering(false); elements.exportButton.disabled = false; }
}

function switchTool(tool) {
  document.querySelectorAll('.tool').forEach((button) => { const active = button.dataset.tool === tool; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); });
  const details = { adjust: ['调整', '用细微的色彩变化，找到恰好的氛围。'], beauty: ['自然美颜', '本机处理人像；选择脸部后再以温和的强度微调。'], history: ['编辑历史', '撤销、重做或直接回到任一编辑步骤。'], ai: ['局部 AI 编辑', 'M3 将支持圈选区域、输入自然语言，并在应用前比较 AI 生成结果。'] };
  elements.panelTitle.textContent = details[tool][0]; elements.panelDescription.textContent = tool === 'ai' ? '后续里程碑功能' : details[tool][1];
  elements.adjustPanel.hidden = tool !== 'adjust'; elements.beautyPanel.hidden = tool !== 'beauty'; elements.historyPanel.hidden = tool !== 'history'; elements.comingSoonPanel.hidden = tool !== 'ai';
  if (tool === 'ai') { elements.comingTitle.textContent = details.ai[0]; elements.comingDescription.textContent = details.ai[1]; }
  renderFaceOverlay();
}
function restorePreferences() {
  let preferences = {};
  try { const saved = localStorage.getItem('luma-api-preferences'), parsed = saved ? JSON.parse(saved) : {}; if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) preferences = parsed; } catch { /* Ignore malformed storage. */ }
  document.querySelector('#apiBaseUrl').value = typeof preferences.baseUrl === 'string' ? preferences.baseUrl : '';
  document.querySelector('#modelName').value = typeof preferences.model === 'string' ? preferences.model : '';
}
function savePreferences() {
  localStorage.setItem('luma-api-preferences', JSON.stringify({ baseUrl: document.querySelector('#apiBaseUrl').value.trim(), model: document.querySelector('#modelName').value.trim() }));
  document.querySelector('#apiKey').value = ''; elements.settingsDialog.close(); showToast('已保存接口偏好；API Key 未保存');
}

document.querySelector('#openButton').addEventListener('click', () => elements.fileInput.click());
document.querySelector('#emptyOpenButton').addEventListener('click', () => elements.fileInput.click());
elements.fileInput.addEventListener('change', (event) => { const [file] = event.target.files; event.target.value = ''; loadImage(file); });
elements.exportButton.addEventListener('click', exportImage); elements.undoButton.addEventListener('click', undo); elements.redoButton.addEventListener('click', redo); elements.fitButton.addEventListener('click', fitCanvas);
function showOriginalPreview() { if (state.originalPixels) { state.showOriginal = true; context.putImageData(state.originalPixels, 0, 0); } }
function restoreAdjustedPreview() { if (state.showOriginal) { state.showOriginal = false; scheduleRender(); } }
function isOriginalPreviewKey(event) { return event.code === 'Space' || event.key === 'Enter'; }
elements.originalButton.addEventListener('pointerdown', showOriginalPreview);
['pointerup', 'pointerleave', 'pointercancel'].forEach((eventName) => elements.originalButton.addEventListener(eventName, restoreAdjustedPreview));
elements.originalButton.addEventListener('keydown', (event) => { if (!event.repeat && isOriginalPreviewKey(event)) { event.preventDefault(); showOriginalPreview(); } });
elements.originalButton.addEventListener('keyup', (event) => { if (isOriginalPreviewKey(event)) restoreAdjustedPreview(); });
window.addEventListener('keyup', (event) => { if (isOriginalPreviewKey(event)) restoreAdjustedPreview(); }); window.addEventListener('blur', restoreAdjustedPreview); document.addEventListener('visibilitychange', () => { if (document.hidden) restoreAdjustedPreview(); });

for (const input of document.querySelectorAll('input[type="range"]')) {
  updateRangeVisual(input);
  input.addEventListener('input', () => { const isAdjustment = Object.hasOwn(state.adjustments, input.id); (isAdjustment ? state.adjustments : state.beauty)[input.id] = Number(input.value); updateRangeVisual(input); scheduleRender(); queueHistory(isAdjustment ? '调整参数' : '美颜参数'); });
  input.addEventListener('change', () => { window.clearTimeout(historyTimer); recordHistory(Object.hasOwn(state.adjustments, input.id) ? '调整参数' : '美颜参数'); });
}
document.querySelector('#resetButton').addEventListener('click', resetAdjustments); document.querySelector('#resetBeautyButton').addEventListener('click', resetBeauty);
document.querySelectorAll('.preset[data-preset]').forEach((button) => button.addEventListener('click', () => applyPreset(button.dataset.preset)));
document.querySelectorAll('.preset[data-beauty-preset]').forEach((button) => button.addEventListener('click', () => applyBeautyPreset(button.dataset.beautyPreset)));
document.querySelectorAll('.tool').forEach((button) => button.addEventListener('click', () => switchTool(button.dataset.tool)));
elements.detectFacesButton.addEventListener('click', detectFaces); elements.manualFaceButton.addEventListener('click', startManualSelection);
elements.faceSelect.addEventListener('change', () => { state.selectedFaceIndex = Number(elements.faceSelect.value); updateFaceUi(); scheduleRender(); });
elements.historyList.addEventListener('click', (event) => { const button = event.target.closest('[data-history-index]'); if (button) restoreHistory(Number(button.dataset.historyIndex)); });
elements.overlay.addEventListener('pointerdown', (event) => { if (!state.selectingFace) return; elements.overlay.setPointerCapture(event.pointerId); const point = canvasPoint(event); state.manualDraft = { ...point, width: 0, height: 0, start: point }; renderFaceOverlay(); });
elements.overlay.addEventListener('pointermove', (event) => { if (!state.selectingFace || !state.manualDraft?.start) return; state.manualDraft = { ...faceFromPoints(state.manualDraft.start, canvasPoint(event)), start: state.manualDraft.start }; renderFaceOverlay(); });
elements.overlay.addEventListener('pointerup', (event) => {
  if (!state.selectingFace || !state.manualDraft?.start) return;
  const face = faceFromPoints(state.manualDraft.start, canvasPoint(event)); state.selectingFace = false; state.manualDraft = null;
  if (face.width < 24 || face.height < 24) { updateFaceUi('框选区域太小，请重新拖动框选完整脸部。'); return; }
  state.faces.push(constrainFace(face, state.width, state.height)); state.selectedFaceIndex = state.faces.length - 1; updateFaceUi('已手动选择脸部。所有效果只作用于这张脸。'); recordHistory('手动选择脸部'); scheduleRender();
});

['dragenter', 'dragover'].forEach((eventName) => elements.dropZone.addEventListener(eventName, (event) => { event.preventDefault(); elements.dropZone.classList.add('dragover'); }));
['dragleave', 'drop'].forEach((eventName) => elements.dropZone.addEventListener(eventName, (event) => { event.preventDefault(); elements.dropZone.classList.remove('dragover'); }));
elements.dropZone.addEventListener('drop', (event) => loadImage(event.dataTransfer.files[0]));
elements.dropZone.addEventListener('keydown', (event) => { if ((event.key === 'Enter' || event.key === ' ') && !state.originalPixels) elements.fileInput.click(); });
function isFileDrop(event) { return Array.from(event.dataTransfer?.types || []).includes('Files'); }
window.addEventListener('dragover', (event) => { if (isFileDrop(event)) event.preventDefault(); });
window.addEventListener('drop', (event) => { if (isFileDrop(event)) { event.preventDefault(); if (!elements.dropZone.contains(event.target)) { setStatus('请将图片拖放到中央画布区域'); showToast('图片未导入：请放到中央画布区域'); } } });
window.addEventListener('keydown', (event) => { if (!(event.ctrlKey || event.metaKey) || event.altKey) return; if (event.key.toLowerCase() === 'z') { event.preventDefault(); if (event.shiftKey) redo(); else undo(); } else if (event.key.toLowerCase() === 'y') { event.preventDefault(); redo(); } });
window.addEventListener('beforeunload', (event) => { if (state.originalPixels && state.historyIndex > 0) { event.preventDefault(); event.returnValue = ''; } });
document.querySelector('#settingsButton').addEventListener('click', () => elements.settingsDialog.showModal()); document.querySelector('#closeSettingsButton').addEventListener('click', () => elements.settingsDialog.close()); document.querySelector('#cancelSettingsButton').addEventListener('click', () => elements.settingsDialog.close()); elements.settingsForm.addEventListener('submit', (event) => { event.preventDefault(); savePreferences(); });
window.addEventListener('resize', () => { fitCanvas(); renderFaceOverlay(); });
restorePreferences();
