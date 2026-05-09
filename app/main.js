import exifr from 'exifr';

// ── State ─────────────────────────────────────────────────────────────────────
let detectedGroups = [];   // [{files: [under, normal, over], label: string}]
let mergeQueue     = [];   // groups waiting to be processed
let results        = [];   // merged ImageData objects + source label
let currentResult  = 0;
let worker         = null;
let currentMode    = 'batch';

// ── DOM ───────────────────────────────────────────────────────────────────────
const stepImport     = document.getElementById('step-import');
const stepGroups     = document.getElementById('step-groups');
const stepManual     = document.getElementById('step-manual');
const stepProcessing = document.getElementById('step-processing');
const stepResult     = document.getElementById('step-result');

const importZone     = document.getElementById('import-zone');
const filePicker     = document.getElementById('file-picker');
const btnSelectFiles = document.getElementById('btn-select-files');

const groupsGrid      = document.getElementById('groups-grid');
const groupsTitle     = document.getElementById('groups-title');
const groupsSub       = document.getElementById('groups-sub');
const btnMergeAll     = document.getElementById('btn-merge-all');
const btnBackImport   = document.getElementById('btn-back-import');

const progressBar   = document.getElementById('progress-bar');
const progressLabel = document.getElementById('progress-label');
const processingSetLabel = document.getElementById('processing-set-label');
const btnCancel     = document.getElementById('btn-cancel');

const canvasResult    = document.getElementById('canvas-result');
const canvasOriginal  = document.getElementById('canvas-original');
const compareDivider  = document.getElementById('compare-divider');
const compareContainer = document.getElementById('compare-container');
const resultLabel     = document.getElementById('result-label');
const resultCounter   = document.getElementById('result-counter');
const btnPrevResult   = document.getElementById('btn-prev-result');
const btnNextResult   = document.getElementById('btn-next-result');
const btnBackGroups   = document.getElementById('btn-back-groups');

const adjBrightness   = document.getElementById('adj-brightness');
const adjContrast     = document.getElementById('adj-contrast');
const adjSaturation   = document.getElementById('adj-saturation');
const btnResetAdj     = document.getElementById('btn-reset-adj');
const exportFormat    = document.getElementById('export-format');
const exportQuality   = document.getElementById('export-quality');
const qualityGroup    = document.getElementById('quality-group');
const btnDownload     = document.getElementById('btn-download');

const btnManualMerge  = document.getElementById('btn-manual-merge');
const manualErrorMsg  = document.getElementById('manual-error-msg');

// ── Mode toggle ───────────────────────────────────────────────────────────────
document.querySelectorAll('.mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    currentMode = btn.dataset.mode;
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.toggle('active', b === btn));
    if (currentMode === 'batch') showStep(stepImport);
    else showStep(stepManual);
  });
});

// ── Utility ───────────────────────────────────────────────────────────────────
function showStep(step) {
  [stepImport, stepGroups, stepManual, stepProcessing, stepResult].forEach(s => {
    s.classList.remove('active');
    s.classList.add('hidden');
  });
  step.classList.remove('hidden');
  step.classList.add('active');
}

function formatShutter(et) {
  if (!et) return '–';
  if (et >= 1) return `${et}s`;
  return `1/${Math.round(1/et)}s`;
}

function calcEV(tags) {
  if (!tags) return 0;
  const et  = tags.ExposureTime || 1/60;
  const iso = tags.ISOSpeedRatings || tags.ISO || 100;
  return Math.log2(1 / (et * iso / 100));
}

function getTimestamp(tags) {
  return tags?.DateTimeOriginal?.getTime?.() ??
         tags?.DateTime?.getTime?.()          ??
         null;
}

// ── EXIF reading ──────────────────────────────────────────────────────────────
async function readExif(file) {
  try {
    const tags = await exifr.parse(file, [
      'DateTimeOriginal', 'DateTime', 'SubSecTimeOriginal',
      'ExposureTime', 'FNumber', 'ISOSpeedRatings', 'ISO',
      'ExposureBiasValue',
    ]);
    return tags || {};
  } catch {
    return {};
  }
}

// ── Bracket detection ─────────────────────────────────────────────────────────
async function detectBracketGroups(files) {
  // Only accept images
  const imageFiles = [...files].filter(f =>
    /\.(jpe?g|png|tiff?)$/i.test(f.name) || f.type.startsWith('image/')
  );

  if (imageFiles.length < 2) return { groups: [], ungrouped: imageFiles };

  // Read EXIF for all files in parallel
  const data = await Promise.all(imageFiles.map(async f => ({
    file: f,
    tags: await readExif(f),
  })));

  // Sort by timestamp if available, otherwise by filename
  const hasTimestamps = data.some(d => getTimestamp(d.tags) !== null);
  if (hasTimestamps) {
    data.sort((a, b) => {
      const ta = getTimestamp(a.tags) ?? Infinity;
      const tb = getTimestamp(b.tags) ?? Infinity;
      return ta - tb;
    });
  } else {
    data.sort((a, b) => a.file.name.localeCompare(b.file.name));
  }

  // Cluster into bracket sets
  // Strategy: consecutive images within 30s of each other form a cluster.
  // Then within each cluster we sort by EV and pick triplets.
  const clusters = [];
  let cluster = [data[0]];

  for (let i = 1; i < data.length; i++) {
    const prev = data[i - 1];
    const curr = data[i];
    const tPrev = getTimestamp(prev.tags);
    const tCurr = getTimestamp(curr.tags);
    const gap = (tPrev !== null && tCurr !== null)
      ? Math.abs(tCurr - tPrev) / 1000
      : 0; // no timestamps → treat as same cluster

    if (gap <= 30) {
      cluster.push(curr);
    } else {
      clusters.push(cluster);
      cluster = [curr];
    }
  }
  clusters.push(cluster);

  // Within each cluster, sort by EV and split into triplets
  const groups = [];
  const ungrouped = [];

  clusters.forEach((cl, ci) => {
    // Sort by computed EV (ascending = darkest first)
    cl.sort((a, b) => calcEV(a.tags) - calcEV(b.tags));

    // Slice into groups of 3
    for (let i = 0; i + 2 < cl.length; i += 3) {
      const triplet = cl.slice(i, i + 3);
      groups.push({
        files: triplet.map(d => d.file),
        tags:  triplet.map(d => d.tags),
        label: `Set ${groups.length + 1}`,
      });
    }
    // Remainder
    const rem = cl.length % 3;
    if (rem > 0) {
      ungrouped.push(...cl.slice(cl.length - rem).map(d => d.file));
    }
  });

  return { groups, ungrouped };
}

// ── File handling entry point ─────────────────────────────────────────────────
async function handleFiles(files) {
  if (!files || files.length === 0) return;

  groupsTitle.textContent = 'Detecting bracket sets…';
  groupsSub.textContent   = `Reading EXIF from ${files.length} image${files.length !== 1 ? 's' : ''}…`;
  groupsGrid.innerHTML    = '';
  showStep(stepGroups);

  const { groups, ungrouped } = await detectBracketGroups(files);

  detectedGroups = groups;

  if (groups.length === 0) {
    groupsTitle.textContent = 'No bracket sets detected';
    groupsSub.textContent   = 'Could not find groups of 3 bracketed images. Try Manual mode.';
    return;
  }

  groupsTitle.textContent = `${groups.length} bracket set${groups.length !== 1 ? 's' : ''} detected`;
  groupsSub.textContent   = `${files.length} images · flambient pipeline`;

  // Update merge-all badge
  btnMergeAll.innerHTML = `Merge All Sets <span class="queue-badge">${groups.length}</span>`;

  renderGroups(groups);

  // Ungrouped
  const ungroupedSection = document.getElementById('ungrouped-section');
  if (ungrouped.length > 0) {
    ungroupedSection.classList.remove('hidden');
    document.getElementById('ungrouped-grid').innerHTML =
      ungrouped.map(f => `<span style="font-size:11px;color:var(--text3)">${f.name}</span>`).join(', ');
  } else {
    ungroupedSection.classList.add('hidden');
  }
}

// ── Render groups ─────────────────────────────────────────────────────────────
function renderGroups(groups) {
  groupsGrid.innerHTML = '';

  groups.forEach((group, idx) => {
    const card = document.createElement('div');
    card.className = 'group-card';

    const evLabels = ['−2 EV', '0 EV', '+2 EV'];
    const thumbsHtml = group.files.map((file, i) => {
      const url = URL.createObjectURL(file);
      const tags = group.tags[i];
      const shutter = formatShutter(tags?.ExposureTime);
      const iso = tags?.ISOSpeedRatings || tags?.ISO;
      const meta = [shutter, iso ? `ISO ${iso}` : ''].filter(Boolean).join(' · ');
      return `
        <div class="group-thumb-item">
          <img class="group-thumb-img" src="${url}" alt="${evLabels[i]}" data-revoke="${url}" />
          <div class="group-thumb-ev">${evLabels[i]}</div>
          <div class="group-thumb-meta">${meta}</div>
        </div>`;
    }).join('');

    card.innerHTML = `
      <div class="group-card-header">
        <span class="group-card-name">${group.label}</span>
        <span class="group-card-tag">AUTO</span>
      </div>
      <div class="group-thumbs">${thumbsHtml}</div>
      <div class="group-card-footer">
        <button class="group-merge-btn"
          data-tip="Merge these 3 exposures into one flambient image">
          Merge This Set
        </button>
      </div>`;

    card.querySelector('.group-merge-btn').addEventListener('click', () => {
      mergeGroup(group, `${group.label} of ${groups.length}`);
    });

    // Revoke object URLs when images load to free memory
    card.querySelectorAll('[data-revoke]').forEach(img => {
      img.addEventListener('load', () => URL.revokeObjectURL(img.dataset.revoke), { once: true });
    });

    groupsGrid.appendChild(card);
  });
}

// ── Merge ─────────────────────────────────────────────────────────────────────
async function mergeGroup(group, setLabel = '') {
  processingSetLabel.textContent = setLabel.toUpperCase();
  progressBar.style.width  = '0%';
  progressLabel.textContent = 'Preparing…';
  showStep(stepProcessing);

  const [underBuf, normalBuf, overBuf] = await Promise.all(
    group.files.map(f => f.arrayBuffer())
  );

  if (!worker) {
    worker = new Worker(new URL('./worker.js', import.meta.url));
  }

  worker.onmessage = (e) => {
    const { type, progress, label, result, error } = e.data;

    if (type === 'progress') {
      progressBar.style.width   = `${progress}%`;
      progressLabel.textContent = label;
      return;
    }
    if (type === 'error') {
      showStep(stepGroups);
      alert('Merge failed: ' + error);
      return;
    }
    if (type === 'result') {
      const { width, height, data } = result;
      const imageData = new ImageData(new Uint8ClampedArray(data), width, height);
      const originalFile = group.files[1]; // normal exposure for compare

      results.push({ imageData, originalFile, label: group.label });
      currentResult = results.length - 1;

      // If there are more in the queue, keep going
      if (mergeQueue.length > 0) {
        const next = mergeQueue.shift();
        mergeGroup(next, `${next.label} · ${mergeQueue.length} remaining`);
      } else {
        showResultStep();
      }
    }
  };

  worker.postMessage({ type: 'merge', under: underBuf, normal: normalBuf, over: overBuf },
    [underBuf, normalBuf, overBuf]);
}

// ── Merge all ─────────────────────────────────────────────────────────────────
btnMergeAll.addEventListener('click', () => {
  if (detectedGroups.length === 0) return;
  results = [];
  mergeQueue = [...detectedGroups.slice(1)];
  mergeGroup(detectedGroups[0], `${detectedGroups[0].label} · ${detectedGroups.length} total`);
});

btnCancel.addEventListener('click', () => {
  if (worker) { worker.terminate(); worker = null; }
  mergeQueue = [];
  showStep(currentMode === 'batch' ? stepGroups : stepManual);
});

btnBackImport.addEventListener('click', () => showStep(stepImport));
btnBackGroups.addEventListener('click', () => showStep(stepGroups));

// ── Import zone ───────────────────────────────────────────────────────────────
btnSelectFiles.addEventListener('click', () => filePicker.click());
filePicker.addEventListener('change', e => { handleFiles(e.target.files); filePicker.value = ''; });

importZone.addEventListener('dragover', e => {
  e.preventDefault();
  importZone.classList.add('drag-over');
});
importZone.addEventListener('dragleave', () => importZone.classList.remove('drag-over'));
importZone.addEventListener('drop', async e => {
  e.preventDefault();
  importZone.classList.remove('drag-over');
  const files = await collectDroppedFiles(e.dataTransfer);
  handleFiles(files);
});

async function collectDroppedFiles(dataTransfer) {
  const files = [];
  const items = [...(dataTransfer.items || [])];

  for (const item of items) {
    const entry = item.webkitGetAsEntry?.();
    if (entry?.isDirectory) {
      const dirFiles = await readDirectoryRecursive(entry);
      files.push(...dirFiles);
    } else if (item.kind === 'file') {
      const f = item.getAsFile();
      if (f) files.push(f);
    }
  }

  return files.length > 0 ? files : [...(dataTransfer.files || [])];
}

function readDirectoryRecursive(dirEntry) {
  return new Promise(resolve => {
    const reader = dirEntry.createReader();
    const allFiles = [];

    (function readChunk() {
      reader.readEntries(async entries => {
        if (entries.length === 0) { resolve(allFiles); return; }
        for (const entry of entries) {
          if (entry.isFile) {
            const f = await new Promise(r => entry.file(r));
            allFiles.push(f);
          } else if (entry.isDirectory) {
            const sub = await readDirectoryRecursive(entry);
            allFiles.push(...sub);
          }
        }
        readChunk();
      });
    })();
  });
}

// ── Manual 3-slot mode ────────────────────────────────────────────────────────
const manualSlots = { under: null, normal: null, over: null };

document.querySelectorAll('.slot').forEach(slotEl => {
  const key      = slotEl.dataset.slot;
  const fileInput = slotEl.querySelector('.file-input');
  const dropZone  = slotEl.querySelector('.slot-drop-zone');
  const preview   = slotEl.querySelector('.slot-preview');
  const thumb     = slotEl.querySelector('.thumb');
  const exifDiv   = slotEl.querySelector('.exif-info');
  const removeBtn = slotEl.querySelector('.remove-btn');

  const loadFile = async (file) => {
    if (!/\.(jpe?g|png)$/i.test(file.name) && !file.type.startsWith('image/')) {
      slotEl.classList.add('error');
      return;
    }
    slotEl.classList.remove('error');
    const url = URL.createObjectURL(file);
    thumb.src = url;
    thumb.onload = () => URL.revokeObjectURL(url);

    const tags = await readExif(file);
    const parts = [];
    if (tags.ExposureTime) parts.push(formatShutter(tags.ExposureTime));
    if (tags.FNumber)      parts.push(`f/${tags.FNumber}`);
    const iso = tags.ISOSpeedRatings || tags.ISO;
    if (iso) parts.push(`ISO ${iso}`);
    exifDiv.textContent = parts.join(' · ');

    manualSlots[key] = file;
    slotEl.classList.add('filled');
    dropZone.classList.add('hidden');
    preview.classList.remove('hidden');
    updateManualBtn();
  };

  fileInput.addEventListener('change', e => { if (e.target.files[0]) loadFile(e.target.files[0]); fileInput.value = ''; });

  slotEl.addEventListener('dragover', e => { e.preventDefault(); slotEl.classList.add('drag-over'); });
  slotEl.addEventListener('dragleave', () => slotEl.classList.remove('drag-over'));
  slotEl.addEventListener('drop', e => { e.preventDefault(); slotEl.classList.remove('drag-over'); if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]); });

  removeBtn.addEventListener('click', e => {
    e.stopPropagation();
    manualSlots[key] = null;
    thumb.src = ''; exifDiv.textContent = '';
    slotEl.classList.remove('filled', 'error');
    dropZone.classList.remove('hidden');
    preview.classList.add('hidden');
    updateManualBtn();
  });
});

function updateManualBtn() {
  btnManualMerge.disabled = !(manualSlots.under && manualSlots.normal && manualSlots.over);
}

btnManualMerge.addEventListener('click', () => {
  const group = {
    files: [manualSlots.under, manualSlots.normal, manualSlots.over],
    tags:  [{}, {}, {}],
    label: 'Manual Merge',
  };
  results = [];
  mergeGroup(group, 'Manual Merge');
});

// ── Result step ───────────────────────────────────────────────────────────────
function showResultStep() {
  showStep(stepResult);
  displayResult(currentResult);
  resetCompareDivider();
}

function displayResult(idx) {
  const r = results[idx];
  if (!r) return;

  const { imageData, originalFile, label } = r;
  canvasResult.width  = imageData.width;
  canvasResult.height = imageData.height;
  const ctx = canvasResult.getContext('2d');
  ctx.putImageData(imageData, 0, 0);
  applyToneAdjustments();

  // Draw original (normal exposure) on overlay canvas
  const img = new Image();
  const url = URL.createObjectURL(originalFile);
  img.onload = () => {
    canvasOriginal.width  = imageData.width;
    canvasOriginal.height = imageData.height;
    canvasOriginal.getContext('2d').drawImage(img, 0, 0, imageData.width, imageData.height);
    URL.revokeObjectURL(url);
  };
  img.src = url;

  resultLabel.textContent = label;
  resultCounter.textContent = results.length > 1 ? `${idx + 1} / ${results.length}` : '';
  btnPrevResult.disabled = idx === 0;
  btnNextResult.disabled = idx === results.length - 1;
}

function applyToneAdjustments() {
  const r = results[currentResult];
  if (!r) return;

  const b = parseInt(adjBrightness.value);
  const c = parseInt(adjContrast.value);
  const s = parseInt(adjSaturation.value);

  const brightF  = 1 + b / 100;
  const contrastF = 1 + c / 100;
  const satF      = 1 + s / 100;

  const { width, height, imageData } = r;
  canvasResult.width  = imageData.width;
  canvasResult.height = imageData.height;

  const ctx = canvasResult.getContext('2d');
  ctx.putImageData(imageData, 0, 0);

  // Redraw with filter via OffscreenCanvas
  const tmp = new OffscreenCanvas(imageData.width, imageData.height);
  const tCtx = tmp.getContext('2d');
  tCtx.filter = `brightness(${brightF}) contrast(${contrastF}) saturate(${satF})`;
  tCtx.drawImage(canvasResult, 0, 0);
  ctx.clearRect(0, 0, imageData.width, imageData.height);
  ctx.drawImage(tmp, 0, 0);
}

[adjBrightness, adjContrast, adjSaturation].forEach(s => s.addEventListener('input', applyToneAdjustments));

btnResetAdj.addEventListener('click', () => {
  adjBrightness.value = adjContrast.value = adjSaturation.value = '0';
  document.querySelectorAll('#step-result .slider-val').forEach(v => {
    if (v.previousElementSibling?.type === 'range') v.textContent = '0';
  });
  applyToneAdjustments();
});

btnPrevResult.addEventListener('click', () => { currentResult--; displayResult(currentResult); resetCompareDivider(); });
btnNextResult.addEventListener('click', () => { currentResult++; displayResult(currentResult); resetCompareDivider(); });

// ── Compare divider ───────────────────────────────────────────────────────────
function resetCompareDivider() { setDividerAt(50); }

function setDividerAt(pct) {
  compareDivider.style.left = `${pct}%`;
  canvasOriginal.style.clipPath = `inset(0 ${100 - pct}% 0 0)`;
}

let dragging = false;
compareDivider.addEventListener('mousedown', () => { dragging = true; });
document.addEventListener('mouseup',  () => { dragging = false; });
document.addEventListener('mousemove', e => {
  if (!dragging) return;
  const rect = compareContainer.getBoundingClientRect();
  setDividerAt(Math.max(0, Math.min(100, (e.clientX - rect.left) / rect.width * 100)));
});

compareDivider.addEventListener('touchstart', e => { dragging = true; e.preventDefault(); }, { passive: false });
document.addEventListener('touchend', () => { dragging = false; });
document.addEventListener('touchmove', e => {
  if (!dragging) return;
  const rect = compareContainer.getBoundingClientRect();
  setDividerAt(Math.max(0, Math.min(100, (e.touches[0].clientX - rect.left) / rect.width * 100)));
}, { passive: true });

// ── Export ────────────────────────────────────────────────────────────────────
exportFormat.addEventListener('change', () => {
  qualityGroup.style.display = exportFormat.value === 'jpeg' ? '' : 'none';
});

btnDownload.addEventListener('click', () => {
  const fmt  = exportFormat.value;
  const q    = parseInt(exportQuality.value) / 100;
  const mime = fmt === 'jpeg' ? 'image/jpeg' : 'image/png';
  const ext  = fmt === 'jpeg' ? 'jpg' : 'png';
  const name = (results[currentResult]?.label || 'merge').replace(/\s+/g, '-').toLowerCase();

  canvasResult.toBlob(blob => {
    const url = URL.createObjectURL(blob);
    const a   = Object.assign(document.createElement('a'), { href: url, download: `zigzag-${name}.${ext}` });
    a.click();
    URL.revokeObjectURL(url);
  }, mime, q);
});

// ── Slider value display ──────────────────────────────────────────────────────
document.querySelectorAll('input[type="range"]').forEach(input => {
  const span = input.nextElementSibling;
  if (span?.classList.contains('slider-val')) {
    input.addEventListener('input', () => {
      span.textContent = Number(input.value).toFixed(input.step < 1 ? 1 : 0);
    });
  }
});
