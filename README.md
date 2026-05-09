# Zigzag Studio — Photo Merge

A browser-based HDR photo merging tool built for studio photographers. Drop your bracketed exposures in, get a flambient-processed result out. No uploads, no installs, no subscriptions — everything runs locally in the browser.

---

## What it does

Takes 3 bracketed JPEG or PNG photos of the same scene (underexposed, normal, overexposed) and merges them into a single balanced image using an exposure fusion pipeline tuned for the flambient look — the clean, evenly-lit style used in real estate and interior photography.

### The flambient pipeline

1. **White balance** — samples the brightest ~15% of each frame (walls, ceilings) and normalises R/B channels against green, with a subtle 5600K warmth bias baked in
2. **Alignment** — AlignMTB aligns the three frames to correct for camera movement between shots
3. **Exposure fusion** — Mertens blend with `contrast=0` (no HDR grunge or halos), `saturation=0.6`, `exposedness=1.0`
4. **Shadow lift** — gentle LUT curve that opens up dark corners without blowing midtones
5. **Clarity** — high-pass blend that adds local structure without sharpening noise

---

## Getting started

```bash
# Install dependencies
npm install

# Start the dev server
npm run dev
```

Open **http://localhost:5173** in your browser.

> The dev server must be started from a terminal window — do not run `npm run dev` inside Claude Code as it will block the session. Open a separate terminal.

---

## How to use

### Batch mode (default)

1. Drop your bracket photos onto the import zone — or click **Choose Files** and select them from a folder (`Ctrl+A` selects all files in the current folder)
2. The app reads EXIF timestamps and exposure values to automatically group images into bracket sets of 3
3. Each detected set appears as a card showing the three exposures with their shutter speeds
4. Click **Merge This Set** on any card, or **Merge All Sets** to process everything in sequence
5. On the result screen, drag the divider to compare the merged result against the original normal exposure
6. Fine-tune brightness, contrast, and saturation if needed, then download as JPEG or PNG

### Manual mode

Switch to **Manual** in the top-right toggle when you have 3 specific photos already identified. Drop or click each slot individually — Underexposed (−2 EV), Normal (0 EV), Overexposed (+2 EV) — then click **Merge**.

---

## Tech stack

| Layer | Technology |
|-------|-----------|
| Bundler | Vite 5 |
| UI | Vanilla JS — no framework |
| HDR engine | OpenCV.js 4.8 (loaded from CDN, runs in a Web Worker) |
| EXIF parsing | exifr |
| Worker bridge | Native `postMessage` with Transferable ArrayBuffers |
| Styling | CSS custom properties + CSS Grid |

OpenCV.js runs entirely in a Web Worker so the UI never blocks during processing.

---

## Project structure

```
Photo-Merging/
├── app/
│   ├── index.html      # Main app entry point
│   ├── main.js         # UI logic, EXIF grouping, batch flow
│   ├── worker.js       # Flambient pipeline (OpenCV.js)
│   └── style.css       # Dark theme styles
├── src/
│   ├── main.js         # Jean Sfeir Rain landing page
│   └── style.css
├── SPEC.md             # Full technical specification
├── REFERENCES/         # Research notes and algorithm docs
├── SCRIPTS/            # Dev utilities
├── vite.config.js
└── package.json
```

---

## Roadmap

### Phase 2
- ECC alignment (more precise than MTB for handheld shots)
- Debevec HDR algorithm + Reinhard tone mapping
- 16-bit TIFF export via wasm-vips
- Ghost artifact removal (moving objects between shots)
- Batch ZIP download

### Phase 3
- RAW input (CR2, NEF, ARW, DNG) via LibRaw WASM
- 5-bracket and 7-bracket merge
- OpenEXR export
- Lightroom catalog export (XMP sidecar)

---

## Browser support

Chrome 90+, Edge 90+, Firefox 105+, Safari 16+. Requires OffscreenCanvas and Web Workers — all modern desktop browsers qualify.

---

Built by [Zigzag Studio](https://zigzagstudiox.com)
