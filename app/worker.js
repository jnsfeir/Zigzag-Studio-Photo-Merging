// Pure-JS flambient pipeline — no OpenCV, no WASM
// Mertens fusion with blurred weight maps (prevents halos at high-contrast edges)

function post(type, extra) { self.postMessage({ type, ...extra }); }
function progress(pct, label) { post('progress', { progress: pct, label }); }
function fail(msg) { post('error', { error: msg }); }

// ── RAW detection & embedded JPEG extraction ──────────────────────────────────
function isRawBuffer(buf) {
  if (buf.byteLength < 8) return false;
  const b = new Uint8Array(buf);
  if (b[4]===0x66&&b[5]===0x74&&b[6]===0x79&&b[7]===0x70) return true; // CR3
  if (b[0]===0x49&&b[1]===0x49&&b[2]===0x2A&&b[3]===0x00) return true; // TIFF-LE
  if (b[0]===0x4D&&b[1]===0x4D&&b[2]===0x00&&b[3]===0x2A) return true; // TIFF-BE
  return false;
}

function extractLargestJpeg(buf) {
  const bytes = new Uint8Array(buf);
  const limit = Math.min(bytes.length, 40 * 1024 * 1024);
  let bestStart = -1, bestLen = 0, i = 0;
  while (i < limit - 3) {
    if (bytes[i]===0xFF && bytes[i+1]===0xD8 && bytes[i+2]===0xFF) {
      let j = i + 2;
      while (j < limit - 1) {
        if (bytes[j]===0xFF && bytes[j+1]===0xD9) { j += 2; break; }
        j++;
      }
      const len = j - i;
      if (len > bestLen && len > 100 * 1024) { bestLen = len; bestStart = i; }
      i = j;
    } else { i++; }
  }
  return bestStart >= 0 ? buf.slice(bestStart, bestStart + bestLen) : null;
}

// ── Buffer → ImageData ────────────────────────────────────────────────────────
async function bufToImageData(buf) {
  let blob;
  if (isRawBuffer(buf)) {
    const jpegBuf = extractLargestJpeg(buf);
    blob = jpegBuf ? new Blob([jpegBuf], { type: 'image/jpeg' }) : new Blob([buf]);
  } else {
    blob = new Blob([buf]);
  }
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  bitmap.close();
  return canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
}

// ── White balance (conservative highlight-based) ──────────────────────────────
// Only adjusts if there is a measurable color cast in the highlights.
function whiteBalance(imageData) {
  const { data, width, height } = imageData;
  const n = width * height;

  let maxLum = 0;
  for (let i = 0; i < n; i++) {
    const lum = 0.299 * data[i*4] + 0.587 * data[i*4+1] + 0.114 * data[i*4+2];
    if (lum > maxLum) maxLum = lum;
  }
  const thresh = maxLum * 0.72;

  let rSum = 0, gSum = 0, bSum = 0, count = 0;
  for (let i = 0; i < n; i++) {
    const lum = 0.299 * data[i*4] + 0.587 * data[i*4+1] + 0.114 * data[i*4+2];
    if (lum >= thresh) {
      rSum += data[i*4]; gSum += data[i*4+1]; bSum += data[i*4+2];
      count++;
    }
  }
  if (count < 100) return imageData;

  const rMean = rSum / count;
  const gMean = gSum / count;
  const bMean = bSum / count;

  // Only correct if cast is > 5 % — avoids overcorrecting neutral scenes
  const rRatio = gMean / Math.max(rMean, 1);
  const bRatio = gMean / Math.max(bMean, 1);
  if (Math.abs(rRatio - 1) < 0.05 && Math.abs(bRatio - 1) < 0.05) return imageData;

  // Clamp scale to ±25 % to avoid aggressive shifts
  const rScale = Math.max(0.75, Math.min(1.25, rRatio * 1.01));
  const bScale = Math.max(0.75, Math.min(1.25, bRatio * 0.97));

  const out = new Uint8ClampedArray(data);
  for (let i = 0; i < n; i++) {
    out[i*4]   = Math.min(255, data[i*4]   * rScale);
    out[i*4+2] = Math.min(255, data[i*4+2] * bScale);
  }
  return new ImageData(out, width, height);
}

// ── Weight map ────────────────────────────────────────────────────────────────
// contrast=0, saturation=0.6, exposedness=1.0 (flambient tuning)
function computeWeightMap(imageData) {
  const { data } = imageData;
  const n = data.length / 4;
  const weights = new Float32Array(n);
  const INV_SIGMA2 = 1 / (2 * 0.2 * 0.2);

  for (let i = 0; i < n; i++) {
    const r = data[i*4]   / 255;
    const g = data[i*4+1] / 255;
    const b = data[i*4+2] / 255;
    const wExp = Math.exp(-((r-.5)**2 + (g-.5)**2 + (b-.5)**2) * INV_SIGMA2);
    const mean = (r + g + b) / 3;
    const wSat = Math.sqrt(((r-mean)**2 + (g-mean)**2 + (b-mean)**2) / 3);
    weights[i] = Math.pow(Math.max(wExp, 1e-6), 1.0)
               * Math.pow(Math.max(wSat, 1e-6), 0.6)
               + 1e-12;
  }
  return weights;
}

// Blur a weight map via OffscreenCanvas CSS blur (GPU-accelerated).
// Smoothing weight maps prevents halos at high-contrast edges.
async function blurWeightMap(weights, width, height, sigma) {
  let maxW = 0;
  for (let i = 0; i < weights.length; i++) if (weights[i] > maxW) maxW = weights[i];
  const scale    = maxW > 0 ? 255 / maxW : 1;
  const invScale = maxW > 0 ? maxW / 255 : 1;

  const imgData = new ImageData(width, height);
  for (let i = 0; i < weights.length; i++) {
    const v = Math.round(Math.min(255, weights[i] * scale));
    imgData.data[i*4] = imgData.data[i*4+1] = imgData.data[i*4+2] = v;
    imgData.data[i*4+3] = 255;
  }

  const srcCanvas = new OffscreenCanvas(width, height);
  srcCanvas.getContext('2d').putImageData(imgData, 0, 0);

  const blurCanvas = new OffscreenCanvas(width, height);
  const blurCtx    = blurCanvas.getContext('2d');
  blurCtx.filter   = `blur(${sigma}px)`;
  blurCtx.drawImage(srcCanvas, 0, 0);

  const blurred = blurCtx.getImageData(0, 0, width, height).data;
  const result  = new Float32Array(weights.length);
  for (let i = 0; i < result.length; i++) result[i] = blurred[i*4] * invScale;
  return result;
}

// ── Mertens fusion with smooth weight maps ────────────────────────────────────
async function fuseMertens(imgs) {
  const { width, height } = imgs[0];
  const n = width * height;

  // Blur sigma scales with image width — larger images need larger blur radius
  const sigma = Math.max(8, Math.round(width / 250));

  const rawW = imgs.map(img => computeWeightMap(img));
  const blurW = await Promise.all(rawW.map(w => blurWeightMap(w, width, height, sigma)));

  // Normalise blurred weights
  const totalW = new Float32Array(n);
  for (const w of blurW) for (let i = 0; i < n; i++) totalW[i] += w[i];

  const [d0, d1, d2] = imgs.map(img => img.data);
  const [w0, w1, w2] = blurW;
  const out = new Uint8ClampedArray(n * 4);

  for (let i = 0; i < n; i++) {
    const p  = i * 4;
    const tw = totalW[i];
    out[p]   = Math.min(255, (d0[p]   * w0[i] + d1[p]   * w1[i] + d2[p]   * w2[i]) / tw);
    out[p+1] = Math.min(255, (d0[p+1] * w0[i] + d1[p+1] * w1[i] + d2[p+1] * w2[i]) / tw);
    out[p+2] = Math.min(255, (d0[p+2] * w0[i] + d1[p+2] * w1[i] + d2[p+2] * w2[i]) / tw);
    out[p+3] = 255;
  }
  return new ImageData(out, width, height);
}

// ── Shadow lift via LUT ───────────────────────────────────────────────────────
function shadowLift(imageData) {
  const lut = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    const t   = i / 255;
    const out = t < 0.5
      ? Math.pow(t / 0.5, 0.88) * 0.5
      : 0.5 + (t - 0.5) * 0.97;
    lut[i] = Math.min(255, Math.max(0, Math.round(out * 255)));
  }
  const { data, width, height } = imageData;
  const out = new Uint8ClampedArray(data);
  for (let i = 0; i < data.length; i += 4) {
    out[i]   = lut[data[i]];
    out[i+1] = lut[data[i+1]];
    out[i+2] = lut[data[i+2]];
  }
  return new ImageData(out, width, height);
}

// ── Clarity (unsharp mask via OffscreenCanvas blur) ───────────────────────────
function addClarity(imageData) {
  const { data, width, height } = imageData;

  const srcCanvas = new OffscreenCanvas(width, height);
  srcCanvas.getContext('2d').putImageData(imageData, 0, 0);

  const blurCanvas = new OffscreenCanvas(width, height);
  const blurCtx    = blurCanvas.getContext('2d');
  blurCtx.filter   = 'blur(12px)';
  blurCtx.drawImage(srcCanvas, 0, 0);
  const blurred = blurCtx.getImageData(0, 0, width, height).data;

  const out = new Uint8ClampedArray(data.length);
  for (let i = 0; i < data.length; i += 4) {
    out[i]   = Math.min(255, Math.max(0, data[i]   * 1.12 - blurred[i]   * 0.12));
    out[i+1] = Math.min(255, Math.max(0, data[i+1] * 1.12 - blurred[i+1] * 0.12));
    out[i+2] = Math.min(255, Math.max(0, data[i+2] * 1.12 - blurred[i+2] * 0.12));
    out[i+3] = 255;
  }
  return new ImageData(out, width, height);
}

// ── Main handler ──────────────────────────────────────────────────────────────
self.onmessage = async (e) => {
  if (e.data.type !== 'merge') return;
  const { under, normal, over } = e.data;

  try {
    progress(5, 'Decoding images...');
    const [imgUnder, imgNormal, imgOver] = await Promise.all([
      bufToImageData(under),
      bufToImageData(normal),
      bufToImageData(over),
    ]);

    const { width, height } = imgUnder;
    if (imgNormal.width !== width || imgNormal.height !== height) {
      throw new Error('All three images must have the same dimensions.');
    }

    progress(18, 'White balancing...');
    const wbUnder  = whiteBalance(imgUnder);
    const wbNormal = whiteBalance(imgNormal);
    const wbOver   = whiteBalance(imgOver);

    progress(32, 'Computing weight maps...');
    // (weight blur happens inside fuseMertens, shown as part of fusion step)

    progress(38, 'Fusing exposures...');
    const fused = await fuseMertens([wbUnder, wbNormal, wbOver]);

    progress(72, 'Lifting shadows...');
    const lifted = shadowLift(fused);

    progress(84, 'Adding clarity...');
    const final = addClarity(lifted);

    progress(97, 'Finalizing...');
    const buf = final.data.buffer.slice(0);
    progress(100, 'Done');
    self.postMessage({ type: 'result', result: { width, height, data: buf } }, [buf]);

  } catch (err) {
    fail('Processing failed: ' + (err?.message || String(err)));
  }
};
