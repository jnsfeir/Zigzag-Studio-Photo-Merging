import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import express from 'express';
import multer from 'multer';
import { spawnSync } from 'child_process';
import { writeFileSync, readFileSync, appendFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { fileURLToPath } from 'url';

const ROOT     = dirname(fileURLToPath(import.meta.url));
const LOG_DIR  = join(ROOT, 'logs');
const LOG_FILE = join(LOG_DIR, 'bridge.log');
mkdirSync(LOG_DIR, { recursive: true });

function log(level, sid, msg) {
  const line = `[${new Date().toISOString()}] [${level}] [${sid}] ${msg}`;
  console.log(line);
  try { appendFileSync(LOG_FILE, line + '\n'); } catch {}
}

const app      = express();
const upload   = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;

app.post(
  '/api/merge-photoshop',
  upload.fields([
    { name: 'under',  maxCount: 1 },
    { name: 'normal', maxCount: 1 },
    { name: 'over',   maxCount: 1 },
  ]),
  async (req, res) => {
    const sid    = randomBytes(6).toString('hex');
    const tmpDir = join(tmpdir(), `ps-merge-${sid}`);
    mkdirSync(tmpDir, { recursive: true });
    log('INFO', sid, `Request received — tmpDir: ${tmpDir}`);

    try {
      const filePaths = [];
      for (const slot of ['under', 'normal', 'over']) {
        const uploaded = req.files[slot]?.[0];
        if (!uploaded) {
          log('ERROR', sid, `Missing slot: ${slot}`);
          res.status(400).json({ error: `Missing file: ${slot}` });
          return;
        }
        const ext   = (uploaded.originalname.split('.').pop() || 'jpg').toLowerCase();
        const fPath = join(tmpDir, `${slot}.${ext}`);
        writeFileSync(fPath, uploaded.buffer);
        log('INFO', sid, `Saved ${slot}: ${uploaded.originalname} (${(uploaded.buffer.length / 1024 / 1024).toFixed(1)} MB)`);
        filePaths.push(fPath.replace(/\\/g, '/'));
      }

      const outputPath  = join(tmpDir, 'merged.jpg').replace(/\\/g, '/');
      const jsxPath     = join(tmpDir, 'merge.jsx');
      const innerPs1    = join(tmpDir, 'inner.ps1');
      const outerPs1    = join(tmpDir, 'outer.ps1');
      const innerLog    = join(LOG_DIR, `inner-${sid}.txt`).replace(/\\/g, '/');

      writeFileSync(jsxPath,  buildJsx(filePaths, outputPath));
      writeFileSync(innerPs1, buildInnerPs1(jsxPath.replace(/\\/g, '/'), outputPath));
      writeFileSync(outerPs1, buildOuterPs1(innerPs1, outputPath, innerLog));
      log('INFO', sid, `Scripts written: jsx, inner.ps1, outer.ps1`);

      log('INFO', sid, 'Spawning outer PowerShell (Task Scheduler bridge)…');
      const ps = spawnSync('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', outerPs1,
      ], { timeout: 300_000, encoding: 'utf8' });

      const stdout = (ps.stdout || '').trim();
      const stderr = (ps.stderr || '').trim();
      if (stdout) log('PS-OUT', sid, stdout);
      if (stderr) log('PS-ERR', sid, stderr);
      if (ps.error) log('SPAWN-ERR', sid, ps.error.message);
      log('INFO', sid, `PowerShell exit code: ${ps.status}`);

      writeFileSync(
        join(LOG_DIR, `session-${sid}.txt`),
        `=== stdout ===\n${stdout}\n\n=== stderr ===\n${stderr}\n\nExit: ${ps.status}\n`,
      );
      log('INFO', sid, `Session log → logs/session-${sid}.txt`);

      // Log what the scheduled task (inner.ps1) printed
      if (existsSync(innerLog)) {
        const innerOut = readFileSync(innerLog, 'utf8').trim();
        if (innerOut) log('INNER', sid, innerOut);
      } else {
        log('INNER', sid, '(no inner log written - task may not have run)');
      }

      // Check for ExtendScript error sidecar written by the JSX
      const extErrFile = outputPath + '.error.txt';
      const extErr = existsSync(extErrFile) ? readFileSync(extErrFile, 'utf8').trim() : '';
      if (extErr) log('JSX-ERR', sid, extErr);

      if (ps.status !== 0 || !existsSync(outputPath)) {
        throw new Error(extErr || stderr || `Process exited ${ps.status} - no output produced`);
      }

      const jpeg = readFileSync(outputPath);
      log('INFO', sid, `Success — JPEG ${(jpeg.length / 1024).toFixed(0)} KB`);
      res.setHeader('Content-Type', 'image/jpeg');
      res.send(jpeg);

    } catch (err) {
      log('ERROR', sid, `Merge failed: ${err.message}`);
      if (!res.headersSent) res.status(500).json({ error: err.message });
    } finally {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      log('INFO', sid, 'Temp dir cleaned up');
    }
  },
);

// ── ExtendScript (runs inside Photoshop) ─────────────────────────────────────
function buildJsx(paths, outPath) {
  const [p0, p1, p2] = paths;
  return `#target photoshop
app.displayDialogs = DialogModes.NO;
try {
  var filePaths  = ["${p0}", "${p1}", "${p2}"];
  var outputPath = "${outPath}";
  var docs = [];
  for (var i = 0; i < filePaths.length; i++) {
    docs.push(app.open(new File(filePaths[i])));
  }
  var base     = docs[0];
  var mergeDoc = app.documents.add(base.width, base.height, base.resolution, "ZZ_Merge", NewDocumentMode.RGB, DocumentFill.TRANSPARENT);
  for (var i = 0; i < docs.length; i++) {
    docs[i].activeLayer.duplicate(mergeDoc, ElementPlacement.PLACEATEND);
    docs[i].close(SaveOptions.DONOTSAVECHANGES);
  }
  app.activeDocument = mergeDoc;
  mergeDoc.autoBlendLayers(AutoBlendType.STACKIMAGES, true, false);
  mergeDoc.flatten();
  var opt = new JPEGSaveOptions();
  opt.quality           = 10;
  opt.embedColorProfile = true;
  opt.formatOptions     = FormatOptions.STANDARDBASELINE;
  mergeDoc.saveAs(new File(outputPath), opt, true, Extension.LOWERCASE);
  mergeDoc.close(SaveOptions.DONOTSAVECHANGES);
} catch(e) {
  var ef = new File("${outPath}.error.txt");
  ef.open("w"); ef.write(e.toString()); ef.close();
  throw e;
}
`;
}

// ── Inner PS1: the actual COM call — runs in the interactive user session ────
function buildInnerPs1(jsxPath, outPath) {
  return `$ErrorActionPreference = 'Stop'
Write-Host "Inner: checking Photoshop process..."
$running = Get-Process -Name "Photoshop" -ErrorAction SilentlyContinue
if (-not $running) {
  $psExe = $null
  $regKey = "HKLM:\\SOFTWARE\\Adobe\\Photoshop"
  if (Test-Path $regKey) {
    $sub = Get-ChildItem $regKey -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
    if ($sub) {
      $ap = (Get-ItemProperty $sub.PSPath -ErrorAction SilentlyContinue).ApplicationPath
      if ($ap) { $exe = Join-Path $ap "Photoshop.exe"; if (Test-Path $exe) { $psExe = $exe } }
    }
  }
  if (-not $psExe) {
    Get-ChildItem "$env:ProgramFiles\\Adobe" -Filter "Adobe Photoshop*" -ErrorAction SilentlyContinue |
      Sort-Object Name -Descending | ForEach-Object {
        $exe = Join-Path $_.FullName "Photoshop.exe"
        if ((Test-Path $exe) -and (-not $psExe)) { $psExe = $exe }
      }
  }
  if ($psExe) {
    Write-Host "Inner: launching $psExe"
    Start-Process $psExe
    Write-Host "Inner: waiting 12 s..."
    Start-Sleep -Seconds 12
  } else {
    throw "Photoshop.exe not found - open Photoshop and try again"
  }
}
Write-Host "Inner: connecting COM..."
$ps = New-Object -ComObject Photoshop.Application
Write-Host "Inner: COM connected, running JSX..."
$ps.DoJavaScriptFile('${jsxPath}')
Write-Host "Inner: done."
`;
}

// ── Outer PS1: uses schtasks.exe (avoids WMI permission issues from Node subprocess)
function buildOuterPs1(innerPs1Path, outputPath, innerLogPath) {
  const taskName = `ZZMerge_${randomBytes(4).toString('hex')}`;
  return `$ErrorActionPreference = 'Stop'
$taskName   = '${taskName}'
$innerPath  = '${innerPs1Path.replace(/\\/g, '/')}'
$outputPath = '${outputPath.replace(/\\/g, '/')}'
$innerLog   = '${innerLogPath}'

# schtasks.exe uses a different RPC path - works from non-interactive processes
$tr = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $innerPath >> $innerLog 2>&1"
$st = (Get-Date).AddMinutes(2).ToString("HH:mm")
Write-Host "Outer: creating task $taskName (ST=$st)"
& schtasks.exe /Create /TN $taskName /TR $tr /SC ONCE /ST $st /F /IT 2>&1 | Write-Host

Write-Host "Outer: starting task immediately"
& schtasks.exe /Run /TN $taskName 2>&1 | Write-Host
if ($LASTEXITCODE -ne 0) { throw "schtasks run failed (exit $LASTEXITCODE)" }

Write-Host "Outer: polling for output..."
$deadline = (Get-Date).AddMinutes(4)
while (-not (Test-Path $outputPath) -and (Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 3
  Write-Host "Outer: waiting..."
}
& schtasks.exe /Delete /TN $taskName /F 2>&1 | Out-Null

if (-not (Test-Path $outputPath)) {
  throw "Timeout - Photoshop did not produce output within 4 minutes"
}
Write-Host "Outer: output confirmed"
`;
}

// ── AI color analysis ─────────────────────────────────────────────────────────
app.post('/api/color-analyze', express.json({ limit: '5mb' }), async (req, res) => {
  const sid = randomBytes(4).toString('hex');

  if (!anthropic) {
    return res.status(503).json({ error: 'ANTHROPIC_API_KEY not set. Set it in your terminal before starting the server.' });
  }

  const { image } = req.body;
  if (!image || typeof image !== 'string') {
    return res.status(400).json({ error: 'Missing image field' });
  }

  log('INFO', sid, 'Color analysis request');

  try {
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image } },
          { type: 'text', text: `You are a professional color grading AI for real estate photography.

Analyze this real estate photo and return optimal color correction parameters.

Common issues: tungsten/warm LED lights cause orange cast (lower r_scale, raise b_scale). Daylight only = blue cast (opposite). Fluorescent = slight green (lower g_scale). Mixed lighting is most common.

Respond with ONLY a valid JSON object, no other text:
{"r_scale":1.0,"g_scale":1.0,"b_scale":1.0,"brightness":0,"contrast":0,"saturation":0,"reason":""}

Rules: r/g/b_scale range 0.85-1.15 only. brightness/contrast/saturation -30 to +30 only. Be conservative — subtle is professional, heavy is fake. reason: one sentence describing the main issue corrected.` }
        ]
      }]
    });

    const text = msg.content[0].text.trim();
    log('INFO', sid, `AI response: ${text}`);

    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON in AI response');
    const p = JSON.parse(match[0]);

    const clamp = (v, lo, hi, def) => typeof v === 'number' && isFinite(v) ? Math.max(lo, Math.min(hi, v)) : def;
    res.json({
      r_scale:    clamp(p.r_scale,    0.80, 1.20, 1.0),
      g_scale:    clamp(p.g_scale,    0.80, 1.20, 1.0),
      b_scale:    clamp(p.b_scale,    0.80, 1.20, 1.0),
      brightness: clamp(p.brightness, -50,  50,   0),
      contrast:   clamp(p.contrast,   -50,  50,   0),
      saturation: clamp(p.saturation, -50,  50,   0),
      reason:     typeof p.reason === 'string' ? p.reason : '',
    });

  } catch (err) {
    log('ERROR', sid, `Color analysis failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.listen(3001, () => {
  log('INFO', 'startup', 'Photoshop bridge ready → http://localhost:3001');
  log('INFO', 'startup', `Logs → ${LOG_FILE}`);
});
