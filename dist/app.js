const MAX_PREVIEW_EDGE = 2400;

const state = {
  originalImage: null,
  originalPixels: null,
  width: 0,
  height: 0,
  fileName: '',
  adjustments: { temperature: 0, vibrance: 0, saturation: 0, contrast: 0 },
  showOriginal: false,
  renderQueued: false,
};

const elements = {
  canvas: document.querySelector('#editorCanvas'),
  canvasWrap: document.querySelector('#canvasWrap'),
  emptyState: document.querySelector('#emptyState'),
  dropZone: document.querySelector('#dropZone'),
  fileInput: document.querySelector('#fileInput'),
  documentLabel: document.querySelector('#documentLabel'),
  exportButton: document.querySelector('#exportButton'),
  originalButton: document.querySelector('#originalButton'),
  fitButton: document.querySelector('#fitButton'),
  statusText: document.querySelector('#statusText'),
  renderingIndicator: document.querySelector('#renderingIndicator'),
  toast: document.querySelector('#toast'),
  settingsDialog: document.querySelector('#settingsDialog'),
  settingsForm: document.querySelector('#settingsForm'),
  adjustPanel: document.querySelector('#adjustPanel'),
  comingSoonPanel: document.querySelector('#comingSoonPanel'),
  panelTitle: document.querySelector('#panelTitle'),
  panelDescription: document.querySelector('#panelDescription'),
  comingTitle: document.querySelector('#comingTitle'),
  comingDescription: document.querySelector('#comingDescription'),
};

const context = elements.canvas.getContext('2d', { willReadFrequently: true });
let toastTimer;

function formatValue(value) {
  return Number(value) > 0 ? `+${value}` : String(value);
}

function updateRangeVisual(input) {
  const percent = ((Number(input.value) - Number(input.min)) / (Number(input.max) - Number(input.min))) * 100;
  input.style.setProperty('--fill', `${percent}%`);
  document.querySelector(`#${input.id}Value`).value = formatValue(input.value);
}

function updateControls() {
  for (const [name, value] of Object.entries(state.adjustments)) {
    const input = document.querySelector(`#${name}`);
    input.value = value;
    updateRangeVisual(input);
  }
}

function setStatus(message) {
  elements.statusText.textContent = message;
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => elements.toast.classList.remove('show'), 2600);
}

function drawOriginal() {
  if (!state.originalPixels) return;
  context.putImageData(state.originalPixels, 0, 0);
}

function scheduleRender() {
  if (!state.originalPixels || state.renderQueued) return;
  state.renderQueued = true;
  elements.renderingIndicator.hidden = false;
  requestAnimationFrame(() => {
    state.renderQueued = false;
    renderAdjustedImage();
    elements.renderingIndicator.hidden = true;
  });
}

function renderAdjustedImage() {
  if (!state.originalPixels) return;
  if (state.showOriginal) {
    drawOriginal();
    return;
  }

  const output = new ImageData(new Uint8ClampedArray(state.originalPixels.data), state.width, state.height);
  const pixels = output.data;
  const { temperature, vibrance, saturation, contrast } = state.adjustments;
  const temperatureShift = temperature * 1.18;
  const saturationAmount = saturation / 100;
  const vibranceAmount = vibrance / 100;
  const contrastFactor = 1 + (contrast / 100);

  for (let index = 0; index < pixels.length; index += 4) {
    let red = pixels[index] + temperatureShift;
    let green = pixels[index + 1] + temperatureShift * 0.08;
    let blue = pixels[index + 2] - temperatureShift;

    const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722;
    const max = Math.max(red, green, blue);
    const min = Math.min(red, green, blue);
    const colourfulness = max <= 0 ? 0 : (max - min) / max;
    const adaptiveSaturation = saturationAmount + vibranceAmount * (1 - colourfulness);

    red = luminance + (red - luminance) * (1 + adaptiveSaturation);
    green = luminance + (green - luminance) * (1 + adaptiveSaturation);
    blue = luminance + (blue - luminance) * (1 + adaptiveSaturation);

    pixels[index] = (red - 128) * contrastFactor + 128;
    pixels[index + 1] = (green - 128) * contrastFactor + 128;
    pixels[index + 2] = (blue - 128) * contrastFactor + 128;
  }
  context.putImageData(output, 0, 0);
}

function fitCanvas() {
  if (!state.width) return;
  const stage = elements.dropZone.getBoundingClientRect();
  const availableWidth = Math.max(120, stage.width - 56);
  const availableHeight = Math.max(120, stage.height - 56);
  const scale = Math.min(1, availableWidth / state.width, availableHeight / state.height);
  elements.canvas.style.width = `${Math.floor(state.width * scale)}px`;
  elements.canvas.style.height = `${Math.floor(state.height * scale)}px`;
}

function loadImage(file) {
  if (!file || !file.type.startsWith('image/')) return;
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
    showToast('请使用 JPEG、PNG 或 WebP 图片');
    return;
  }
  setStatus('正在载入图片…');
  const reader = new FileReader();
  reader.onload = () => {
    const image = new Image();
    image.onload = () => {
      const scale = Math.min(1, MAX_PREVIEW_EDGE / Math.max(image.naturalWidth, image.naturalHeight));
      state.width = Math.max(1, Math.round(image.naturalWidth * scale));
      state.height = Math.max(1, Math.round(image.naturalHeight * scale));
      state.fileName = file.name;
      state.originalImage = image;
      state.adjustments = { temperature: 0, vibrance: 0, saturation: 0, contrast: 0 };
      state.showOriginal = false;
      elements.canvas.width = state.width;
      elements.canvas.height = state.height;
      context.clearRect(0, 0, state.width, state.height);
      context.drawImage(image, 0, 0, state.width, state.height);
      state.originalPixels = context.getImageData(0, 0, state.width, state.height);
      elements.emptyState.hidden = true;
      elements.canvasWrap.hidden = false;
      elements.exportButton.disabled = false;
      elements.originalButton.disabled = false;
      elements.fitButton.disabled = false;
      elements.documentLabel.textContent = `${file.name} · ${image.naturalWidth} × ${image.naturalHeight}`;
      updateControls();
      fitCanvas();
      setStatus(scale < 1 ? `已载入预览（为流畅编辑缩放至 ${state.width} × ${state.height}）` : '已载入，所有调整实时显示');
    };
    image.onerror = () => showToast('无法读取这张图片，请换一张再试。');
    image.src = reader.result;
  };
  reader.readAsDataURL(file);
}

function resetAdjustments() {
  state.adjustments = { temperature: 0, vibrance: 0, saturation: 0, contrast: 0 };
  updateControls();
  scheduleRender();
  setStatus('已重置所有调整');
}

function applyPreset(name) {
  const presets = {
    warm: { temperature: 24, vibrance: 13, saturation: 3, contrast: 4 },
    clear: { temperature: -5, vibrance: 19, saturation: 8, contrast: 15 },
    soft: { temperature: 9, vibrance: -7, saturation: -9, contrast: -14 },
  };
  state.adjustments = { ...presets[name] };
  updateControls();
  scheduleRender();
  setStatus('已应用预设，可继续微调');
}

function exportImage() {
  if (!state.originalPixels) return;
  const name = (state.fileName || 'luma-edit').replace(/\.[^.]+$/, '');
  const link = document.createElement('a');
  link.download = `${name}-edited.png`;
  link.href = elements.canvas.toDataURL('image/png');
  link.click();
  setStatus('PNG 已开始下载');
  showToast('已导出 PNG');
}

function switchTool(tool) {
  document.querySelectorAll('.tool').forEach((button) => {
    const active = button.dataset.tool === tool;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  const future = {
    beauty: ['自然美颜', '瘦脸、美白与磨皮将在 M2 接入，并始终保留原图与可撤销结果。'],
    ai: ['局部 AI 编辑', 'M3 将支持圈选区域、输入自然语言，并在应用前比较 AI 生成结果。'],
  };
  const isAdjust = tool === 'adjust';
  elements.adjustPanel.hidden = !isAdjust;
  elements.comingSoonPanel.hidden = isAdjust;
  if (isAdjust) {
    elements.panelTitle.textContent = '调整';
    elements.panelDescription.textContent = '用细微的色彩变化，找到恰好的氛围。';
  } else {
    elements.panelTitle.textContent = future[tool][0];
    elements.panelDescription.textContent = '后续里程碑功能';
    elements.comingTitle.textContent = future[tool][0];
    elements.comingDescription.textContent = future[tool][1];
  }
}

function restorePreferences() {
  const preferences = JSON.parse(localStorage.getItem('luma-api-preferences') || '{}');
  document.querySelector('#apiBaseUrl').value = preferences.baseUrl || '';
  document.querySelector('#modelName').value = preferences.model || '';
}

function savePreferences() {
  const baseUrl = document.querySelector('#apiBaseUrl').value.trim();
  const model = document.querySelector('#modelName').value.trim();
  localStorage.setItem('luma-api-preferences', JSON.stringify({ baseUrl, model }));
  document.querySelector('#apiKey').value = '';
  elements.settingsDialog.close();
  showToast('已保存接口偏好；API Key 未保存');
}

document.querySelector('#openButton').addEventListener('click', () => elements.fileInput.click());
document.querySelector('#emptyOpenButton').addEventListener('click', () => elements.fileInput.click());
elements.fileInput.addEventListener('change', (event) => loadImage(event.target.files[0]));
elements.exportButton.addEventListener('click', exportImage);
elements.fitButton.addEventListener('click', fitCanvas);
elements.originalButton.addEventListener('pointerdown', () => { if (state.originalPixels) { state.showOriginal = true; drawOriginal(); } });
['pointerup', 'pointerleave', 'pointercancel'].forEach((eventName) => elements.originalButton.addEventListener(eventName, () => { if (state.showOriginal) { state.showOriginal = false; scheduleRender(); } }));
elements.originalButton.addEventListener('keydown', (event) => { if ((event.code === 'Space' || event.key === 'Enter') && state.originalPixels) { state.showOriginal = true; drawOriginal(); } });
elements.originalButton.addEventListener('keyup', () => { if (state.showOriginal) { state.showOriginal = false; scheduleRender(); } });

for (const input of document.querySelectorAll('input[type="range"]')) {
  updateRangeVisual(input);
  input.addEventListener('input', () => {
    state.adjustments[input.id] = Number(input.value);
    updateRangeVisual(input);
    scheduleRender();
  });
}
document.querySelector('#resetButton').addEventListener('click', resetAdjustments);
document.querySelectorAll('.preset').forEach((button) => button.addEventListener('click', () => applyPreset(button.dataset.preset)));
document.querySelectorAll('.tool').forEach((button) => button.addEventListener('click', () => switchTool(button.dataset.tool)));

['dragenter', 'dragover'].forEach((eventName) => elements.dropZone.addEventListener(eventName, (event) => { event.preventDefault(); elements.dropZone.classList.add('dragover'); }));
['dragleave', 'drop'].forEach((eventName) => elements.dropZone.addEventListener(eventName, (event) => { event.preventDefault(); elements.dropZone.classList.remove('dragover'); }));
elements.dropZone.addEventListener('drop', (event) => loadImage(event.dataTransfer.files[0]));
elements.dropZone.addEventListener('keydown', (event) => { if ((event.key === 'Enter' || event.key === ' ') && !state.originalPixels) elements.fileInput.click(); });

document.querySelector('#settingsButton').addEventListener('click', () => elements.settingsDialog.showModal());
document.querySelector('#closeSettingsButton').addEventListener('click', () => elements.settingsDialog.close());
document.querySelector('#cancelSettingsButton').addEventListener('click', () => elements.settingsDialog.close());
elements.settingsForm.addEventListener('submit', (event) => { event.preventDefault(); savePreferences(); });
window.addEventListener('resize', fitCanvas);
restorePreferences();
