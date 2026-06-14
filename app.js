/* global Tesseract, jsQR, BarcodeDetector */
const els = {
  video: document.getElementById('video'),
  canvasWrap: document.getElementById('canvasWrap'),
  canvas: document.getElementById('canvas'),
  overlayCanvas: document.getElementById('overlayCanvas'),
  startCameraBtn: document.getElementById('startCameraBtn'),
  captureBtn: document.getElementById('captureBtn'),
  fileInput: document.getElementById('fileInput'),
  loadSampleBtn: document.getElementById('loadSampleBtn'),
  analyzeBtn: document.getElementById('analyzeBtn'),
  analyzeSelectionBtn: document.getElementById('analyzeSelectionBtn'),
  clearSelectionBtn: document.getElementById('clearSelectionBtn'),
  status: document.getElementById('status'),
  progressBar: document.getElementById('progressBar'),
  textOutput: document.getElementById('textOutput'),
  jsonOutput: document.getElementById('jsonOutput'),
  items: document.getElementById('items'),
  statText: document.getElementById('statText'),
  statItems: document.getElementById('statItems'),
  statBarcode: document.getElementById('statBarcode'),
  statCard8: document.getElementById('statCard8'),
  copyJsonBtn: document.getElementById('copyJsonBtn'),
  installBtn: document.getElementById('installBtn')
};

let stream = null;
let lastResult = null;
let deferredInstallPrompt = null;

const state = {
  imageLoaded: false,
  analyzing: false,
  selection: null,
  drag: null,
  annotations: []
};

const cardThumbs = new Map();

registerServiceWorker();
wireEvents();
setStatus('Ready. Use camera, upload an image, or load the bundled sample.');

function wireEvents() {
  els.startCameraBtn.addEventListener('click', startCamera);
  els.captureBtn.addEventListener('click', captureFromCamera);
  els.fileInput.addEventListener('change', handleFileUpload);
  els.loadSampleBtn.addEventListener('click', () => loadImageUrl('./assets/sample-input.png'));
  els.analyzeBtn.addEventListener('click', () => analyzeCurrentCanvas({ useSelection: false }));
  els.analyzeSelectionBtn.addEventListener('click', () => analyzeCurrentCanvas({ useSelection: true }));
  els.clearSelectionBtn.addEventListener('click', clearSelection);
  els.copyJsonBtn.addEventListener('click', copyJson);

  els.overlayCanvas.addEventListener('pointerdown', onSelectionPointerDown);
  els.overlayCanvas.addEventListener('pointermove', onSelectionPointerMove);
  els.overlayCanvas.addEventListener('pointerup', onSelectionPointerUp);
  els.overlayCanvas.addEventListener('pointercancel', onSelectionPointerUp);

  window.addEventListener('resize', drawOverlay);
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    els.installBtn.classList.remove('hidden');
  });

  els.installBtn.addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    els.installBtn.classList.add('hidden');
  });
}

async function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('./sw.js'); } catch (err) { console.warn('SW registration failed', err); }
  }
}

async function startCamera() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 2560 }, height: { ideal: 1440 } },
      audio: false
    });
    els.video.srcObject = stream;
    await els.video.play();
    els.video.style.display = 'block';
    els.canvasWrap.style.display = 'none';
    els.captureBtn.disabled = false;
    setStatus('Camera active. Place all cards, boarding passes and QR/barcodes in frame, then capture.');
  } catch (err) {
    setStatus(`Camera failed: ${err.message}. Use image upload instead.`);
  }
}

function captureFromCamera() {
  const video = els.video;
  if (!video.videoWidth) return;
  drawImageToCanvas(video, video.videoWidth, video.videoHeight);
  stopCamera();
  markImageLoaded('Captured image. Ready to analyze. Drag a rectangle around a card if you need first 8 digits.');
}

function stopCamera() {
  if (!stream) return;
  stream.getTracks().forEach(track => track.stop());
  stream = null;
  els.captureBtn.disabled = true;
}

function handleFileUpload(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  const url = URL.createObjectURL(file);
  loadImageUrl(url, () => URL.revokeObjectURL(url));
}

function loadImageUrl(url, cleanup) {
  const img = new Image();
  img.onload = () => {
    drawImageToCanvas(img, img.naturalWidth, img.naturalHeight);
    cleanup?.();
    markImageLoaded('Image loaded. Ready to analyze. Drag a rectangle around one card for better first-8 digit extraction.');
  };
  img.onerror = () => setStatus('Could not load image.');
  img.src = url;
}

function drawImageToCanvas(source, width, height) {
  const maxSide = 2400;
  const scale = Math.min(1, maxSide / Math.max(width, height));
  const canvas = els.canvas;
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);

  els.overlayCanvas.width = canvas.width;
  els.overlayCanvas.height = canvas.height;
  state.selection = null;
  state.annotations = [];
  drawOverlay();
}

function markImageLoaded(message) {
  state.imageLoaded = true;
  els.analyzeBtn.disabled = false;
  els.analyzeSelectionBtn.disabled = true;
  els.clearSelectionBtn.disabled = true;
  els.video.style.display = 'none';
  els.canvasWrap.style.display = 'block';
  setStatus(message);
  setProgress(0);
}

function clearSelection() {
  state.selection = null;
  state.drag = null;
  els.analyzeSelectionBtn.disabled = true;
  els.clearSelectionBtn.disabled = true;
  drawOverlay();
  setStatus('Selection cleared. Analyze the full image or draw a new selection.');
}

function onSelectionPointerDown(event) {
  if (!state.imageLoaded || state.analyzing) return;
  const p = canvasPointFromEvent(event);
  state.drag = { start: p, current: p };
  state.selection = { x: p.x, y: p.y, width: 0, height: 0 };
  els.overlayCanvas.setPointerCapture?.(event.pointerId);
  drawOverlay();
}

function onSelectionPointerMove(event) {
  if (!state.drag) return;
  const p = canvasPointFromEvent(event);
  state.drag.current = p;
  state.selection = rectFromPoints(state.drag.start, p);
  drawOverlay();
}

function onSelectionPointerUp(event) {
  if (!state.drag) return;
  const p = canvasPointFromEvent(event);
  state.selection = rectFromPoints(state.drag.start, p);
  state.drag = null;
  els.overlayCanvas.releasePointerCapture?.(event.pointerId);

  if (!getValidSelection()) {
    state.selection = null;
    els.analyzeSelectionBtn.disabled = true;
    els.clearSelectionBtn.disabled = true;
    setStatus('Selection too small. Draw a tighter box around a card, boarding pass, or QR/barcode.');
  } else {
    els.analyzeSelectionBtn.disabled = false;
    els.clearSelectionBtn.disabled = false;
    setStatus('Selection ready. Use Analyze selected area for better OCR and first-8 card reading.');
  }
  drawOverlay();
}

function canvasPointFromEvent(event) {
  const rect = els.canvas.getBoundingClientRect();
  const x = (event.clientX - rect.left) * (els.canvas.width / rect.width);
  const y = (event.clientY - rect.top) * (els.canvas.height / rect.height);
  return {
    x: clamp(x, 0, els.canvas.width),
    y: clamp(y, 0, els.canvas.height)
  };
}

function rectFromPoints(a, b) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const width = Math.abs(a.x - b.x);
  const height = Math.abs(a.y - b.y);
  return { x, y, width, height };
}

function getValidSelection() {
  if (!state.selection) return null;
  const s = state.selection;
  if (s.width < 40 || s.height < 40) return null;
  return {
    x: Math.round(clamp(s.x, 0, els.canvas.width - 1)),
    y: Math.round(clamp(s.y, 0, els.canvas.height - 1)),
    width: Math.round(clamp(s.width, 1, els.canvas.width - s.x)),
    height: Math.round(clamp(s.height, 1, els.canvas.height - s.y))
  };
}

function drawOverlay() {
  const overlay = els.overlayCanvas;
  if (!overlay.width || !overlay.height) return;
  const ctx = overlay.getContext('2d');
  ctx.clearRect(0, 0, overlay.width, overlay.height);

  for (const ann of state.annotations) {
    if (!ann.box) continue;
    ctx.save();
    ctx.lineWidth = Math.max(3, Math.round(overlay.width / 380));
    ctx.strokeStyle = ann.color || '#fcdc00';
    ctx.fillStyle = ann.fill || 'rgba(252,220,0,0.16)';
    ctx.fillRect(ann.box.x, ann.box.y, ann.box.width, ann.box.height);
    ctx.strokeRect(ann.box.x, ann.box.y, ann.box.width, ann.box.height);
    ctx.font = `${Math.max(14, Math.round(overlay.width / 70))}px sans-serif`;
    ctx.fillStyle = '#111827';
    ctx.fillText(ann.label || 'Detected', ann.box.x + 6, Math.max(20, ann.box.y - 8));
    ctx.restore();
  }

  const selection = getValidSelection() || state.selection;
  if (selection && selection.width > 0 && selection.height > 0) {
    ctx.save();
    ctx.lineWidth = Math.max(3, Math.round(overlay.width / 420));
    ctx.setLineDash([10, 7]);
    ctx.strokeStyle = '#38bdf8';
    ctx.fillStyle = 'rgba(56,189,248,0.16)';
    ctx.fillRect(selection.x, selection.y, selection.width, selection.height);
    ctx.strokeRect(selection.x, selection.y, selection.width, selection.height);
    ctx.setLineDash([]);
    ctx.font = `${Math.max(14, Math.round(overlay.width / 75))}px sans-serif`;
    ctx.fillStyle = '#e0f2fe';
    const labelY = Math.min(overlay.height - 10, selection.y + selection.height + 24);
    ctx.fillText('Selected area', selection.x + 6, labelY);
    ctx.restore();
  }
}

async function analyzeCurrentCanvas({ useSelection }) {
  if (!state.imageLoaded || state.analyzing) return;
  const region = useSelection ? getValidSelection() : null;
  if (useSelection && !region) {
    setStatus('Draw a rectangle around one card, boarding pass or QR/barcode first.');
    return;
  }

  state.analyzing = true;
  els.analyzeBtn.disabled = true;
  els.analyzeSelectionBtn.disabled = true;
  els.copyJsonBtn.disabled = true;
  setProgress(3);
  cardThumbs.clear();
  const sourceLabel = region ? 'selected area' : 'full image';
  setStatus(`Starting analysis on ${sourceLabel}...`);

  try {
    const originalCanvas = els.canvas;
    const ocrCanvas = makeEnhancedCanvas(originalCanvas, region, { mode: 'text', maxSide: region ? 2600 : 2800 });

    setStatus('Detecting QR, PDF417, Aztec and Data Matrix barcodes...');
    const barcodes = await detectBarcodes(originalCanvas, region);
    setProgress(18);

    setStatus(`Running OCR on ${sourceLabel}. This can take 10–45 seconds on mobile devices...`);
    const ocr = await runTextOcr(ocrCanvas, region ? 'selection' : 'full');
    setProgress(72);

    let cardReads = [];
    if (region) {
      setStatus('Reading only the first 8 digits from the selected card image...');
      cardReads = await readCardFirst8FromRegion(originalCanvas, region);
      setProgress(90);
    } else {
      cardReads = extractCardReadsFromText(ocr.text);
      setProgress(86);
    }

    setStatus('Classifying payment cards, boarding passes, and access QR/barcodes...');
    const result = classifyDocumentSet(ocr.text, barcodes, cardReads, { region, source: sourceLabel });
    result.meta = {
      processedAt: new Date().toISOString(),
      source: sourceLabel,
      engine: 'browser-pwa-tesseract-js-barcode-detector-jsqr',
      barcodeNote: 'Native BarcodeDetector is used when available for QR/PDF417/Aztec/Data Matrix. jsQR is used as a QR fallback.',
      cardPrivacy: 'Only first 8 card digits are retained in output. Any detected full PAN-like sequences are masked.'
    };
    lastResult = result;

    renderResults(result);
    annotateDetections(barcodes, region, cardReads);
    setProgress(100);
    setStatus(`Done. Found ${result.items.length} classified item(s), ${barcodes.length} barcode(s), ${cardReads.filter(c => c.first8 && c.first8 !== 'not detected').length} card first-8 value(s), and ${result.fullText.length} OCR characters.`);
  } catch (err) {
    console.error(err);
    setStatus(`Analysis failed: ${err.message}`);
  } finally {
    state.analyzing = false;
    els.analyzeBtn.disabled = false;
    els.analyzeSelectionBtn.disabled = !getValidSelection();
  }
}

function makeEnhancedCanvas(sourceCanvas, region = null, options = {}) {
  const { mode = 'text', maxSide = 2600 } = options;
  const sx = region?.x ?? 0;
  const sy = region?.y ?? 0;
  const sw = region?.width ?? sourceCanvas.width;
  const sh = region?.height ?? sourceCanvas.height;
  const scale = Math.max(1, Math.min(3.2, maxSide / Math.max(sw, sh)));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(sw * scale);
  canvas.height = Math.round(sh * scale);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(sourceCanvas, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;
  let graySum = 0;
  for (let i = 0; i < data.length; i += 4) graySum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  const avg = graySum / (data.length / 4);

  if (mode === 'digits-hard') {
    const threshold = avg < 120 ? Math.max(105, avg + 25) : Math.min(185, avg - 15);
    for (let i = 0; i < data.length; i += 4) {
      const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      const blackText = avg < 120 ? gray > threshold : gray < threshold;
      data[i] = data[i + 1] = data[i + 2] = blackText ? 0 : 255;
    }
  } else {
    for (let i = 0; i < data.length; i += 4) {
      const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      const boost = mode === 'digits-soft' ? 2.15 : 1.55;
      let out = Math.max(0, Math.min(255, (gray - 128) * boost + 128));
      if (mode === 'digits-soft' && avg < 110) out = 255 - out;
      data[i] = data[i + 1] = data[i + 2] = out;
    }
  }

  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

async function runTextOcr(canvas, scope) {
  if (!window.Tesseract) throw new Error('Tesseract.js did not load. Check internet access or self-host the library.');
  const result = await Tesseract.recognize(canvas.toDataURL('image/png'), 'eng', {
    tessedit_pageseg_mode: scope === 'selection' ? '6' : '11',
    preserve_interword_spaces: '1',
    logger: (m) => {
      if (m.status === 'recognizing text' && Number.isFinite(m.progress)) {
        setProgress(18 + Math.round(m.progress * 54));
        setStatus(`OCR: ${Math.round(m.progress * 100)}%`);
      }
    }
  });
  return { text: result.data?.text || '' };
}

async function runDigitOcr(canvas, progressBase = 72) {
  if (!window.Tesseract) throw new Error('Tesseract.js did not load. Check internet access or self-host the library.');
  const result = await Tesseract.recognize(canvas.toDataURL('image/png'), 'eng', {
    tessedit_char_whitelist: '0123456789 ',
    tessedit_pageseg_mode: '6',
    preserve_interword_spaces: '1',
    logger: (m) => {
      if (m.status === 'recognizing text' && Number.isFinite(m.progress)) {
        setProgress(progressBase + Math.round(m.progress * 14));
        setStatus(`Card digit OCR: ${Math.round(m.progress * 100)}%`);
      }
    }
  });
  return result.data?.text || '';
}

async function detectBarcodes(canvas, region = null) {
  const detected = [];
  const crop = region ? cropCanvas(canvas, region) : canvas;
  const offsetX = region?.x ?? 0;
  const offsetY = region?.y ?? 0;

  if ('BarcodeDetector' in window) {
    try {
      const supported = await BarcodeDetector.getSupportedFormats?.();
      const wanted = ['qr_code', 'pdf417', 'aztec', 'data_matrix'];
      const formats = supported ? wanted.filter(f => supported.includes(f)) : wanted;
      if (formats.length) {
        const detector = new BarcodeDetector({ formats });
        const barcodes = await detector.detect(crop);
        for (const code of barcodes) {
          detected.push({
            format: code.format || 'barcode',
            rawValue: code.rawValue || '',
            box: offsetBox(normalizeBoundingBox(code.boundingBox), offsetX, offsetY),
            source: 'BarcodeDetector'
          });
        }
      }
    } catch (err) {
      console.warn('BarcodeDetector failed; using jsQR fallback', err);
    }
  }

  if (window.jsQR) {
    const fallback = scanWithJsQrTiles(crop, offsetX, offsetY);
    detected.push(...fallback);
  }

  return uniqueBarcodes(detected);
}

function normalizeBoundingBox(box) {
  if (!box) return null;
  return { x: box.x, y: box.y, width: box.width, height: box.height };
}

function offsetBox(box, offsetX, offsetY) {
  if (!box) return null;
  return { x: box.x + offsetX, y: box.y + offsetY, width: box.width, height: box.height };
}

function scanWithJsQrTiles(canvas, offsetX = 0, offsetY = 0) {
  const found = [];
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const full = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const whole = jsQR(full.data, full.width, full.height, { inversionAttempts: 'attemptBoth' });
  if (whole) found.push(qrFromJsQr(whole, offsetX, offsetY, 'jsQR-full'));

  const minSide = Math.min(canvas.width, canvas.height);
  const tileSize = Math.round(Math.max(220, minSide * 0.42));
  const step = Math.max(140, Math.round(tileSize * 0.52));
  if (tileSize < 180) return found;

  for (let y = 0; y < canvas.height; y += step) {
    for (let x = 0; x < canvas.width; x += step) {
      const w = Math.min(tileSize, canvas.width - x);
      const h = Math.min(tileSize, canvas.height - y);
      if (w < 160 || h < 160) continue;
      const tile = ctx.getImageData(x, y, w, h);
      const qr = jsQR(tile.data, tile.width, tile.height, { inversionAttempts: 'attemptBoth' });
      if (qr) found.push(qrFromJsQr(qr, x + offsetX, y + offsetY, 'jsQR-tile'));
    }
  }
  return found;
}

function qrFromJsQr(qr, offsetX, offsetY, source) {
  const points = [qr.location.topLeftCorner, qr.location.topRightCorner, qr.location.bottomRightCorner, qr.location.bottomLeftCorner];
  const xs = points.map(p => p.x + offsetX);
  const ys = points.map(p => p.y + offsetY);
  return {
    format: 'qr_code',
    rawValue: qr.data || '',
    box: { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) },
    source
  };
}

function uniqueBarcodes(barcodes) {
  const out = [];
  for (const code of barcodes) {
    const duplicate = out.some(existing => sameBarcode(existing, code));
    if (!duplicate) out.push(code);
  }
  return out;
}

function sameBarcode(a, b) {
  if (a.rawValue && b.rawValue && a.rawValue === b.rawValue && centerDistance(a.box, b.box) < 80) return true;
  if (!a.rawValue || !b.rawValue) return centerDistance(a.box, b.box) < 55 && a.format === b.format;
  return false;
}

function centerDistance(a, b) {
  if (!a || !b) return Number.POSITIVE_INFINITY;
  const ax = a.x + a.width / 2;
  const ay = a.y + a.height / 2;
  const bx = b.x + b.width / 2;
  const by = b.y + b.height / 2;
  return Math.hypot(ax - bx, ay - by);
}

async function readCardFirst8FromRegion(canvas, region) {
  const crop = cropCanvas(canvas, region);
  const thumbId = `card-thumb-${Date.now()}`;
  cardThumbs.set(thumbId, makeThumbnailDataUrl(crop));

  const soft = makeEnhancedCanvas(crop, null, { mode: 'digits-soft', maxSide: 2200 });
  const hard = makeEnhancedCanvas(crop, null, { mode: 'digits-hard', maxSide: 2200 });

  const softText = await runDigitOcr(soft, 72);
  let combined = softText;
  let candidates = extractFirst8Candidates(combined);
  if (!candidates.length) {
    const hardText = await runDigitOcr(hard, 82);
    combined = `${softText}\n${hardText}`;
    candidates = extractFirst8Candidates(combined);
  }

  const best = candidates[0];
  const first8 = best?.first8 || 'not detected';
  const network = best?.network || inferNetworkFromFirst8(first8) || 'not detected';
  return [{
    id: 'selected-card-image-1',
    first8,
    network,
    confidence: best ? best.confidence : 0.42,
    source: 'selected card image OCR',
    region: compactBox(region),
    thumbnailId,
    digitEvidence: redactDigitsExceptFirst8(combined || 'No digit OCR text detected.')
  }];
}

function extractCardReadsFromText(text) {
  const candidates = extractFirst8Candidates(text);
  return candidates.slice(0, 4).map((c, idx) => ({
    id: `card-first8-${idx + 1}`,
    first8: c.first8,
    network: c.network || 'not detected',
    confidence: c.confidence,
    source: 'full-image OCR',
    digitEvidence: redactDigitsExceptFirst8(c.original)
  }));
}

function extractFirst8Candidates(text) {
  const normalized = String(text || '')
    .replace(/[Oo]/g, '0')
    .replace(/[Il|]/g, '1')
    .replace(/[Ss]/g, '5')
    .replace(/[Bb]/g, '8');
  const matches = normalized.match(/(?:\d[\s-]*){8,19}/g) || [];
  const candidates = [];
  for (const original of matches) {
    const digits = original.replace(/\D/g, '');
    if (digits.length < 8 || digits.length > 19) continue;
    const first8 = digits.slice(0, 8);
    const network = inferNetworkFromNumber(digits) || inferNetworkFromFirst8(first8);
    const luhn = digits.length >= 13 && digits.length <= 19 ? luhnCheck(digits) : false;
    let confidence = 0.42;
    if (digits.length >= 13 && digits.length <= 19) confidence += 0.18;
    if (network) confidence += 0.16;
    if (luhn) confidence += 0.22;
    if (/\d{4}[\s-]+\d{4}/.test(original)) confidence += 0.06;
    candidates.push({ original, digits, first8, network, luhn, confidence: Math.min(0.96, confidence) });
  }

  const unique = new Map();
  for (const c of candidates.sort((a, b) => b.confidence - a.confidence)) {
    if (!unique.has(c.first8)) unique.set(c.first8, c);
  }
  return [...unique.values()].sort((a, b) => b.confidence - a.confidence);
}

function classifyDocumentSet(rawText, barcodes, cardReads, context) {
  const fullText = maskSensitiveText(cleanOcrText(rawText));
  const normalized = normalizeText(rawText);
  const items = [];

  const cards = classifyCards(rawText, normalized, cardReads);
  items.push(...cards);

  const boardingFromText = classifyBoardingPass(rawText, normalized);
  if (boardingFromText) items.push(boardingFromText);

  barcodes.forEach((barcode, index) => {
    items.push(classifyBarcode(barcode, index));
  });

  const unknownTextAllowed = context?.source === 'full image' || fullText.length > 20;
  if (!items.length && fullText.trim() && unknownTextAllowed) {
    items.push({
      id: 'unknown-1',
      type: 'unknown',
      title: 'Unclassified text block',
      confidence: 0.3,
      fields: {},
      evidence: fullText.slice(0, 800)
    });
  }

  return {
    fullText,
    items,
    detections: {
      barcodes: barcodes.map((b, idx) => ({
        id: `barcode-${idx + 1}`,
        format: b.format,
        source: b.source,
        location: b.box ? compactBox(b.box) : null,
        decodedText: b.rawValue || ''
      })),
      cardFirst8: cardReads.map(c => ({
        id: c.id,
        first8: c.first8,
        network: c.network,
        confidence: c.confidence,
        source: c.source,
        region: c.region || null,
        thumbnailAvailable: Boolean(c.thumbnailId),
        digitEvidence: c.digitEvidence
      }))
    }
  };
}

function classifyCards(rawText, normalized, cardReads = []) {
  const items = [];
  const candidates = [];

  for (const read of cardReads) {
    candidates.push({
      network: read.network || 'not detected',
      first8: read.first8 || 'not detected',
      evidence: read.digitEvidence || read.first8 || '',
      source: read.source,
      confidence: read.confidence || 0.55,
      thumbnailId: read.thumbnailId,
      region: read.region
    });
  }

  const numbers = extractPotentialCardNumbers(rawText);
  for (const n of numbers) {
    const network = inferNetworkFromNumber(n.digits) || inferNetworkFromFirst8(n.digits.slice(0, 8)) || 'not detected';
    candidates.push({ network, first8: n.digits.slice(0, 8), evidence: n.original, source: 'full-image OCR number', confidence: n.luhn ? 0.88 : 0.68 });
  }

  const brandHints = [
    { network: 'American Express', patterns: [/AMERICAN\s*EXPRESS/i, /\bAMEX\b/i] },
    { network: 'Visa', patterns: [/\bVISA\b/i] },
    { network: 'Mastercard', patterns: [/MASTER\s*CARD/i, /MASTERCARD/i] },
    { network: 'UnionPay', patterns: [/UNION\s*PAY/i] },
    { network: 'Discover', patterns: [/DISCOVER/i] },
    { network: 'Diners Club', patterns: [/DINERS/i] },
    { network: 'JCB', patterns: [/\bJCB\b/i] }
  ];
  for (const hint of brandHints) {
    if (hint.patterns.some(p => p.test(rawText))) {
      candidates.push({ network: hint.network, first8: 'not detected', evidence: hint.network, source: 'brand text', confidence: 0.70 });
    }
  }

  const issuers = inferIssuers(rawText);
  const unique = new Map();
  for (const cand of candidates) {
    const key = cand.first8 && cand.first8 !== 'not detected' ? cand.first8 : `${cand.network}-${cand.source}-${cand.thumbnailId || ''}`;
    if (!unique.has(key)) unique.set(key, cand);
  }

  let i = 1;
  for (const cand of unique.values()) {
    const fields = {
      first8: cand.first8 || 'not detected',
      network: cand.network || 'not detected',
      issuerHints: issuers.length ? issuers.join(', ') : 'not detected',
      source: cand.source || 'OCR'
    };
    if (cand.region) fields.region = `${cand.region.x},${cand.region.y} ${cand.region.width}x${cand.region.height}`;

    items.push({
      id: `card-${i++}`,
      type: 'credit_card',
      title: cand.first8 && cand.first8 !== 'not detected' ? `${cand.network || 'Payment'} card · first 8 detected` : `${cand.network || 'Payment'} card`,
      confidence: cand.confidence || 0.65,
      fields,
      thumbnailId: cand.thumbnailId,
      evidence: maskSensitiveText(extractEvidenceAround(rawText, cand.evidence, 280) || cand.evidence || '')
    });
  }

  if (!items.length && issuers.length && /CARD|CREDIT|DEBIT|PREMIER|RESERVE|PLATINUM|GOLD|SAPPHIRE|VENTURE/i.test(rawText)) {
    items.push({
      id: 'card-1',
      type: 'credit_card',
      title: 'Payment card',
      confidence: 0.58,
      fields: { first8: 'not detected', network: 'not detected', issuerHints: issuers.join(', '), source: 'issuer text' },
      evidence: maskSensitiveText(rawText.slice(0, 700))
    });
  }

  return items;
}

function extractPotentialCardNumbers(text) {
  const matches = text.match(/(?:\d[ -]?){13,19}/g) || [];
  return matches
    .map(original => ({ original: original.trim(), digits: original.replace(/\D/g, '') }))
    .filter(x => x.digits.length >= 13 && x.digits.length <= 19)
    .map(x => ({ ...x, luhn: luhnCheck(x.digits) }))
    .filter(x => x.luhn || inferNetworkFromNumber(x.digits) || x.digits.length === 16 || x.digits.length === 15);
}

function luhnCheck(digits) {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  let doubleDigit = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (doubleDigit) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    doubleDigit = !doubleDigit;
  }
  return sum % 10 === 0;
}

function inferNetworkFromNumber(digits) {
  if (/^3[47]\d{13}$/.test(digits)) return 'American Express';
  if (/^4\d{12}(\d{3})?(\d{3})?$/.test(digits)) return 'Visa';
  const first2 = Number(digits.slice(0, 2));
  const first4 = Number(digits.slice(0, 4));
  if (digits.length === 16 && ((first2 >= 51 && first2 <= 55) || (first4 >= 2221 && first4 <= 2720))) return 'Mastercard';
  if (/^6(?:011|5\d{2})/.test(digits)) return 'Discover';
  if (/^35\d{14,17}/.test(digits)) return 'JCB';
  if (/^62\d{14,17}/.test(digits)) return 'UnionPay';
  return null;
}

function inferNetworkFromFirst8(first8) {
  if (!/^\d{8}$/.test(first8)) return null;
  if (/^3[47]/.test(first8)) return 'American Express';
  if (/^4/.test(first8)) return 'Visa';
  const first2 = Number(first8.slice(0, 2));
  const first4 = Number(first8.slice(0, 4));
  if ((first2 >= 51 && first2 <= 55) || (first4 >= 2221 && first4 <= 2720)) return 'Mastercard';
  if (/^6(?:011|5\d{2})/.test(first8)) return 'Discover';
  if (/^35/.test(first8)) return 'JCB';
  if (/^62/.test(first8)) return 'UnionPay';
  return null;
}

function inferIssuers(text) {
  const issuers = [
    ['American Express', /AMERICAN\s*EXPRESS/i],
    ['Chase', /CHASE|SAPPHIRE/i],
    ['Citi', /\bCITI\b|CITIBANK/i],
    ['Capital One', /CAPITAL\s*ONE|VENTURE\s*X/i],
    ['HSBC', /\bHSBC\b/i],
    ['Emirates Skywards', /EMIRATES|SKYWARDS/i],
    ['Priority Pass', /PRIORITY\s*PASS/i]
  ];
  return issuers.filter(([, regex]) => regex.test(text)).map(([name]) => name);
}

function classifyBoardingPass(rawText, normalized) {
  const scoreTerms = ['BOARDING PASS', 'BOARDING TIME', 'GATE', 'SEAT', 'FLIGHT', 'PASSENGER', 'FROM', 'TO', 'BAGGAGE', 'BARCODE'];
  const hits = scoreTerms.filter(t => normalized.includes(t)).length;
  const flight = firstMatch(rawText, /\b([A-Z]{2}|[A-Z]\d|\d[A-Z])\s?\d{2,4}\b/g);
  if (hits < 2 && !flight) return null;

  const fields = {
    passenger: extractPassenger(rawText) || 'not detected',
    flight: flight || 'not detected',
    from: extractAfterLabel(rawText, /\bFROM\b|\bFR\b/i) || 'not detected',
    to: extractAfterLabel(rawText, /\bTO\b/i) || 'not detected',
    gate: extractLabeledValue(rawText, /\bGATE\b/i, /[A-Z0-9]{1,4}/) || 'not detected',
    seat: extractLabeledValue(rawText, /\bSEAT\b/i, /\d{1,2}[A-Z]/) || 'not detected',
    boardingTime: extractLabeledValue(rawText, /BOARDING\s*(TIME)?/i, /\d{1,2}[:.]\d{2}\s?(AM|PM)?/i) || 'not detected'
  };

  return {
    id: 'boarding-pass-text-1',
    type: 'boarding_pass',
    title: 'Boarding pass from text',
    confidence: Math.min(0.95, 0.52 + hits * 0.07 + (flight ? 0.12 : 0)),
    fields,
    evidence: maskSensitiveText(extractLikelyBoardingEvidence(rawText))
  };
}

function classifyBarcode(barcode, index) {
  const payload = barcode.rawValue || '';
  const normalizedPayload = normalizeText(payload);
  const formatLabel = barcode.format ? barcode.format.toUpperCase().replace('_', ' ') : 'BARCODE';
  const bcbp = parseIataBcbp(payload);

  if (bcbp) {
    return {
      id: `boarding-barcode-${index + 1}`,
      type: 'boarding_pass_barcode',
      title: `Boarding pass ${formatLabel}`,
      confidence: 0.96,
      fields: {
        format: barcode.format || 'not detected',
        passenger: bcbp.passengerName || 'not detected',
        pnr: bcbp.pnr || 'not detected',
        from: bcbp.from || 'not detected',
        to: bcbp.to || 'not detected',
        carrier: bcbp.carrier || 'not detected',
        flight: bcbp.flight || 'not detected',
        flightDayOfYear: bcbp.flightDayOfYear || 'not detected',
        seat: bcbp.seat || 'not detected',
        sequence: bcbp.sequence || 'not detected',
        source: barcode.source,
        location: barcode.box ? boxToString(barcode.box) : 'not available'
      },
      evidence: payload
    };
  }

  let qrClass = `${formatLabel} code`;
  let type = 'qr_code';
  if (/BOOK|BOOKING|PNR|RESERVATION|REF/.test(normalizedPayload)) qrClass = 'Booking reference QR/barcode';
  else if (/CHECK.?IN|BOARD|AIRLINE|FLIGHT/.test(normalizedPayload)) qrClass = 'Check-in / boarding QR/barcode';
  else if (/LOUNGE|ACCESS|PRIORITY|PASS/.test(normalizedPayload)) qrClass = 'Lounge access QR/barcode';
  else if (/^https?:\/\//i.test(payload)) qrClass = 'URL QR code';
  if (barcode.format && barcode.format !== 'qr_code') type = 'barcode';

  const kv = parseKeyValuePayload(payload);
  return {
    id: `barcode-${index + 1}`,
    type,
    title: qrClass,
    confidence: payload ? 0.88 : 0.55,
    fields: {
      format: barcode.format || 'not detected',
      decodedText: payload || 'detected but payload not decoded',
      parsed: kv ? JSON.stringify(kv) : 'not available',
      source: barcode.source,
      location: barcode.box ? boxToString(barcode.box) : 'not available'
    },
    evidence: payload || 'Barcode pattern detected visually, but no data payload was available.'
  };
}

function parseIataBcbp(payload) {
  if (!payload) return null;
  const start = payload.search(/M\d/);
  if (start < 0) return null;
  const s = payload.slice(start);
  if (!/^M\d/.test(s) || s.length < 58) return null;
  const passengerRaw = s.slice(2, 22).trim();
  const pnr = s.slice(23, 30).trim();
  const from = s.slice(30, 33).trim();
  const to = s.slice(33, 36).trim();
  const carrier = s.slice(36, 39).trim();
  const flightNo = s.slice(39, 44).trim();
  const julian = s.slice(44, 47).trim();
  const seat = s.slice(48, 52).trim();
  const sequence = s.slice(52, 57).trim();
  if (!from || !to || !flightNo) return null;
  return {
    passengerName: formatBcbpPassengerName(passengerRaw),
    pnr,
    from,
    to,
    carrier,
    flight: `${carrier}${flightNo}`.replace(/\s+/g, ''),
    flightDayOfYear: julian,
    seat,
    sequence
  };
}

function formatBcbpPassengerName(value) {
  if (!value) return '';
  const cleaned = value.replace(/\s+/g, ' ').trim();
  if (!cleaned.includes('/')) return cleaned;
  const [last, first] = cleaned.split('/');
  return `${first || ''} ${last || ''}`.trim().replace(/\s+/g, ' ');
}

function parseKeyValuePayload(payload) {
  if (!payload || !/[=:]/.test(payload)) return null;
  const out = {};
  const parts = payload.split(/[\n;&|]+/).map(p => p.trim()).filter(Boolean);
  for (const part of parts) {
    const match = part.match(/^([^=:]{2,24})[=:](.{1,120})$/);
    if (match) out[match[1].trim()] = match[2].trim();
  }
  return Object.keys(out).length ? out : null;
}

function extractPassenger(text) {
  const labelMatch = text.match(/PASSENGER\s*[:\-]?\s*([A-Z][A-Z .'-]{2,40})/i);
  if (labelMatch) return labelMatch[1].split(/\n/)[0].trim();

  const lines = text.split(/\n+/).map(x => x.trim()).filter(Boolean);
  const nameLine = lines.find(line => /^[A-Z][A-Z .'-]{3,34}$/.test(line) && !/BOARDING|FLIGHT|GATE|SEAT|UNITED|AIRLINE|BOOKING|LOUNGE/i.test(line));
  return nameLine || null;
}

function extractAfterLabel(text, labelRegex) {
  const lines = text.split(/\n+/);
  for (const line of lines) {
    if (!labelRegex.test(line)) continue;
    const cleaned = line.replace(labelRegex, '').replace(/[:\-]/g, ' ').trim();
    const token = cleaned.match(/[A-Z]{3,20}|[A-Z]{3}/i);
    if (token) return token[0].toUpperCase();
  }
  return null;
}

function extractLabeledValue(text, labelRegex, valueRegex) {
  const lines = text.split(/\n+/);
  for (const line of lines) {
    if (!labelRegex.test(line)) continue;
    const value = line.match(valueRegex);
    if (value) return value[0].toUpperCase();
  }
  return null;
}

function firstMatch(text, regex) {
  const match = text.match(regex);
  return match ? match[0].replace(/\s+/g, ' ').toUpperCase() : null;
}

function extractLikelyBoardingEvidence(text) {
  const lines = text.split(/\n+/).map(line => line.trim()).filter(Boolean);
  const keep = lines.filter(line => /BOARD|FLIGHT|GATE|SEAT|PASSENGER|FROM|\bTO\b|UNITED|AIRLINE|BAGGAGE|BARCODE|\b[A-Z]{2}\s?\d{2,4}\b/i.test(line));
  return (keep.length ? keep : lines).slice(0, 14).join('\n');
}

function cleanOcrText(text) {
  return (text || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeText(text) {
  return cleanOcrText(text).toUpperCase().replace(/[^A-Z0-9:/. -]/g, ' ');
}

function maskSensitiveText(text) {
  return String(text || '').replace(/(?:\d[ -]?){13,19}/g, (match) => {
    const digits = match.replace(/\D/g, '');
    if (digits.length < 13 || digits.length > 19) return match;
    if (!luhnCheck(digits) && !inferNetworkFromNumber(digits) && digits.length !== 16 && digits.length !== 15) return match;
    return maskCardNumberKeepFirst8(match);
  });
}

function maskCardNumberKeepFirst8(input) {
  const digits = input.replace(/\D/g, '');
  if (digits.length < 8) return input;
  const first8 = digits.slice(0, 8);
  return `${first8.slice(0, 4)} ${first8.slice(4, 8)} ${'•'.repeat(Math.max(4, Math.min(12, digits.length - 8)))}`;
}

function redactDigitsExceptFirst8(text) {
  return String(text || '').replace(/(?:\d[\s-]*){8,19}/g, (match) => {
    const digits = match.replace(/\D/g, '');
    if (digits.length < 8) return match;
    return `${digits.slice(0, 4)} ${digits.slice(4, 8)} ${'•'.repeat(Math.max(4, digits.length - 8))}`;
  }).trim();
}

function extractEvidenceAround(text, needle, chars = 300) {
  if (!needle) return '';
  const idx = text.toUpperCase().indexOf(String(needle).toUpperCase());
  if (idx < 0) return '';
  const start = Math.max(0, idx - Math.floor(chars / 2));
  return text.slice(start, start + chars).trim();
}

function annotateDetections(barcodes, region, cardReads = []) {
  const annotations = barcodes.map((b, idx) => ({
    box: b.box,
    label: `${formatShortBarcode(b.format)} ${idx + 1}`,
    color: '#fcdc00',
    fill: 'rgba(252,220,0,0.16)'
  }));
  if (region && cardReads.length) {
    annotations.push({ box: region, label: 'Selected crop', color: '#38bdf8', fill: 'rgba(56,189,248,0.12)' });
  }
  state.annotations = annotations;
  drawOverlay();
}

function formatShortBarcode(format) {
  if (!format) return 'CODE';
  if (format === 'qr_code') return 'QR';
  return format.toUpperCase().replace('_', ' ');
}

function renderResults(result) {
  els.textOutput.textContent = result.fullText || 'No OCR text detected.';
  els.jsonOutput.textContent = JSON.stringify(result, null, 2);
  els.statText.textContent = String(result.fullText.length);
  els.statItems.textContent = String(result.items.length);
  els.statBarcode.textContent = String(result.detections?.barcodes?.length || 0);
  els.statCard8.textContent = String((result.detections?.cardFirst8 || []).filter(x => x.first8 && x.first8 !== 'not detected').length);
  els.copyJsonBtn.disabled = false;

  if (!result.items.length) {
    els.items.className = 'cards empty';
    els.items.textContent = 'No classified items found.';
    return;
  }

  els.items.className = 'cards';
  els.items.innerHTML = result.items.map(renderItemCard).join('');
}

function renderItemCard(item) {
  const typeLabel = item.type.replace(/_/g, ' ');
  let badgeClass = '';
  if (item.type === 'credit_card') badgeClass = 'card';
  else if (item.type === 'boarding_pass' || item.type === 'boarding_pass_barcode') badgeClass = 'boarding';
  else if (item.type === 'qr_code') badgeClass = 'qr';
  else if (item.type === 'barcode') badgeClass = 'barcode';

  const fields = Object.entries(item.fields || {}).map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(v))}</dd>`).join('');
  const thumb = item.thumbnailId && cardThumbs.has(item.thumbnailId)
    ? `<img class="itemThumb" src="${cardThumbs.get(item.thumbnailId)}" alt="Selected card crop thumbnail" />`
    : '';

  return `
    <article class="itemCard">
      <div class="itemTop">
        <div>
          <h3>${escapeHtml(item.title)}</h3>
          <small>Confidence: ${Math.round((item.confidence || 0) * 100)}%</small>
        </div>
        <span class="badge ${badgeClass}">${escapeHtml(typeLabel)}</span>
      </div>
      ${thumb}
      <dl class="kv">${fields}</dl>
      <div class="evidence">${escapeHtml(item.evidence || '')}</div>
    </article>`;
}

async function copyJson() {
  if (!lastResult) return;
  await navigator.clipboard.writeText(JSON.stringify(lastResult, null, 2));
  setStatus('Structured JSON copied to clipboard. Card thumbnail images are not embedded in the copied JSON.');
}

function cropCanvas(sourceCanvas, region) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(region.width));
  canvas.height = Math.max(1, Math.round(region.height));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(sourceCanvas, region.x, region.y, region.width, region.height, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function makeThumbnailDataUrl(sourceCanvas) {
  const maxSide = 460;
  const scale = Math.min(1, maxSide / Math.max(sourceCanvas.width, sourceCanvas.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(sourceCanvas.width * scale));
  canvas.height = Math.max(1, Math.round(sourceCanvas.height * scale));
  const ctx = canvas.getContext('2d');
  ctx.drawImage(sourceCanvas, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.82);
}

function compactBox(box) {
  return {
    x: Math.round(box.x),
    y: Math.round(box.y),
    width: Math.round(box.width),
    height: Math.round(box.height)
  };
}

function boxToString(box) {
  return `${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.width)}x${Math.round(box.height)}`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function setStatus(message) { els.status.textContent = message; }
function setProgress(percent) { els.progressBar.style.width = `${Math.max(0, Math.min(100, percent))}%`; }
