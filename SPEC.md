# Zigzag Studio Photo Merging — Technical Specification

**Version:** 1.0  
**Date:** 2026-05-08  
**Project:** Web-based HDR / Exposure-Bracketing Photo Merge Tool  
**Stack context:** Vite 5 + vanilla JS (existing scaffold)

---

## Table of Contents

1. [Product Overview and Goals](#1-product-overview-and-goals)
2. [HDR Algorithm Deep-Dive](#2-hdr-algorithm-deep-dive)
3. [Library Landscape](#3-library-landscape)
4. [Input / Output Format Strategy](#4-input--output-format-strategy)
5. [Architecture Recommendation](#5-architecture-recommendation)
6. [Key Features and UI/UX Flow](#6-key-features-and-uiux-flow)
7. [Tech Stack Recommendation](#7-tech-stack-recommendation)
8. [Data Flow Diagram](#8-data-flow-diagram)
9. [Implementation Phases](#9-implementation-phases)
10. [Risks and Mitigations](#10-risks-and-mitigations)
11. [Performance Considerations](#11-performance-considerations)
12. [Open Questions](#12-open-questions)

---

## 1. Product Overview and Goals

### 1.1 What the App Does

Zigzag Studio Photo Merging is a browser-based tool that accepts exactly 3 JPEG (or TIFF) photographs of the same scene taken at different exposure values (EV) — typically −2 EV, 0 EV, and +2 EV — and merges them into a single image that captures detail in both deep shadows and blown highlights. The result can be either a true 32-bit HDR image (for use in professional pipelines) or a tone-mapped 8-bit output ready for immediate use on screen and for print.

### 1.2 Target Users

- Professional photographers running a studio (wedding, portrait, architecture, real estate)
- Photographers who shoot in AEB (Auto Exposure Bracketing) mode and need a fast, no-install merge step in their post-processing workflow
- Photo editors who want a lightweight tool that doesn't require Lightroom, Photomatix, or Photoshop

### 1.3 Goals

| Priority | Goal |
|----------|------|
| P0 | Correctly merge 3 bracketed JPEGs into a single natural-looking output image |
| P0 | Runs entirely in-browser — no file upload to a server, no install |
| P1 | Align images before merging (handle camera movement between shots) |
| P1 | Provide tone-mapping controls (brightness, saturation, contrast) |
| P1 | Export as JPEG (display-ready) and optionally as 16-bit TIFF or EXR |
| P2 | Support RAW input (CR2, NEF, ARW, DNG) |
| P2 | Ghost artifact removal (moving objects between shots) |
| P3 | Batch mode (process multiple bracket sets) |

### 1.4 Non-Goals (MVP)

- Mobile-first layout (desktop first; responsive later)
- Cloud storage / account system
- Printing pipeline
- Video HDR

---

## 2. HDR Algorithm Deep-Dive

### 2.1 Background: Why HDR Merging Is Non-Trivial

A camera sensor has a limited dynamic range — typically 10–14 stops for modern digital cameras. A high-contrast scene (bright window, dark interior) can exceed 20 stops. Exposure bracketing captures multiple shots:

- **Underexposed (−2 EV):** Preserves highlight detail; shadows are crushed
- **Normal (0 EV):** Balanced mid-tones
- **Overexposed (+2 EV):** Recovers shadow detail; highlights are clipped

The merge step must: (a) recover the true scene radiance from each camera response, (b) combine the measurements across exposures, and (c) display the result on an 8-bit screen or print medium (tone mapping).

### 2.2 Algorithm Option A — Debevec-Malik (True HDR Radiance Reconstruction)

**Paper:** "Recovering High Dynamic Range Radiance Maps from Photographs" — Paul Debevec & Jitendra Malik, SIGGRAPH 1997.

**How it works:**

1. **Camera Response Function (CRF) estimation**
   - A real camera's output pixel value `Z` is related to scene radiance `E` and exposure time `Δt` by: `Z = f(E · Δt)` where `f` is the nonlinear CRF (gamma curve + sensor response).
   - Debevec-Malik estimates `g = ln(f⁻¹)` — the log inverse CRF — by solving a constrained least-squares system using pixel samples taken at the same (x,y) position across all exposures.
   - The system is over-determined: for N sample pixels across P exposures, you have N·P equations and N+256 unknowns (N scene radiances + 256 CRF values). A smoothness constraint (second-derivative penalty on g) regularizes the solution.
   - **Key parameter:** λ (smoothing weight, typically 10–100). Higher λ = smoother CRF.

2. **Radiance map construction**
   - Once g is known, construct log radiance at each pixel: `ln(Ei) = g(Zij) − ln(Δtj)` for each exposure j, then take a weighted average across exposures.
   - Weighting function `w(z)`: tent function peaking at mid-gray (z=128), falling to 0 at z=0 and z=255. This discards blown and crushed pixels.
   - Result: a floating-point (32-bit per channel) radiance map in linear light.

3. **Tone mapping** (required before display)
   - The radiance map values span e.g. 0.001 to 100,000 cd/m². A monitor shows 0–1 (normalized).
   - Global operators: Reinhard, Drago, Mantiuk (compress entire image with a single curve).
   - Local operators: Durand, Fattal (adjust contrast locally, more detail at the cost of halos).

**Pros:** Physically accurate; produces a true HDR file (EXR/HDR) usable in 3D rendering.  
**Cons:** Requires known exposure times (EXIF data) or manual EV input; slower; overkill for display-only output.

**Best for:** Architectural photography, professional workflows needing a real HDR asset.

### 2.3 Algorithm Option B — Mertens Exposure Fusion (Recommended for MVP)

**Paper:** "Exposure Fusion" — Tom Mertens, Jan Kautz, Frank Van Reeth, PG 2007.

**How it works:**

1. **Quality measures per pixel, per exposure:**
   - **Contrast C(x,y):** Apply a Laplacian filter; take absolute value. High-contrast pixels are informative.
   - **Saturation S(x,y):** Standard deviation of the R, G, B channels at that pixel. Colorful, non-gray pixels score higher.
   - **Well-exposedness W(x,y):** Gaussian centered at 0.5 (mid-gray), evaluated per channel, then multiplied. Pixels that are neither blown nor crushed score higher. σ ≈ 0.2 is typical.

2. **Combined weight map:**
   - `w_k(x,y) = C_k(x,y)^wC · S_k(x,y)^wS · W_k(x,y)^wW`
   - Default: wC=1, wS=1, wW=1 (equal weight to all three measures).
   - Normalize: each pixel's weights across K exposures sum to 1.

3. **Multi-resolution blending (Laplacian pyramid):**
   - Build a Gaussian pyramid of each weight map.
   - Build a Laplacian pyramid of each input image.
   - At each pyramid level, blend: `R_l = Σ_k W_k^l · I_k^l`
   - Collapse the pyramid to get the output image.
   - This prevents hard seams between blended zones — low frequencies blend softly, high frequencies keep sharp detail.

**Pros:**
- No EXIF data required; works on any 3 images regardless of exposure metadata.
- No tone mapping needed — output is already LDR (8-bit displayable).
- Faster than Debevec; easier to implement.
- Produces very natural-looking results; avoids the "HDR look."

**Cons:**
- Does not produce a true HDR radiance map.
- Ghost artifacts if objects moved between shots (addressed separately).

**Best for:** This app. The Mertens algorithm is the correct choice for the MVP because users are photographers who want a clean, natural-looking final JPEG, not a physically accurate radiance map. OpenCV implements it as `MergeMertens`.

### 2.4 Algorithm Option C — Robertson Algorithm

A Bayesian iterative approach that also estimates the CRF and constructs a radiance map. Less numerically stable and less common in practice than Debevec-Malik. OpenCV implements it as `MergeRobertson`. Skip for this project.

### 2.5 Tone Mapping Operators (needed when using Debevec output)

If the user selects "True HDR" mode (Debevec), the 32-bit radiance map must be tone-mapped before display:

| Operator | Class | Character | OpenCV API |
|----------|-------|-----------|------------|
| Reinhard | Global | Natural, photographer-friendly | `TonemapReinhard` |
| Drago | Global | Preserves detail in very dark regions | `TonemapDrago` |
| Mantiuk | Global | Perceptually uniform | `TonemapMantiuk` |
| Durand | Local | High local contrast, can halo | `TonemapDurand` |

For the MVP, expose only Reinhard with a single `gamma` slider (default 1.0). Offer the others in Phase 2.

### 2.6 Image Alignment

If the photographer used a tripod, alignment error is typically sub-pixel and can be ignored. Handheld bracketing introduces translation, rotation, and slight perspective shift between shots.

**Alignment approaches:**

1. **ECC (Enhanced Correlation Coefficient) — Recommended**
   - OpenCV `findTransformECC`. Iterative minimization of ECC criterion between a reference frame and each other frame.
   - Supports: translation, Euclidean (translation + rotation), affine, homography.
   - For handheld HDR: use `MOTION_HOMOGRAPHY` to handle perspective.
   - Pre-process: convert to grayscale, apply Gaussian blur to reduce noise before alignment.
   - Typically converges in 30–50 iterations for small displacements.
   - **Cost:** ~0.5–3 seconds per pair on a modern CPU in WASM.

2. **ORB Feature Matching (fallback)**
   - Detect ORB keypoints, match with BFMatcher, find homography with RANSAC.
   - More robust to large displacements but slower and less precise.
   - Use this if ECC fails to converge (can happen with very large camera movement).

3. **MTB (Median Threshold Bitmap) alignment**
   - Fast, integer-only method. Only handles integer-pixel translation.
   - OpenCV `AlignMTB`. Good for tripod shots with only vibration.
   - Fastest option (~10ms). Use as a fast-path when the user marks "tripod mode."

**Implementation strategy:**
- Default: attempt AlignMTB first (fast). If residual error > threshold, fall back to ECC.
- The middle exposure (0 EV) is always the reference frame.

### 2.7 Ghost Artifact Removal

Ghosts occur when an object (person, car, leaf) moves between shots — it appears in different positions across the 3 exposures, causing a transparent "ghost" in the merged output.

**Approaches:**

1. **Exclude-and-blend:** For each pixel, if its values across exposures deviate more than a threshold from the reference exposure, exclude the outlier exposures for that pixel and blend only from the remaining ones.
2. **Saturation-weighted exclusion (Mertens variant):** The well-exposedness weight already suppresses outlier pixels; ghost rejection can be achieved by increasing the sharpness of the weight function at its tails.
3. **Full segmentation-based ghost removal:** Compute per-pixel variance map, threshold to find ghost regions, then fill from only the reference exposure.

**MVP:** Implement approach 1 as an optional toggle ("Ghost Removal"). Threshold is a user-adjustable slider.

---

## 3. Library Landscape

### 3.1 OpenCV.js (Recommended)

**What it is:** The official OpenCV library compiled to WebAssembly via Emscripten. Ships as a single ~8 MB `.wasm` + thin JS wrapper.

**HDR-relevant API (all available in OpenCV.js 4.x):**
- `cv.MergeMertens` — Exposure fusion (no EXIF needed)
- `cv.MergeDebevec` + `cv.CalibrateDebevec` — True HDR radiance map
- `cv.MergeRobertson` + `cv.CalibrateRobertson` — Robertson method
- `cv.TonemapReinhard`, `cv.TonemapDrago`, `cv.TonemapMantiuk`, `cv.TonemapDurand`
- `cv.AlignMTB` — Fast alignment
- `cv.findTransformECC` — Precise alignment
- `cv.warpPerspective` / `cv.warpAffine` — Apply alignment transforms

**Current status (as of early 2026):**
- Actively maintained as part of the main OpenCV repository (opencv/opencv).
- OpenCV 4.9.x is the current stable branch; OpenCV.js builds are published with each release.
- The official CDN build is available at `https://docs.opencv.org/4.x/opencv.js`
- Size: ~8.3 MB WASM + ~0.9 MB JS wrapper (gzip compresses to ~3.5 MB).
- Runs in a Web Worker (recommended — keeps UI thread responsive).
- Memory model: uses Emscripten heap. Manually call `.delete()` on all `cv.Mat` objects to prevent leaks.

**Limitations:**
- No RAW file decoding (CR2/NEF/DNG). Must pre-convert or use a separate library.
- Large initial load (~8 MB). Use code-splitting and lazy loading.
- WASM memory is capped by the browser's ArrayBuffer limit (~2 GB in practice); adequate for 24 MP JPEGs.

### 3.2 wasm-vips (libvips via WASM)

**What it is:** libvips — a high-performance image processing library — compiled to WASM. Available as the `wasm-vips` npm package.

**Strengths:** Fast sequential image processing, very low memory footprint (streams image data rather than loading fully into RAM), supports TIFF/JPEG/WebP/PNG/HEIC read/write.

**HDR limitation:** libvips has no built-in HDR merging or exposure fusion. It could be used for: pre-processing (decode TIFF/JPEG to pixel arrays), post-processing (write 16-bit TIFF output), but the merge algorithm itself would still need to be implemented manually or via OpenCV.js.

**Verdict for this project:** Use wasm-vips as a companion for file I/O (especially 16-bit TIFF output and HEIC input) in Phase 2. Not suitable as the primary merge engine.

### 3.3 Jimp (JavaScript, no WASM)

A pure-JavaScript image processing library. Runs in-browser with no WASM. Supports JPEG/PNG I/O and pixel-level manipulation. No HDR algorithms. Could be used for simple blending (average, weighted sum) but produces noticeably inferior results compared to Mertens pyramid blending. Not recommended for this use case.

### 3.4 canvas-hdr / libhdr (niche/abandoned)

Several experimental HDR libraries exist on GitHub (e.g., `hdr-image`, `js-hdr`) but none are actively maintained, documented, or production-ready. Avoid.

### 3.5 Photon (Rust WASM)

Photon is a Rust image processing library compiled to WASM. Supports basic filters, brightness, contrast, etc. No HDR merging. Not relevant.

### 3.6 TensorFlow.js / ONNX Runtime Web

Deep learning-based tone mapping and HDR reconstruction exists in research (e.g., SingleHDR, HDRCNN). These models are 20–100 MB and require GPU via WebGL. Overkill for this project but potentially valuable in Phase 3 as a "Deep HDR" option for single-image HDR from the normal exposure.

### 3.7 Server-Side Options (Python)

If a server-side path is chosen:
- **Python + OpenCV (cv2):** `cv2.MergeMertens`, `cv2.MergeDebevec`, full alignment support. Most battle-tested approach.
- **rawpy + numpy:** Decode RAW files (CR2, NEF, DNG) to numpy arrays. rawpy wraps LibRaw.
- **imageio / Pillow:** TIFF/JPEG I/O.
- **FastAPI / Flask:** REST API to receive uploaded images and return processed output.
- **Node.js + sharp:** sharp (libvips bindings) for file I/O; no HDR built-in.

### 3.8 Library Decision Matrix

| Library | HDR Merge | Alignment | RAW Input | Browser | Bundle Size | Maintenance |
|---------|-----------|-----------|-----------|---------|-------------|-------------|
| OpenCV.js | YES (full) | YES (full) | No | YES (WASM) | ~8 MB | Active |
| wasm-vips | No | No | Partial | YES (WASM) | ~3 MB | Active |
| Jimp | Manual only | No | No | YES (pure JS) | ~0.6 MB | Active |
| Python cv2 | YES (full) | YES (full) | via rawpy | Server only | N/A | Active |
| TF.js HDR | Experimental | No | No | YES (WebGL) | >50 MB | Research |

**Decision: OpenCV.js is the only realistic choice for in-browser HDR merging.** It is the library used.

---

## 4. Input / Output Format Strategy

### 4.1 Input Formats

**MVP (Phase 1):**
- **JPEG (.jpg, .jpeg):** Universal. Every camera produces JPEG. 8 bits per channel. The Mertens algorithm works perfectly with JPEG input.
- **PNG (.png):** 8 or 16-bit. Less common from cameras but useful for pre-edited inputs.

**Phase 2:**
- **TIFF (.tif, .tiff):** 16-bit per channel. Preserves more data than JPEG. Supported by wasm-vips.
- **HEIC/HEIF (.heic):** Common on iPhones. Decode via wasm-vips or a dedicated HEIC WASM decoder.

**Phase 3 (RAW):**
- **CR2/CR3 (Canon), NEF (Nikon), ARW (Sony), DNG (Adobe):** Cannot be decoded in-browser without a dedicated library.
- **Options:**
  1. **Server-side decode:** Upload RAW to a Node.js/Python endpoint that runs LibRaw/rawpy, returns 16-bit TIFF, then process in-browser.
  2. **LibRaw WASM:** LibRaw has an unofficial WASM build (~4 MB) that can decode most RAW formats in-browser. It is experimental but functional. Evaluate at Phase 3.
  3. **Camera SDK proxy:** Some cameras expose a tethering API; out of scope.

**Recommended guidance to users:** "Export as TIFF from your camera software for best quality. JPEG is also supported."

### 4.2 Output Formats

| Format | Depth | Use case | Implementation |
|--------|-------|----------|----------------|
| JPEG | 8-bit | Web sharing, printing via lab | `canvas.toBlob('image/jpeg', quality)` |
| PNG | 8-bit | Lossless web use | `canvas.toBlob('image/png')` |
| 16-bit TIFF | 16-bit | Further editing in Lightroom/PS | wasm-vips (Phase 2) |
| OpenEXR | 32-bit float | Professional VFX/archiving | Custom WASM (Phase 3) |

**MVP output:** JPEG only, with quality slider (60–100, default 90).

### 4.3 EXIF Handling

- EXIF metadata should be read from input files to extract: `ExposureTime`, `FNumber`, `ISO`, `DateTime`.
- The Mertens algorithm does **not** require EXIF exposure times. However, displaying them in the UI confirms the bracketing sequence to the user.
- The Debevec algorithm **requires** exposure times. Read `ExposureTime` EXIF tag.
- Use the `exifr` npm package (~30 KB gzip) for EXIF parsing in-browser.
- On output JPEG, strip or update EXIF to remove potentially confusing per-exposure metadata.

---

## 5. Architecture Recommendation

### 5.1 Option A — Pure Client-Side (Recommended for MVP)

All processing happens in the browser using OpenCV.js in a Web Worker. No server involved.

```
Browser
├── Main Thread    — UI, file I/O, preview rendering
└── Web Worker     — OpenCV.js WASM (alignment, merge, tone mapping)
```

**Pros:**
- Zero server cost, zero upload latency, zero privacy concern (photos never leave device)
- Works offline after first load (PWA-cacheable)
- Simple deployment (static hosting: Vercel, Netlify, GitHub Pages)

**Cons:**
- No RAW support in MVP
- Large initial WASM load (~8 MB, but cacheable)
- Memory-constrained: very large images (50 MP) or multiple 16-bit TIFFs may exhaust the 2 GB WASM heap in some browsers

**Verdict:** Correct for MVP. The target user has 20–24 MP JPEGs from a camera. This is well within browser capability.

### 5.2 Option B — Server-Side Processing

Files are uploaded to a Node.js or Python API. Processing runs on the server. Result is streamed back.

**Pros:**
- Handles RAW files natively (rawpy/LibRaw)
- Unlimited image size
- Can use full OpenCV C++ (no WASM overhead)

**Cons:**
- Server cost, infrastructure, maintenance
- Privacy concern for professional photographers (client photos uploaded to a third-party server)
- Upload time for large RAW files (25–50 MB each × 3 = 75–150 MB per merge)
- Requires auth, rate limiting, storage management

**Verdict:** Defer until Phase 3 (RAW support). If RAW is required earlier, offer an optional server-side path but with a clear privacy disclosure.

### 5.3 Option C — Hybrid (Recommended for Phase 3)

Client-side processes JPEG/TIFF/PNG. Server-side handles RAW → TIFF conversion only. The 16-bit TIFFs (much smaller per-pixel than RAW) are returned to the browser for merging.

```
Browser: JPEG/TIFF/PNG ──────────────────────────────► OpenCV.js (WASM)
                                                            │
Browser: RAW files ──► Server: LibRaw decode ──► 16-bit TIFF ──► OpenCV.js (WASM)
```

This keeps the actual merge in-browser (preserving privacy) while delegating only the RAW decode to the server. The server becomes a stateless format-conversion microservice.

### 5.4 Chosen Architecture

**MVP:** Option A (pure client-side).  
**Phase 3:** Option C (hybrid, RAW decode only on server).

---

## 6. Key Features and UI/UX Flow

### 6.1 UI Principles

- Single-page application. No navigation. Linear flow: Upload → Configure → Process → Export.
- Dark theme (appropriate for a photo studio tool; reflects color accurately on dark background).
- Large drag-and-drop zones (photographers drag files from Finder/Explorer constantly).
- Non-destructive: the user can re-adjust tone mapping settings and re-export without re-running the merge.

### 6.2 Step-by-Step UI Flow

#### Step 1 — Upload Zone

```
┌─────────────────────────────────────────────────────────┐
│  ZIGZAG STUDIO — Photo Merging                          │
├─────────┬───────────────┬───────────────┬───────────────┤
│         │  UNDEREXPOSED │    NORMAL     │  OVEREXPOSED  │
│         │    (−2 EV)    │    (0 EV)     │    (+2 EV)    │
│         ├───────────────┼───────────────┼───────────────┤
│         │  Drop or      │  Drop or      │  Drop or      │
│         │  click to     │  click to     │  click to     │
│         │  upload       │  upload       │  upload       │
├─────────┴───────────────┴───────────────┴───────────────┤
│  AUTO-DETECT ORDER  [Toggle]    EXIF info shown inline  │
└─────────────────────────────────────────────────────────┘
```

- Three upload slots: under, normal, over.
- Each slot displays a thumbnail immediately after selection.
- EXIF is read and the exposure value / shutter speed is displayed under each thumbnail.
- "Auto-detect order" toggle: reads EXIF `ExposureTime` from all 3 files and auto-sorts them into under/normal/over order. The user can still drag-swap them.
- If all 3 slots are filled, a "MERGE" button becomes active.

#### Step 2 — Options Panel (collapsible, below upload zone)

```
  Algorithm:  [Exposure Fusion ▼]  (Exposure Fusion | Debevec HDR)

  Alignment:  [Auto ▼]  (Off | Fast MTB | Precise ECC)

  Ghost Removal:  [Off]  (toggle + threshold slider when On)

  Fusion Weights:
    Contrast   [━━━━●────]  1.0
    Saturation [━━━━●────]  1.0
    Exposedness[━━━━●────]  1.0

  Tone Mapping (only shown when Debevec is selected):
    Operator   [Reinhard ▼]
    Gamma      [━━━━●────]  1.0
```

- Keep defaults for 95% of users. Advanced options collapsible under "Advanced."
- Tooltips on hover for each control explain what it does in plain language.

#### Step 3 — Processing

```
  ┌──────────────────────────────────────┐
  │  Merging…                            │
  │  ████████████░░░░░░░░░░░  60%        │
  │  Aligning images…                    │
  └──────────────────────────────────────┘
```

- Progress reported back from the Web Worker via `postMessage`.
- Steps reported: "Loading images", "Aligning", "Computing weights", "Blending pyramid levels", "Finalizing."
- Cancel button (terminates the worker).

#### Step 4 — Result View

```
  ┌─────────────────────────────────────────────────────────────┐
  │                                                             │
  │              [RESULT IMAGE — full width preview]            │
  │                                                             │
  ├────────────────────────────────────────┬────────────────────┤
  │  Before/After:  [────────│────────]    │  EXPORT            │
  │  (drag the divider to compare)         │  Format: [JPEG ▼]  │
  │                                        │  Quality: [90]     │
  │  Tone adjust (non-destructive):        │  [DOWNLOAD]        │
  │    Brightness  [━━━●─────]  0          │                    │
  │    Contrast    [━━━●─────]  0          │  [MERGE AGAIN]     │
  │    Saturation  [━━━●─────]  0          │  (back to step 2)  │
  │    Dehaze      [━━━●─────]  0          │                    │
  └────────────────────────────────────────┴────────────────────┘
```

- Before/After split-view: drag divider to compare merged result with the normal-exposure input.
- Tone adjustments are applied on the fly using canvas 2D operations (fast, no re-merge needed).
- Download triggers `canvas.toBlob()` → `URL.createObjectURL()` → anchor click.

### 6.3 Error States

| Scenario | UI Response |
|----------|-------------|
| Non-image file uploaded | Red border on slot, "Please upload a JPEG or PNG" |
| Images are different sizes | Warning: "Images have different dimensions. Resize to match?" |
| Alignment fails (large movement) | Warning: "Alignment failed. Try 'Precise ECC' or disable alignment." |
| WASM OOM | Error modal: "Image too large. Try reducing resolution or use JPEG input." |
| All 3 images are identical EV | Warning: "All images appear to have the same exposure. HDR merging requires bracketed exposures." |

---

## 7. Tech Stack Recommendation

### 7.1 Core Stack

| Layer | Technology | Reason |
|-------|-----------|--------|
| Bundler | **Vite 5** (already in project) | Fast HMR, native ESM, easy WASM integration |
| UI Framework | **Vanilla JS + Web Components** | No framework overhead; existing project is vanilla |
| HDR Engine | **OpenCV.js 4.x** | Only viable in-browser HDR library |
| Worker Communication | **Web Worker + Comlink** | Comlink wraps Worker postMessage in a clean async/await API |
| EXIF Parsing | **exifr** | Small, fast, browser-native EXIF reader |
| 16-bit TIFF output (Phase 2) | **wasm-vips** | Best TIFF write support in WASM |
| State Management | **Vanilla signals / reactive store** | No Redux; simple derived state is sufficient |
| Styling | **CSS custom properties + CSS Grid** | Dark theme, responsive layout |
| Hosting | **Vercel / Netlify static** | Zero cost, global CDN, instant deploy |

### 7.2 Key npm Dependencies

```json
{
  "dependencies": {
    "exifr": "^7.1.3",
    "comlink": "^4.4.1"
  },
  "devDependencies": {
    "vite": "^5.0.0",
    "vite-plugin-wasm": "^3.3.0",
    "vite-plugin-top-level-await": "^1.4.4"
  }
}
```

OpenCV.js is loaded from its CDN URL inside the worker (not as an npm package) because the npm-packaged version is outdated and the CDN version is always current.

### 7.3 Vite Configuration Notes

WASM files need special Vite config:

```js
// vite.config.js
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';

export default {
  plugins: [wasm(), topLevelAwait()],
  worker: {
    format: 'es',
    plugins: () => [wasm(), topLevelAwait()],
  },
  optimizeDeps: {
    exclude: ['opencv.js'],
  },
};
```

The OpenCV.js `.wasm` file must be served with the `Content-Type: application/wasm` header; Vite dev server handles this automatically.

### 7.4 Cross-Origin Isolation (COOP/COEP)

SharedArrayBuffer (used by some WASM modules) requires the page to be cross-origin isolated:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

OpenCV.js does not require SharedArrayBuffer, so this is not mandatory for MVP. However, it enables `performance.now()` high-resolution timing and future use of SharedArrayBuffer for parallel processing. Add these headers in the Vercel/Netlify config.

---

## 8. Data Flow Diagram

```
USER ACTION                   MAIN THREAD                    WEB WORKER (OpenCV.js)
──────────────────────────────────────────────────────────────────────────────────

[Drop 3 files]
       │
       ▼
  FileReader.readAsArrayBuffer()
  exifr.parse() → EV, ExposureTime
  drawImageToCanvas() → thumbnail
       │
       ▼
  User clicks [MERGE]
       │
       ▼
  Transfer ArrayBuffers to Worker ──────────────────────────►
  (zero-copy via Transferable)                               │
                                                     cv.imdecode() × 3
                                                     → cv.Mat (8UC3)
                                                             │
                                                     ┌──[Alignment]──────────┐
                                                     │ AlignMTB.process()    │
                                                     │ → warpPerspective()   │
                                                     └───────────────────────┘
                                                             │
                                                     ┌──[Mertens Fusion]─────┐
                                                     │ MergeMertens.process()│
                                                     │ → result Mat (32FC3)  │
                                                     └───────────────────────┘
                                                             │
                                                     convertScaleAbs()
                                                     → 8UC3 Mat
                                                             │
                                                     imencode('.jpg') / '.png'
                                                     → Uint8Array
                                                             │
  ◄────────────────────────────────────────────────── postMessage(result)
       │                                              (Transfer Uint8Array)
       ▼
  Blob(result, {type:'image/jpeg'})
  URL.createObjectURL()
  Draw to <canvas> preview
       │
       ▼
  User adjusts brightness/contrast
       │
       ▼
  ctx.filter = 'brightness(x) contrast(y) saturate(z)'
  ctx.drawImage(originalResultBlob)
  (runs entirely on main thread — no re-merge)
       │
       ▼
  User clicks [DOWNLOAD]
       │
       ▼
  canvas.toBlob('image/jpeg', quality)
  → <a download> click
```

---

## 9. Implementation Phases

### Phase 1 — MVP (4–6 weeks)

**Goal:** Working JPEG-in, JPEG-out exposure fusion in the browser.

| # | Task | Notes |
|---|------|-------|
| 1.1 | Set up Vite project (exists), add wasm/top-level-await plugins | 1 day |
| 1.2 | Build 3-slot upload UI with drag-and-drop, thumbnail preview | 2 days |
| 1.3 | Implement EXIF reading with exifr (exposure time, EV display) | 0.5 day |
| 1.4 | Create Web Worker with Comlink bridge | 1 day |
| 1.5 | Load OpenCV.js in worker; test WASM startup | 1 day |
| 1.6 | Implement Mertens exposure fusion (MergeMertens) | 2 days |
| 1.7 | Implement AlignMTB alignment (fast path) | 1 day |
| 1.8 | Worker progress reporting (postMessage steps) | 0.5 day |
| 1.9 | Result preview canvas + before/after split view | 2 days |
| 1.10 | JPEG export with quality slider | 0.5 day |
| 1.11 | Non-destructive brightness/contrast/saturation (CSS filter) | 1 day |
| 1.12 | Error handling (wrong format, OOM, alignment failure) | 1 day |
| 1.13 | Dark theme styling, responsive layout | 2 days |
| 1.14 | Deploy to Vercel/Netlify | 0.5 day |

**MVP deliverable:** A user can drop 3 JPEGs, click Merge, see the result, and download it. No server, no account.

### Phase 2 — Enhanced Quality (4 weeks after MVP)

| # | Task |
|---|------|
| 2.1 | Add ECC alignment (precise, handles handheld) |
| 2.2 | Add Debevec HDR algorithm + Reinhard tone mapping |
| 2.3 | Ghost artifact removal toggle |
| 2.4 | 16-bit TIFF output via wasm-vips |
| 2.5 | PNG output |
| 2.6 | HEIC/HEIF input support |
| 2.7 | Batch mode (process multiple bracket sets as a zip upload) |
| 2.8 | Save/restore session (IndexedDB) — resume after page reload |
| 2.9 | PWA manifest + service worker for offline use |
| 2.10 | Expose Drago/Mantiuk/Durand tone mapping operators |

### Phase 3 — Professional Features (8 weeks after Phase 2)

| # | Task |
|---|------|
| 3.1 | RAW input: LibRaw WASM build evaluation + integration |
| 3.2 | Server-side RAW fallback (Python microservice with rawpy) |
| 3.3 | 5/7-bracket merge (not just 3 images) |
| 3.4 | OpenEXR output |
| 3.5 | Deep HDR (single-image, ML-based, TF.js model) |
| 3.6 | Tethered shooting (USB camera via WebUSB API — experimental) |
| 3.7 | Metadata embedding in output (EXIF, IPTC, XMP copyright) |
| 3.8 | Lightroom catalog export (XMP sidecar files) |

---

## 10. Risks and Mitigations

### 10.1 OpenCV.js Memory Leaks

**Risk:** Every `cv.Mat` object allocated in the WASM heap must be manually freed with `.delete()`. Forgetting this causes gradual heap exhaustion, eventually crashing the tab.

**Mitigation:**
- Use a try/finally pattern around every OpenCV operation block.
- Wrap OpenCV calls in a helper that auto-registers Mats for cleanup.
- Run the worker in a dedicated thread; if it OOMs, terminate and restart the worker rather than crashing the whole tab.
- Implement a leak detector in development mode that logs outstanding Mat instances.

### 10.2 Large File Handling

**Risk:** Three 24 MP JPEGs at 8 bits = 3 × (6000 × 4000 × 3) bytes = 216 MB of raw pixel data in WASM heap. With intermediate buffers (Gaussian pyramids have ~33% overhead), peak usage approaches ~400 MB. Some mobile browsers cap WASM memory at 512 MB.

**Mitigation:**
- Warn user when input resolution > 20 MP.
- Offer a "Resize inputs" option: downsample to 12 MP before merge (still yields excellent output for web/print up to A3).
- Process one pyramid level at a time where possible to reduce peak memory.
- Terminate worker cleanly on OOM and present a recoverable error rather than a crash.

### 10.3 OpenCV.js CDN Availability

**Risk:** Serving OpenCV.js from `docs.opencv.org` CDN introduces a third-party availability dependency.

**Mitigation:**
- In production, self-host the `opencv.js` and `opencv.wasm` files from the same origin (copy to `/public/` and reference locally).
- Vite's build process can include it as a static asset. At ~8 MB, the wasm file is served efficiently with long-cache headers.

### 10.4 Browser Compatibility

**Risk:** WASM is supported in all modern browsers, but:
- Safari had issues with large WASM modules until Safari 15.
- Firefox enforces stricter WASM memory limits in certain configurations.
- Older Android WebView may not support all WASM features used by OpenCV.

**Mitigation:**
- Test on: Chrome 120+, Firefox 120+, Safari 17+, Edge 120+.
- Show a browser compatibility check on load; gracefully degrade to a "not supported" message for older browsers.
- Do not target mobile as MVP (memory constraints); desktop-first.

### 10.5 Image Alignment Failure

**Risk:** If the 3 images have large misalignment (photographer moved significantly between shots), AlignMTB may fail silently (returning a near-identity transform), and ECC may fail to converge.

**Mitigation:**
- After alignment, compute a per-pixel residual metric between the reference and each aligned image.
- If residual > threshold, warn the user and offer to proceed without alignment.
- Provide a manual alignment option in Phase 2 (drag-to-align UI).

### 10.6 Ghost Artifacts

**Risk:** Moving subjects (leaves, people, cars) create transparent ghost images in the merged output, which looks obviously wrong.

**Mitigation:**
- Ship a ghost removal toggle in Phase 2.
- Document in the UI that for scenes with movement, the user should choose the middle exposure as the "reference" for ghost suppression.

### 10.7 JPEG Input Quality Loss

**Risk:** JPEG is a lossy format. Compression artifacts (blocking, ringing) in JPEG input will be amplified by the multi-scale pyramid blending because the Laplacian pyramid treats blocking artifacts as high-frequency detail.

**Mitigation:**
- Recommend TIFF or high-quality JPEG (quality ≥ 90) in the UI.
- Apply a mild smoothing step before pyramid construction (optional, configurable).
- In Phase 2, support TIFF input directly.

---

## 11. Performance Considerations

### 11.1 OpenCV.js Load Time

- The `opencv.wasm` file (~8 MB) takes 2–5 seconds to download and ~1–2 seconds to compile on first load.
- Cache aggressively (`Cache-Control: max-age=31536000, immutable`).
- Show a spinner or progress bar on first visit: "Loading image processing engine…"
- Consider loading the worker on app startup (not when the user clicks Merge) so it's ready before needed.

### 11.2 Processing Speed (Estimates)

For 3 × 24 MP JPEGs on a modern desktop CPU (Apple M2 / Intel i7):

| Step | Estimated Time |
|------|---------------|
| Decode JPEG × 3 | ~0.5 s |
| AlignMTB alignment | ~0.1 s |
| ECC alignment (if used) | ~2–5 s per pair |
| Mertens weight computation | ~0.3 s |
| Laplacian pyramid build + blend | ~1.5 s |
| Pyramid collapse | ~0.3 s |
| JPEG encode (output) | ~0.2 s |
| **Total (MTB alignment)** | **~3 seconds** |
| **Total (ECC alignment)** | **~8–12 seconds** |

These are estimates for in-browser WASM. Native OpenCV would be ~2–4× faster.

### 11.3 Web Worker Architecture

```
Main Thread                    Web Worker
    │                               │
    │── new Worker('./merge.js') ──►│
    │                               │ (OpenCV.js loads, WASM compiles)
    │── Comlink.wrap(worker) ──────►│
    │                               │
    │── worker.merge(buffers) ─────►│ (process)
    │◄── progress events ───────────│ (30% … 60% … 90%)
    │◄── result ArrayBuffer ────────│
```

- Worker is initialized once at app startup.
- The same worker is reused for subsequent merges.
- If the worker crashes (OOM), the main thread detects `worker.onerror` and creates a fresh worker instance.
- Use `Transferable` objects (`ArrayBuffer`) when passing image data to avoid copying.

### 11.4 Canvas Rendering

- Display the result in an `<img>` tag (object URL) rather than a `<canvas>` for the main preview (lower memory, GPU-accelerated decode).
- Use a hidden `<canvas>` only when applying the non-destructive adjustments and when exporting.
- For the before/after split view, use two `<canvas>` elements clipped by CSS `clip-path` driven by a range input.

### 11.5 Memory Budget

```
Input buffers (compressed JPEG):   3 × ~8 MB   = ~24 MB
Decoded pixel data (WASM heap):    3 × ~70 MB  = ~210 MB
Weight maps:                       3 × ~24 MB  = ~72 MB
Pyramid buffers (peak):                        = ~100 MB
Output buffer:                                 = ~70 MB
─────────────────────────────────────────────────────────
Peak WASM heap estimate:                       ~476 MB
```

This is within the 2 GB WASM limit on desktop Chrome/Firefox. On 32-bit browsers or constrained environments, warn and offer downsampling.

---

## 12. Open Questions

1. **Exposure ordering:** Should the app require the user to explicitly label which image is under/normal/over, or should it auto-detect via EXIF? Auto-detect is better UX but requires reliable EXIF. Decision: default to auto-detect; allow manual override.

2. **EV spacing:** The standard bracket is ±2 EV. Some photographers use ±1 EV or ±3 EV. The Mertens algorithm doesn't care about EV spacing, but the Debevec algorithm's quality improves with wider spacing. Consider reading EV from EXIF and warning if spacing is very narrow (< 1 EV).

3. **Color space:** Input JPEGs are typically in sRGB. The Mertens fusion should be performed in linear light (after gamma decoding) for physically correct blending. OpenCV.js does not automatically handle this. The implementation must apply a gamma linearization step before the merge and re-apply gamma before encoding the output. This is a non-trivial correctness issue that is often ignored in simple implementations. Decide: implement correctly (adds complexity) or document as a known limitation.

4. **Output color profile:** Should the output JPEG embed an sRGB ICC profile? This matters for professional photographers whose workflow is color-managed. Answer: yes, embed sRGB profile in Phase 2.

5. **Pricing / monetization:** Will this be free, freemium (e.g., RAW support as a paid tier), or a one-time purchase? This affects the Phase 3 server-side investment.

6. **Brand alignment:** The existing project is named "jean-sfeir-rain" in `package.json`. The package name, `index.html` title, and source structure should be updated to reflect "Zigzag Studio Photo Merging" before any public release.

---

## Appendix A — Core Mertens Implementation Sketch (OpenCV.js)

This is a reference skeleton, not final code:

```javascript
// merge-worker.js — runs in a Web Worker
importScripts('https://docs.opencv.org/4.x/opencv.js');

// Wait for OpenCV to be ready
cv.onRuntimeInitialized = () => { /* signal ready */ };

async function mergeMertens(imageBuffers, options = {}) {
  const mats = [];
  const matVec = new cv.MatVector();

  try {
    // 1. Decode each JPEG buffer to cv.Mat
    for (const buffer of imageBuffers) {
      const arr = new Uint8Array(buffer);
      const encoded = cv.matFromArray(arr.length, 1, cv.CV_8UC1, arr);
      const mat = cv.imdecode(encoded, cv.IMREAD_COLOR);
      encoded.delete();
      mats.push(mat);
      matVec.push_back(mat);
    }

    // 2. Align (MTB fast path)
    if (options.align !== 'off') {
      const aligner = new cv.AlignMTB();
      aligner.process(matVec, matVec);
      aligner.delete();
    }

    // 3. Mertens exposure fusion
    const merger = cv.MergeMertens_create(
      options.contrastWeight   ?? 1.0,
      options.saturationWeight ?? 1.0,
      options.exposedWeight    ?? 1.0,
    );
    const fusedF = new cv.Mat();
    merger.process(matVec, fusedF);
    merger.delete();

    // 4. Convert 32F → 8U
    const fused8U = new cv.Mat();
    fusedF.convertTo(fused8U, cv.CV_8UC3, 255.0);
    fusedF.delete();

    // 5. Encode to JPEG
    const params = new cv.MatVector();
    const output = new cv.Mat();
    cv.imencode('.jpg', fused8U, output, params);
    params.delete();
    fused8U.delete();

    const result = output.data.slice(); // copy out of WASM heap
    output.delete();

    return result.buffer;

  } finally {
    mats.forEach(m => m.delete());
    matVec.delete();
  }
}
```

---

## Appendix B — File Structure (Target)

```
Photo-Merging/
├── index.html                   # Entry point
├── package.json                 # Updated: name = "zigzag-photo-merging"
├── vite.config.js               # WASM plugins, COOP/COEP headers
├── public/
│   ├── opencv.js                # Self-hosted OpenCV.js wrapper
│   ├── opencv.wasm              # Self-hosted WASM binary
│   └── favicon.svg
├── src/
│   ├── main.js                  # App entry — mounts UI, initializes worker
│   ├── style.css                # Dark theme, layout
│   ├── components/
│   │   ├── UploadZone.js        # 3-slot upload component
│   │   ├── OptionsPanel.js      # Algorithm/alignment controls
│   │   ├── ProgressModal.js     # Merge progress overlay
│   │   ├── ResultViewer.js      # Preview + before/after split
│   │   └── ExportPanel.js       # Format, quality, download
│   ├── workers/
│   │   └── merge.worker.js      # OpenCV.js merge logic
│   ├── lib/
│   │   ├── exif.js              # EXIF reading (wraps exifr)
│   │   ├── imageUtils.js        # Canvas encode/decode helpers
│   │   └── workerBridge.js      # Comlink wrapper for merge worker
│   └── store/
│       └── appState.js          # Reactive state (vanilla signals)
└── SPEC.md                      # This document
```

---

*Spec written for Zigzag Studio Photo Merging v1.0. Ready for implementation.*
