// Web Worker — OpenCV HDR merge with flambient pipeline
// Flambient = highlight-safe WB → clean Mertens blend → shadow lift + warmth curve

const OPENCV_URL = '/opencv.js';

function post(type, extra) { self.postMessage({ type, ...extra }); }
function progress(pct, label) { post('progress', { progress: pct, label }); }
function fail(msg) { post('error', { error: msg }); }

// ── OpenCV loader ─────────────────────────────────────────────────────────────
let cvPromise = null;

function loadCV() {
  if (cvPromise) return cvPromise;
  cvPromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cvPromise = null;
      reject(new Error('OpenCV WASM timed out — try refreshing'));
    }, 90000);

    let tickPct = 10;
    const ticker = setInterval(() => {
      if (tickPct < 14) {
        tickPct++;
        self.postMessage({ type: 'progress', progress: tickPct, label: 'Compiling WASM…' });
      }
    }, 700);

    const done = () => { clearTimeout(timeout); clearInterval(ticker); resolve(self.cv); };
    const fail = (msg) => { clearTimeout(timeout); clearInterval(ticker); cvPromise = null; reject(new Error(msg)); };

    self.postMessage({ type: 'progress', progress: 5, label: 'Loading OpenCV…' });

    try {
      importScripts(OPENCV_URL);
    } catch (e) {
      fail('importScripts failed: ' + e.message);
      return;
    }

    self.postMessage({ type: 'progress', progress: 10, label: 'Waiting for WASM…' });

    // self.cv is a thenable in this build — wrap in real Promise to await WASM init
    if (self.cv && typeof self.cv.then === 'function') {
      Promise.resolve(self.cv).then(() => done()).catch(e => fail('cv init: ' + e));
    } else if (self.cv && self.cv.ready) {
      Promise.resolve(self.cv.ready).then(() => done()).catch(e => fail('cv.ready: ' + e));
    } else if (self.cv && self.cv.Mat) {
      done();
    } else {
      fail('OpenCV not set after loading — check browser console');
    }
  });
  return cvPromise;
}

// ── RAW file detection & embedded JPEG extraction ────────────────────────────
function isRawBuffer(buf) {
  if (buf.byteLength < 8) return false;
  const b = new Uint8Array(buf);
  // ISOBMFF (CR3): "ftyp" at offset 4
  if (b[4]===0x66 && b[5]===0x74 && b[6]===0x79 && b[7]===0x70) return true;
  // TIFF-based RAW (CR2, NEF, ARW, DNG): II* or MM*
  if (b[0]===0x49 && b[1]===0x49 && b[2]===0x2A && b[3]===0x00) return true;
  if (b[0]===0x4D && b[1]===0x4D && b[2]===0x00 && b[3]===0x2A) return true;
  return false;
}

// Scans the buffer for the largest embedded JPEG (Canon full-res preview).
// Returns an ArrayBuffer slice or null.
function extractLargestJpeg(buf) {
  const bytes = new Uint8Array(buf);
  const limit = Math.min(bytes.length, 40 * 1024 * 1024); // scan first 40 MB
  let bestStart = -1, bestLen = 0;
  let i = 0;
  while (i < limit - 3) {
    if (bytes[i] === 0xFF && bytes[i+1] === 0xD8 && bytes[i+2] === 0xFF) {
      let j = i + 2;
      while (j < limit - 1) {
        if (bytes[j] === 0xFF && bytes[j+1] === 0xD9) { j += 2; break; }
        j++;
      }
      const len = j - i;
      if (len > bestLen && len > 100 * 1024) { // ignore thumbnails <100 KB
        bestLen = len;
        bestStart = i;
      }
      i = j;
    } else {
      i++;
    }
  }
  return bestStart >= 0 ? buf.slice(bestStart, bestStart + bestLen) : null;
}

// ── Image decode ──────────────────────────────────────────────────────────────
async function bufToMat(cv, buf) {
  let blob;
  if (isRawBuffer(buf)) {
    const jpegBuf = extractLargestJpeg(buf);
    if (!jpegBuf) throw new Error('Could not find embedded JPEG in RAW file.');
    blob = new Blob([jpegBuf], { type: 'image/jpeg' });
  } else {
    blob = new Blob([buf]);
  }
  const bitmap = await createImageBitmap(blob);
  const w = bitmap.width, h = bitmap.height;
  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  bitmap.close();
  const rgba = cv.matFromImageData(canvas.getContext('2d').getImageData(0, 0, w, h));
  const bgr  = new cv.Mat();
  cv.cvtColor(rgba, bgr, cv.COLOR_RGBA2BGR);
  rgba.delete();
  return bgr;
}

// ── White balance (highlight-based) ──────────────────────────────────────────
// Samples the top ~15% brightest pixels (should be near-neutral: walls, ceilings).
// Scales R and B channels so their means match the green channel mean in those pixels.
// Green is the most perceptually stable reference channel.
function whiteBalance(cv, mat) {
  const matF = new cv.Mat();
  mat.convertTo(matF, cv.CV_32FC3, 1 / 255.0);

  // Build a grayscale brightness map
  const gray = new cv.Mat();
  cv.cvtColor(matF, gray, cv.COLOR_BGR2GRAY);

  // Threshold: keep pixels brighter than 0.72 (≈ top 15%)
  const mask = new cv.Mat();
  cv.threshold(gray, mask, 0.72, 1.0, cv.THRESH_BINARY);
  mask.convertTo(mask, cv.CV_8U, 255);
  gray.delete();

  // Split channels
  const ch = new cv.MatVector();
  cv.split(matF, ch);

  const bMean = cv.mean(ch.get(0), mask)[0];
  const gMean = cv.mean(ch.get(1), mask)[0];
  const rMean = cv.mean(ch.get(2), mask)[0];
  mask.delete();

  // Scale toward green reference; guard against divide-by-zero
  if (bMean > 0.001 && rMean > 0.001) {
    // Slight warmth bias: target slightly warmer than pure neutral
    // (interior flambient looks best at ~5600K — a touch warm)
    const warmthBias = 0.97; // compress blue slightly
    ch.get(0).convertTo(ch.get(0), -1, (gMean / bMean) * warmthBias);
    ch.get(2).convertTo(ch.get(2), -1, gMean / rMean * 1.01); // tiny red lift
  }

  const balanced = new cv.Mat();
  cv.merge(ch, balanced);
  for (let i = 0; i < ch.size(); i++) ch.get(i).delete();
  ch.delete();
  matF.delete();

  // Back to 8-bit, clamp
  const result = new cv.Mat();
  balanced.convertTo(result, cv.CV_8UC3, 255.0);
  balanced.delete();
  cv.threshold(result, result, 255, 255, cv.THRESH_TRUNC);

  mat.delete();
  return result;
}

// ── Mertens exposure fusion (flambient-tuned) ─────────────────────────────────
// contrast=0 → no HDR grunge/halos
// saturation=0.6 → natural colour, not oversaturated
// exposedness=1.0 → pull full detail from all exposures
function mergeMertens(cv, mats) {
  const vec = new cv.MatVector();
  mats.forEach(m => vec.push_back(m));

  const merger = new cv.MergeMertens();
  merger.setContrastWeight(0.0);
  merger.setSaturationWeight(0.6);
  merger.setExposureWeight(1.0);
  const fused32 = new cv.Mat();
  merger.process(vec, fused32);
  merger.delete();
  vec.delete();

  const fused8 = new cv.Mat();
  fused32.convertTo(fused8, cv.CV_8UC3, 255.0);
  fused32.delete();
  return fused8;
}

// ── Shadow lift via LUT ───────────────────────────────────────────────────────
// Applies a gentle S-curve: lifts shadows, slightly protects highlights.
// gamma < 1 = brighter midtones; toe = floor for pure blacks.
function shadowLift(cv, mat) {
  const lut = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    // Gentle gamma 0.88 in shadows (0–128), linear above 200, smooth transition
    const t = i / 255;
    let out;
    if (t < 0.5) {
      out = Math.pow(t / 0.5, 0.88) * 0.5;
    } else {
      // Slight shoulder compression to protect highlights
      out = 0.5 + (t - 0.5) * 0.97;
    }
    lut[i] = Math.min(255, Math.max(0, Math.round(out * 255)));
  }
  const lutMat = cv.matFromArray(1, 256, cv.CV_8UC1, lut);
  const result = new cv.Mat();
  cv.LUT(mat, lutMat, result);
  lutMat.delete();
  mat.delete();
  return result;
}

// ── Clarity (local contrast micro-boost) ─────────────────────────────────────
// Unsharp-mask style: blend original with blurred version with negative weight.
// Adds crispness without sharpening noise.
function addClarity(cv, mat) {
  const blurred = new cv.Mat();
  const ksize   = new cv.Size(0, 0);
  cv.GaussianBlur(mat, blurred, ksize, 15); // large sigma = low-freq layer

  const result = new cv.Mat();
  // result = mat * 1.12 + blurred * -0.12 (high-pass blend)
  cv.addWeighted(mat, 1.12, blurred, -0.12, 0, result);
  blurred.delete();
  mat.delete();

  // Clamp
  cv.threshold(result, result, 255, 255, cv.THRESH_TRUNC);
  return result;
}

// ── Mat → transferable ImageData ──────────────────────────────────────────────
function matToTransferable(cv, mat) {
  const rgba = new cv.Mat();
  cv.cvtColor(mat, rgba, cv.COLOR_BGR2RGBA);
  const buf = rgba.data.buffer.slice(0);
  const out = { width: mat.cols, height: mat.rows, data: buf };
  rgba.delete();
  return out;
}

// ── Main merge handler ────────────────────────────────────────────────────────
self.onmessage = async (e) => {
  if (e.data.type !== 'merge') return;
  const { under, normal, over } = e.data;

  try {
    const cv = await loadCV();

    progress(15, 'Decoding images…');
    const [mUnder, mNormal, mOver] = await Promise.all([
      bufToMat(cv, under),
      bufToMat(cv, normal),
      bufToMat(cv, over),
    ]);

    // Dimension check
    if (mUnder.rows !== mNormal.rows || mUnder.cols !== mNormal.cols) {
      mUnder.delete(); mNormal.delete(); mOver.delete();
      fail('All three images must have the same dimensions.');
      return;
    }

    progress(25, 'White balancing…');
    const wbUnder  = whiteBalance(cv, mUnder);
    const wbNormal = whiteBalance(cv, mNormal);
    const wbOver   = whiteBalance(cv, mOver);

    progress(35, 'Aligning exposures…');
    const inputVec  = new cv.MatVector();
    inputVec.push_back(wbUnder);
    inputVec.push_back(wbNormal);
    inputVec.push_back(wbOver);

    const aligned   = new cv.MatVector();
    const aligner   = new cv.AlignMTB();
    aligner.process(inputVec, aligned);
    aligner.delete();
    inputVec.delete();
    wbUnder.delete(); wbNormal.delete(); wbOver.delete();

    progress(55, 'Fusing exposures (flambient)…');
    const mats = [];
    for (let i = 0; i < aligned.size(); i++) mats.push(aligned.get(i));
    let result = mergeMertens(cv, mats);
    for (let i = 0; i < aligned.size(); i++) aligned.get(i).delete();
    aligned.delete();

    progress(72, 'Lifting shadows…');
    result = shadowLift(cv, result);

    progress(82, 'Adding clarity…');
    result = addClarity(cv, result);

    progress(92, 'Finalizing…');
    const out = matToTransferable(cv, result);
    result.delete();

    progress(100, 'Done');
    self.postMessage({ type: 'result', result: out }, [out.data]);

  } catch (err) {
    fail('Processing failed: ' + (err?.message || String(err)));
  }
};
