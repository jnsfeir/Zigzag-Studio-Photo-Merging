// Flambient pipeline — alignment + luminosity-based exposure blending
// Aligns under/over to normal via two-level correlation pyramid before blending.

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

// ── Alignment ─────────────────────────────────────────────────────────────────

// Box-average downsample to grayscale Float32
function downsampleGray(imageData, factor) {
  const { data, width, height } = imageData;
  const dw = Math.floor(width  / factor);
  const dh = Math.floor(height / factor);
  const out = new Float32Array(dw * dh);
  const f2  = factor * factor;
  for (let dy = 0; dy < dh; dy++) {
    for (let dx = 0; dx < dw; dx++) {
      let sum = 0;
      for (let fy = 0; fy < factor; fy++) {
        const row = (dy * factor + fy) * width;
        for (let fx = 0; fx < factor; fx++) {
          const p = (row + dx * factor + fx) * 4;
          sum += 0.2126 * data[p] + 0.7152 * data[p+1] + 0.0722 * data[p+2];
        }
      }
      out[dy * dw + dx] = sum / (f2 * 255);
    }
  }
  return { gray: out, w: dw, h: dh };
}

// Zero-mean cross-correlation; searches around (cDx, cDy) ± (maxDx, maxDy)
function findTranslation(ref, src, w, h, cDx, cDy, maxDx, maxDy) {
  let mu = 0;
  for (let i = 0; i < w * h; i++) mu += ref[i];
  mu /= w * h;

  let bestDx = cDx, bestDy = cDy, bestScore = -Infinity;

  for (let dy = cDy - maxDy; dy <= cDy + maxDy; dy++) {
    for (let dx = cDx - maxDx; dx <= cDx + maxDx; dx++) {
      let score = 0;
      const y0 = Math.max(0, dy),  y1 = Math.min(h, h + dy);
      const x0 = Math.max(0, dx),  x1 = Math.min(w, w + dx);
      for (let y = y0; y < y1; y++) {
        const ry = y * w, sy = (y - dy) * w;
        for (let x = x0; x < x1; x++) {
          score += (ref[ry + x] - mu) * src[sy + (x - dx)];
        }
      }
      if (score > bestScore) { bestScore = score; bestDx = dx; bestDy = dy; }
    }
  }
  return { dx: bestDx, dy: bestDy };
}

// Backward-map translation: out[y][x] = src[y-dy][x-dx]
function applyTranslation(imageData, dx, dy) {
  if (dx === 0 && dy === 0) return imageData;
  const { data, width, height } = imageData;
  const out = new Uint8ClampedArray(data.length);
  for (let y = 0; y < height; y++) {
    const sy = y - dy;
    if (sy < 0 || sy >= height) continue;
    const rowSrc = sy * width, rowDst = y * width;
    for (let x = 0; x < width; x++) {
      const sx = x - dx;
      if (sx < 0 || sx >= width) continue;
      const sp = (rowSrc + sx) * 4, dp = (rowDst + x) * 4;
      out[dp] = data[sp]; out[dp+1] = data[sp+1];
      out[dp+2] = data[sp+2]; out[dp+3] = data[sp+3];
    }
  }
  return new ImageData(out, width, height);
}

// Two-level pyramid alignment: coarse at 1/f1, refined at 1/f2
function alignToRef(src, ref) {
  const { width, height } = ref;
  const f1 = Math.max(4, Math.round(width / 500));  // coarse scale
  const f2 = Math.max(2, Math.round(width / 1000)); // fine scale

  const c1 = downsampleGray(ref, f1), s1 = downsampleGray(src, f1);
  const coarse = findTranslation(c1.gray, s1.gray, c1.w, c1.h, 0, 0, 10, 10);

  const c2 = downsampleGray(ref, f2), s2 = downsampleGray(src, f2);
  const cx = Math.round(coarse.dx * f1 / f2);
  const cy = Math.round(coarse.dy * f1 / f2);
  const fine = findTranslation(c2.gray, s2.gray, c2.w, c2.h, cx, cy, 4, 4);

  const dx = Math.round(fine.dx * f2);
  const dy = Math.round(fine.dy * f2);
  return applyTranslation(src, dx, dy);
}

// ── Luminosity masks ──────────────────────────────────────────────────────────
function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function buildHighlightMask(imageData) {
  const { data } = imageData;
  const n = data.length / 4;
  const mask = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const lum = (0.2126 * data[i*4] + 0.7152 * data[i*4+1] + 0.0722 * data[i*4+2]) / 255;
    mask[i] = smoothstep(0.75, 0.96, lum);
  }
  return mask;
}

function buildShadowMask(imageData) {
  const { data } = imageData;
  const n = data.length / 4;
  const mask = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const lum = (0.2126 * data[i*4] + 0.7152 * data[i*4+1] + 0.0722 * data[i*4+2]) / 255;
    mask[i] = 1 - smoothstep(0.04, 0.22, lum);
  }
  return mask;
}

async function blurMask(mask, width, height, sigma) {
  let maxW = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i] > maxW) maxW = mask[i];
  const scale    = maxW > 0 ? 255 / maxW : 1;
  const invScale = maxW > 0 ? maxW / 255 : 1;

  const imgData = new ImageData(width, height);
  for (let i = 0; i < mask.length; i++) {
    const v = Math.round(Math.min(255, mask[i] * scale));
    imgData.data[i*4] = imgData.data[i*4+1] = imgData.data[i*4+2] = v;
    imgData.data[i*4+3] = 255;
  }
  const src = new OffscreenCanvas(width, height);
  src.getContext('2d').putImageData(imgData, 0, 0);

  const dst = new OffscreenCanvas(width, height);
  const dCtx = dst.getContext('2d');
  dCtx.filter = `blur(${sigma}px)`;
  dCtx.drawImage(src, 0, 0);

  const blurred = dCtx.getImageData(0, 0, width, height).data;
  const result  = new Float32Array(mask.length);
  for (let i = 0; i < result.length; i++) result[i] = blurred[i*4] * invScale;
  return result;
}

// ── Exposure blend ────────────────────────────────────────────────────────────
function blendExposures(imgNormal, imgUnder, imgOver, hiMask, shadMask) {
  const { width, height } = imgNormal;
  const n = width * height;
  const dN = imgNormal.data, dU = imgUnder.data, dO = imgOver.data;
  const out = new Uint8ClampedArray(n * 4);

  for (let i = 0; i < n; i++) {
    const p = i * 4;
    const hi = hiMask[i], shad = shadMask[i];
    const total = hi + shad;
    const s = total > 1 ? 1 / total : 1;
    const hiN = hi * s, shadN = shad * s, base = 1 - hiN - shadN;

    out[p]   = dN[p]   * base + dU[p]   * hiN + dO[p]   * shadN;
    out[p+1] = dN[p+1] * base + dU[p+1] * hiN + dO[p+1] * shadN;
    out[p+2] = dN[p+2] * base + dU[p+2] * hiN + dO[p+2] * shadN;
    out[p+3] = 255;
  }
  return new ImageData(out, width, height);
}

// ── Gentle clarity (unsharp mask) ────────────────────────────────────────────
function addClarity(imageData) {
  const { data, width, height } = imageData;
  const srcCanvas = new OffscreenCanvas(width, height);
  srcCanvas.getContext('2d').putImageData(imageData, 0, 0);
  const blurCanvas = new OffscreenCanvas(width, height);
  const blurCtx = blurCanvas.getContext('2d');
  blurCtx.filter = 'blur(18px)';
  blurCtx.drawImage(srcCanvas, 0, 0);
  const blurred = blurCtx.getImageData(0, 0, width, height).data;
  const out = new Uint8ClampedArray(data.length);
  for (let i = 0; i < data.length; i += 4) {
    out[i]   = Math.min(255, Math.max(0, data[i]   * 1.06 - blurred[i]   * 0.06));
    out[i+1] = Math.min(255, Math.max(0, data[i+1] * 1.06 - blurred[i+1] * 0.06));
    out[i+2] = Math.min(255, Math.max(0, data[i+2] * 1.06 - blurred[i+2] * 0.06));
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

    const { width, height } = imgNormal;
    if (imgUnder.width !== width || imgUnder.height !== height ||
        imgOver.width  !== width || imgOver.height  !== height) {
      throw new Error('All three images must have the same dimensions.');
    }

    progress(15, 'Aligning underexposed...');
    const alignedUnder = alignToRef(imgUnder, imgNormal);

    progress(28, 'Aligning overexposed...');
    const alignedOver = alignToRef(imgOver, imgNormal);

    progress(40, 'Building luminosity masks...');
    const rawHi   = buildHighlightMask(imgNormal);
    const rawShad = buildShadowMask(imgNormal);

    progress(52, 'Smoothing masks...');
    const sigma = Math.max(20, Math.round(width / 150));
    const [hiMask, shadMask] = await Promise.all([
      blurMask(rawHi,   width, height, sigma),
      blurMask(rawShad, width, height, sigma),
    ]);

    progress(68, 'Blending exposures...');
    const blended = blendExposures(imgNormal, alignedUnder, alignedOver, hiMask, shadMask);

    progress(86, 'Adding clarity...');
    const final = addClarity(blended);

    progress(97, 'Finalizing...');
    const buf = final.data.buffer.slice(0);
    progress(100, 'Done');
    self.postMessage({ type: 'result', result: { width, height, data: buf } }, [buf]);

  } catch (err) {
    fail('Processing failed: ' + (err?.message || String(err)));
  }
};
