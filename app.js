/* global Tesseract, jsQR */
const els = {
  video: document.getElementById('video'),
  canvas: document.getElementById('canvas'),
  startCameraBtn: document.getElementById('startCameraBtn'),
  captureBtn: document.getElementById('captureBtn'),
  fileInput: document.getElementById('fileInput'),
  loadSampleBtn: document.getElementById('loadSampleBtn'),
  analyzeBtn: document.getElementById('analyzeBtn'),
  status: document.getElementById('status'),
  progressBar: document.getElementById('progressBar'),
  textOutput: document.getElementById('textOutput'),
  jsonOutput: document.getElementById('jsonOutput'),
  items: document.getElementById('items'),
  statText: document.getElementById('statText'),
  statItems: document.getElementById('statItems'),
  statQr: document.getElementById('statQr'),
  copyJsonBtn: document.getElementById('copyJsonBtn'),
  installBtn: document.getElementById('installBtn')
};

let stream = null;
let lastResult = null;
let deferredInstallPrompt = null;

const state = {
  imageLoaded: false,
  analyzing: false
};

registerServiceWorker();
wireEvents();
setStatus('Ready. Use camera, upload an image, or load the bundled sample.');

function wireEvents() {
  els.startCameraBtn.addEventListener('click', startCamera);
  els.captureBtn.addEventListener('click', captureFromCamera);
  els.fileInput.addEventListener('change', handleFileUpload);
  els.loadSampleBtn.addEventListener('click', () => loadImageUrl('./assets/sample-input.png'));
  els.analyzeBtn.addEventListener('click', analyzeCurrentCanvas);
  els.copyJsonBtn.addEventListener('click', copyJson);

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
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false
    });
    els.video.srcObject = stream;
    await els.video.play();
    els.video.style.display = 'block';
    els.canvas.style.display = 'none';
    els.captureBtn.disabled = false;
    setStatus('Camera active. Place all cards, passes and QR codes in frame, then capture.');
  } catch (err) {
    setStatus(`Camera failed: ${err.message}. Use image upload instead.`);
  }
}

function captureFromCamera() {
  const video = els.video;
  const canvas = els.canvas;
  if (!video.videoWidth) return;
  drawImageToCanvas(video, video.videoWidth, video.videoHeight);
  els.video.style.display = 'none';
  els.canvas.style.display = 'block';
  stopCamera();
  markImageLoaded('Captured image. Ready to analyze.');
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
    markImageLoaded('Image loaded. Ready to analyze.');
  };
  img.onerror = () => setStatus('Could not load image.');
  img.src = url;
}

function drawImageToCanvas(source, width, height) {
  const maxSide = 1800;
  const scale = Math.min(1, maxSide / Math.max(width, height));
  const canvas = els.canvas;
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
}

function markImageLoaded(message) {
  state.imageLoaded = true;
  els.analyzeBtn.disabled = false;
  els.canvas.style.display = 'block';
  setStatus(message);
  setProgress(0);
}

async function analyzeCurrentCanvas() {
  if (!state.imageLoaded || state.analyzing) return;
  state.analyzing = true;
  els.analyzeBtn.disabled = true;
  els.copyJsonBtn.disabled = true;
  setProgress(4);
  setStatus('Starting analysis...');

  try {
    const originalCanvas = els.canvas;
    const ocrCanvas = makeOcrCanvas(originalCanvas);

    setStatus('Detecting QR codes...');
    const qrs = await detectQRCodes(originalCanvas);
    setProgress(20);

    setStatus('Running OCR. This can take 10–40 seconds on mobile devices...');
    const ocr = await runOcr(ocrCanvas);
    setProgress(78);

    setStatus('Classifying cards, boarding passes and QR codes...');
    const result = classifyDocumentSet(ocr.text, qrs);
    result.meta = {
      processedAt: new Date().toISOString(),
      engine: 'browser-pwa-tesseract-js-barcode-detector-jsqr',
      warning: 'Raw card numbers are masked before display. Do not store full PAN or CVV.'
    };
    lastResult = result;

    renderResults(result);
    drawQrBoxes(originalCanvas, qrs);
    setProgress(100);
    setStatus(`Done. Found ${result.items.length} classified item(s), ${qrs.length} QR code(s), and ${result.fullText.length} OCR characters.`);
  } catch (err) {
    console.error(err);
    setStatus(`Analysis failed: ${err.message}`);
  } finally {
    state.analyzing = false;
    els.analyzeBtn.disabled = false;
  }
}

function makeOcrCanvas(sourceCanvas) {
  const canvas = document.createElement('canvas');
  canvas.width = sourceCanvas.width;
  canvas.height = sourceCanvas.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(sourceCanvas, 0, 0);

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    // Slight contrast boost without aggressive thresholding; preserves embossed card text.
    const boosted = Math.max(0, Math.min(255, (gray - 128) * 1.55 + 128));
    data[i] = data[i + 1] = data[i + 2] = boosted;
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

async function runOcr(canvas) {
  if (!window.Tesseract) throw new Error('Tesseract.js did not load. Check internet access or self-host the library.');
  const dataUrl = canvas.toDataURL('image/png');
  const result = await Tesseract.recognize(dataUrl, 'eng', {
    logger: (m) => {
      if (m.status === 'recognizing text' && Number.isFinite(m.progress)) {
        setProgress(20 + Math.round(m.progress * 55));
        setStatus(`OCR: ${Math.round(m.progress * 100)}%`);
      }
    }
  });
  return { text: result.data?.text || '' };
}

async function detectQRCodes(canvas) {
  const detected = [];

  // Fast path: native browser detector. It can detect multiple codes when supported.
  if ('BarcodeDetector' in window) {
    try {
      const formats = await BarcodeDetector.getSupportedFormats?.();
      if (!formats || formats.includes('qr_code')) {
        const detector = new BarcodeDetector({ formats: ['qr_code'] });
        const barcodes = await detector.detect(canvas);
        for (const code of barcodes) {
          detected.push({
            type: 'qr_code',
            rawValue: code.rawValue || '',
            box: normalizeBoundingBox(code.boundingBox),
            source: 'BarcodeDetector'
          });
        }
      }
    } catch (err) {
      console.warn('BarcodeDetector failed; using jsQR fallback', err);
    }
  }

  // Fallback: jsQR scans the full image and overlapping tiles. Useful on Safari/Firefox.
  if (window.jsQR) {
    const fallback = scanWithJsQrTiles(canvas);
    detected.push(...fallback);
  }

  return uniqueQrs(detected);
}

function normalizeBoundingBox(box) {
  if (!box) return null;
  return { x: box.x, y: box.y, width: box.width, height: box.height };
}

function scanWithJsQrTiles(canvas) {
  const found = [];
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const full = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const whole = jsQR(full.data, full.width, full.height, { inversionAttempts: 'attemptBoth' });
  if (whole) found.push(qrFromJsQr(whole, 0, 0, 'jsQR-full'));

  const tileSize = Math.round(Math.min(canvas.width, canvas.height) * 0.42);
  const step = Math.max(160, Math.round(tileSize * 0.55));
  if (tileSize < 180) return found;

  for (let y = 0; y < canvas.height; y += step) {
    for (let x = 0; x < canvas.width; x += step) {
      const w = Math.min(tileSize, canvas.width - x);
      const h = Math.min(tileSize, canvas.height - y);
      if (w < 160 || h < 160) continue;
      const tile = ctx.getImageData(x, y, w, h);
      const qr = jsQR(tile.data, tile.width, tile.height, { inversionAttempts: 'attemptBoth' });
      if (qr) found.push(qrFromJsQr(qr, x, y, 'jsQR-tile'));
    }
  }
  return found;
}

function qrFromJsQr(qr, offsetX, offsetY, source) {
  const points = [qr.location.topLeftCorner, qr.location.topRightCorner, qr.location.bottomRightCorner, qr.location.bottomLeftCorner];
  const xs = points.map(p => p.x + offsetX);
  const ys = points.map(p => p.y + offsetY);
  return {
    type: 'qr_code',
    rawValue: qr.data || '',
    box: { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) },
    source
  };
}

function uniqueQrs(qrs) {
  const out = [];
  const seen = new Set();
  for (const qr of qrs) {
    const key = qr.rawValue ? qr.rawValue : `${Math.round(qr.box?.x || 0)}-${Math.round(qr.box?.y || 0)}-${qr.source}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(qr);
  }
  return out;
}

function classifyDocumentSet(rawText, qrs) {
  const fullText = maskSensitiveText(cleanOcrText(rawText));
  const normalized = normalizeText(rawText);
  const items = [];

  const cards = classifyCards(rawText, normalized);
  items.push(...cards);

  const boardingPass = classifyBoardingPass(rawText, normalized);
  if (boardingPass) items.push(boardingPass);

  qrs.forEach((qr, index) => items.push(classifyQr(qr, index)));

  if (!items.length && fullText.trim()) {
    items.push({
      id: 'unknown-1',
      type: 'unknown',
      title: 'Unclassified text block',
      confidence: 0.3,
      fields: {},
      evidence: fullText.slice(0, 800)
    });
  }

  return { fullText, items };
}

function classifyCards(rawText, normalized) {
  const items = [];
  const candidates = [];
  const numbers = extractPotentialCardNumbers(rawText);
  for (const n of numbers) {
    const network = inferNetworkFromNumber(n.digits);
    if (network) candidates.push({ network, maskedNumber: maskCardNumber(n.original), evidence: n.original, source: 'number' });
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
      candidates.push({ network: hint.network, maskedNumber: null, evidence: hint.network, source: 'text' });
    }
  }

  const issuers = inferIssuers(rawText);
  const uniqueNetworks = new Map();
  for (const cand of candidates) {
    const key = `${cand.network}-${cand.maskedNumber || 'text'}`;
    if (!uniqueNetworks.has(key)) uniqueNetworks.set(key, cand);
  }

  let i = 1;
  for (const cand of uniqueNetworks.values()) {
    items.push({
      id: `card-${i++}`,
      type: 'credit_card',
      title: `${cand.network} payment card`,
      confidence: cand.source === 'number' ? 0.88 : 0.72,
      fields: {
        network: cand.network,
        maskedNumber: cand.maskedNumber || 'not detected',
        issuerHints: issuers.length ? issuers.join(', ') : 'not detected'
      },
      evidence: maskSensitiveText(extractEvidenceAround(rawText, cand.evidence, 280) || cand.evidence)
    });
  }

  // When OCR sees issuer names but no clear network, still surface likely card objects.
  if (!items.length && issuers.length && /CARD|CREDIT|DEBIT|PREMIER|RESERVE|PLATINUM|GOLD|SAPPHIRE|VENTURE/i.test(rawText)) {
    items.push({
      id: 'card-1',
      type: 'credit_card',
      title: 'Payment card',
      confidence: 0.58,
      fields: { network: 'not detected', maskedNumber: 'not detected', issuerHints: issuers.join(', ') },
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
    .filter(x => luhnCheck(x.digits));
}

function luhnCheck(digits) {
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
  if (digits.length === 16 && (first2 >= 51 && first2 <= 55 || first4 >= 2221 && first4 <= 2720)) return 'Mastercard';
  if (/^6(?:011|5\d{2})/.test(digits)) return 'Discover';
  if (/^35\d{14,17}/.test(digits)) return 'JCB';
  if (/^62\d{14,17}/.test(digits)) return 'UnionPay';
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
    id: 'boarding-pass-1',
    type: 'boarding_pass',
    title: 'Boarding pass',
    confidence: Math.min(0.95, 0.52 + hits * 0.07 + (flight ? 0.12 : 0)),
    fields,
    evidence: maskSensitiveText(extractLikelyBoardingEvidence(rawText))
  };
}

function extractPassenger(text) {
  const labelMatch = text.match(/PASSENGER\s*[:\-]?\s*([A-Z][A-Z .'-]{2,40})/i);
  if (labelMatch) return labelMatch[1].split(/\n/)[0].trim();

  // Simple boarding-pass style uppercase name heuristic.
  const lines = text.split(/\n+/).map(x => x.trim()).filter(Boolean);
  const nameLine = lines.find(line => /^[A-Z][A-Z .'-]{3,34}$/.test(line) && !/BOARDING|FLIGHT|GATE|SEAT|UNITED|AIRLINE/i.test(line));
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

function classifyQr(qr, index) {
  const payload = qr.rawValue || '';
  const normalizedPayload = normalizeText(payload);
  let qrClass = 'General QR code';
  if (/BOOK|BOOKING|PNR|RESERVATION/.test(normalizedPayload)) qrClass = 'Booking reference QR';
  else if (/CHECK.?IN|BOARD|AIRLINE/.test(normalizedPayload)) qrClass = 'Check-in / boarding QR';
  else if (/LOUNGE|ACCESS|PRIORITY|PASS/.test(normalizedPayload)) qrClass = 'Lounge access QR';
  else if (/^https?:\/\//i.test(payload)) qrClass = 'URL QR code';

  return {
    id: `qr-${index + 1}`,
    type: 'qr_code',
    title: qrClass,
    confidence: payload ? 0.9 : 0.55,
    fields: {
      payload: payload || 'detected but payload not decoded',
      source: qr.source,
      location: qr.box ? `${Math.round(qr.box.x)},${Math.round(qr.box.y)} ${Math.round(qr.box.width)}x${Math.round(qr.box.height)}` : 'not available'
    },
    evidence: payload || 'QR pattern detected visually, but no data payload was available.'
  };
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
  return text.replace(/(?:\d[ -]?){13,19}/g, (match) => {
    const digits = match.replace(/\D/g, '');
    if (digits.length < 13 || digits.length > 19 || !luhnCheck(digits)) return match;
    return maskCardNumber(match);
  });
}

function maskCardNumber(input) {
  const digits = input.replace(/\D/g, '');
  const last4 = digits.slice(-4);
  return `•••• •••• •••• ${last4}`;
}

function extractEvidenceAround(text, needle, chars = 300) {
  if (!needle) return '';
  const idx = text.toUpperCase().indexOf(String(needle).toUpperCase());
  if (idx < 0) return '';
  const start = Math.max(0, idx - Math.floor(chars / 2));
  return text.slice(start, start + chars).trim();
}

function drawQrBoxes(canvas, qrs) {
  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.lineWidth = Math.max(3, Math.round(canvas.width / 380));
  ctx.strokeStyle = '#fcdc00';
  ctx.fillStyle = 'rgba(252,220,0,0.16)';
  ctx.font = `${Math.max(14, Math.round(canvas.width / 70))}px sans-serif`;
  qrs.forEach((qr, idx) => {
    if (!qr.box) return;
    ctx.fillRect(qr.box.x, qr.box.y, qr.box.width, qr.box.height);
    ctx.strokeRect(qr.box.x, qr.box.y, qr.box.width, qr.box.height);
    ctx.fillStyle = '#111827';
    ctx.fillText(`QR ${idx + 1}`, qr.box.x + 6, Math.max(20, qr.box.y - 8));
    ctx.fillStyle = 'rgba(252,220,0,0.16)';
  });
  ctx.restore();
}

function renderResults(result) {
  els.textOutput.textContent = result.fullText || 'No OCR text detected.';
  els.jsonOutput.textContent = JSON.stringify(result, null, 2);
  els.statText.textContent = String(result.fullText.length);
  els.statItems.textContent = String(result.items.length);
  els.statQr.textContent = String(result.items.filter(i => i.type === 'qr_code').length);
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
  const badgeClass = item.type === 'credit_card' ? 'card' : item.type === 'boarding_pass' ? 'boarding' : item.type === 'qr_code' ? 'qr' : '';
  const fields = Object.entries(item.fields || {}).map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(v))}</dd>`).join('');
  return `
    <article class="itemCard">
      <div class="itemTop">
        <div>
          <h3>${escapeHtml(item.title)}</h3>
          <small>Confidence: ${Math.round((item.confidence || 0) * 100)}%</small>
        </div>
        <span class="badge ${badgeClass}">${escapeHtml(typeLabel)}</span>
      </div>
      <dl class="kv">${fields}</dl>
      <div class="evidence">${escapeHtml(item.evidence || '')}</div>
    </article>`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function copyJson() {
  if (!lastResult) return;
  await navigator.clipboard.writeText(JSON.stringify(lastResult, null, 2));
  setStatus('Structured JSON copied to clipboard.');
}

function setStatus(message) { els.status.textContent = message; }
function setProgress(percent) { els.progressBar.style.width = `${Math.max(0, Math.min(100, percent))}%`; }
