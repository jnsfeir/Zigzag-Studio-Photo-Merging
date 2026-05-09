// Pure-JS flambient pipeline — no OpenCV, no WASM, no loading delay

function post(type, extra) { self.postMessage({ type, ...extra }); }
function progress(pct, label) { post('progress', { progress: pct, label }); }
function fail(msg) { post('error', { error: msg }); }

// ── RAW detection & embedded JPEG extraction ──────────────────────────────────
function isRawBuffer(buf) {
  if (buf.byteLength < 8) return false;
  const b = new Uint8Array(buf);
  if (b[4]===0x66&&b[5]===0x74&&b[6]===0x79&&b[7]===0x70) return true; // CR3 ISOBMFF
  if (b[0]===0x49&&b[1]===0x49&&b[2]===0x2A&&b[3]===0x00) return true; // TIFF-LE
  if (b[0]===0x4D&&b[1]===0x4D&&b[2]===0x00&&b[3]===0x2A) return true; // TIFF-BE
  return false;
}

function extractLargestJpeg(buf) {
  const bytes  = new Uint8Array(buf);
  const limit  = Math.min(bytes.length, 40 * 1024 * 1024);
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

// ── White balance (highlight-based) ──────────────────────────────────────────
// Samples top ~15 % brightest pixels; scales R and B toward G mean.
function whiteBalance(imageData) {
  const { data, width, height } = imageData;
  const n = width * height;

  // Luminance max (fast — single pass, no sort)
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
  const rScale = (gMean / Math.max(rMean, 1)) * 1.01;  // tiny red lift for warmth
  const bScale = (gMean / Math.max(bMean, 1)) * 0.97;  // slight blue compression

  const out = new Uint8ClampedArray(data);
  for (let i = 0; i < n; i++) {
    out[i*4]   = Math.min(255, data[i*4]   * rScale);
    out[i*4+2] = Math.min(255, data[i*4+2] * bScale);
  }
  return new ImageData(out, width, height);
}

// ── Mertens exposure fusion (memory-efficient single-pass) ────────────────────
// contrast=0, saturation=0.6, exposedness=1.0 — tuned for flambient
function fuseMertens(imgs) {
  const { width, height } = imgs[0];
  const n   = width * height;
  const d0  = imgs[0].data, d1 = imgs[1].data, d2 = imgs[2].data;
  const out = new Uint8ClampedArray(n * 4);
  const INV_SIGMA2 = 1 / (2 * 0.2 * 0.2);   // exposedness Gaussian sigma=0.2

  for (let i = 0; i < n; i++) {
    const p = i * 4;

    // --- image 0 ---
    const r0 = d0[p]/255, g0 = d0[p+1]/255, b0 = d0[p+2]/255;
    const m0 = (r0+g0+b0)/3;
    const wExp0 = Math.exp(-((r0-.5)**2+(g0-.5)**2+(b0-.5)**2)*INV_SIGMA2);
    const wSat0 = Math.sqrt(((r0-m0)**2+(g0-m0)**2+(b0-m0)**2)/3);
    const w0 = Math.pow(Math.max(wExp0,1e-6),1.0) * Math.pow(Math.max(wSat0,1e-6),0.6) + 1e-12;

    // --- image 1 ---
    const r1 = d1[p]/255, g1 = d1[p+1]/255, b1 = d1[p+2]/255;
    const m1 = (r1+g1+b1)/3;
    const wExp1 = Math.exp(-((r1-.5)**2+(g1-.5)**2+(b1-.5)**2)*INV_SIGMA2);
    const wSat1 = Math.sqrt(((r1-m1)**2+(g1-m1)**2+(b1-m1)**2)/3);
    const w1 = Math.pow(Math.max(wExp1,1e-6),1.0) * Math.pow(Math.max(wSat1,1e-6),0.6) + 1e-12;

    // --- image 2 ---
    const r2 = d2[p]/255, g2 = d2[p+1]/255, b2 = d2[p+2]/255;
    const m2 = (r2+g2+b2)/3;
    const wExp2 = Math.exp(-((r2-.5)**2+(g2-.5)**2+(b2-.5)**2)*INV_SIGMA2);
    const wSat2 = Math.sqrt(((r2-m2)**2+(g2-m2)**2+(b2-m2)**2)/3);
    const w2 = Math.pow(Math.max(wExp2,1e-6),1.0) * Math.pow(Math.max(wSat2,1e-6),0.6) + 1e-12;

    const wSum = w0 + w1 + w2;
    out[p]   = Math.min(255, (d0[p]   * w0 + d1[p]   * w1 + d2[p]   * w2) / wSum);
    out[p+1] = Math.min(255, (d0[p+1] * w0 + d1[p+1] * w1 + d2[p+1] * w2) / wSum);
    out[p+2] = Math.min(255, (d0[p+2] * w0 + d1[p+2] * w1 + d2[p+2] * w2) / wSum);
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

// ── Clarity via OffscreenCanvas blur filter (hardware-accelerated) ────────────
function addClarity(imageData) {
  const { width, height, data } = imageData;

  // Draw source onto a canvas
  const srcCanvas = new OffscreenCanvas(width, height);
  srcCanvas.getContext('2d').putImageData(imageData, 0, 0);

  // Blur it with CSS blur (browser-native, GPU-accelerated)
  const blurCanvas = new OffscreenCanvas(width, height);
  const blurCtx    = blurCanvas.getContext('2d');
  blurCtx.filter   = 'blur(12px)';
  blurCtx.drawImage(srcCanvas, 0, 0);
  const blurred = blurCtx.getImageData(0, 0, width, height).data;

  // Unsharp mask: result = src * 1.12 - blurred * 0.12
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

    progress(35, 'Fusing exposures (flambient)...');
    const fused = fuseMertens([wbUnder, wbNormal, wbOver]);

    progress(70, 'Lifting shadows...');
    const lifted = shadowLift(fused);

    progress(82, 'Adding clarity...');
    const final = addClarity(lifted);

    progress(96, 'Finalizing...');
    const buf = final.data.buffer.slice(0);
    progress(100, 'Done');
    self.postMessage({ type: 'result', result: { width, height, data: buf } }, [buf]);

  } catch (err) {
    fail('Processing failed: ' + (err?.message || String(err)));
  }
};
