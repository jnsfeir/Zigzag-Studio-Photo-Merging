// Web Worker — OpenCV HDR merge with flambient pipeline
// Flambient = highlight-safe WB → clean Mertens blend → shadow lift + warmth curve

const OPENCV_URL = '/opencv.js';

function post(type, extra) { self.postMessage({ type, ...extra }); }
function progress(pct, label) { post('progress', { progress: pct, label }); }
function fail(msg) { post('error', { error: msg }); }

// ── OpenCV loader ─────────────────────────────────────────────────────────────
let cvPromise = null;

async function fetchWithProgress(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} loading opencv.js`);
  const total = parseInt(resp.headers.get('content-length') || '0', 10);
  if (!total || !resp.body) return resp.text();

  const reader = resp.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    const pct = Math.round((received / total) * 100);
    self.postMessage({ type: 'progress', progress: 5 + Math.round(pct * 0.08), label: `Downloading OpenCV… ${pct}%` });
  }
  const all = new Uint8Array(received);
  let off = 0;
  for (const c of chunks) { all.set(c, off); off += c.length; }
  return new TextDecoder().decode(all);
}

function loadCV() {
  if (cvPromise) return cvPromise;
  cvPromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cvPromise = null;
      reject(new Error('OpenCV WASM never initialised — check browser console for errors'));
    }, 90000);

    const done = () => { clearTimeout(timeout); clearInterval(ticker); resolve(self.cv); };
    const fail = (msg) => { clearTimeout(timeout); clearInterval(ticker); cvPromise = null; reject(new Error(msg)); };

    // Fake progress ticker while WASM compiles (no real API for this)
    let fakePct = 14;
    const ticker = setInterval(() => {
      if (fakePct < 14) return;
      fakePct = Math.min(fakePct + 1, 14);
      self.postMessage({ type: 'progress', progress: fakePct, label: 'Compiling WASM…' });
    }, 800);

    // Emscripten ≤3.x callback pattern
    self.Module = {
      onRuntimeInitialized() { done(); },
      onAbort(reason) { fail('WASM aborted: ' + reason); },
    };

    fetchWithProgress(OPENCV_URL)
      .then(code => {
        self.postMessage({ type: 'progress', progress: 13, label: 'Executing OpenCV script…' });
        // Pass undefined for module/define so UMD takes the worker/else branch
        // and assigns root.cv = factory() where root = this = self
        // eslint-disable-next-line no-new-func
        (new Function('module', 'define', code)).call(self, void 0, void 0);

        // Emscripten 3.x+ exposes cv as a thenable — wrap in real Promise
        if (self.cv && typeof self.cv.then === 'function') {
          Promise.resolve(self.cv).then(() => done()).catch(e => fail('cv init error: ' + e));
        } else if (self.cv && self.cv.ready && typeof self.cv.ready.then === 'function') {
          Promise.resolve(self.cv.ready).then(() => done()).catch(e => fail('cv.ready error: ' + e));
        } else if (self.cv && self.cv.Mat) {
          done(); // already synchronously ready
        }
        // otherwise wait for onRuntimeInitialized above
      })
      .catch(e => fail('Fetch failed: ' + e.message));
  });
  return cvPromise;
}

// ── Image decode ──────────────────────────────────────────────────────────────
async function bufToMat(cv, buf) {
  const bitmap = await createImageBitmap(new Blob([buf]));
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
