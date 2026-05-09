import express from 'express';
import multer from 'multer';
import { spawnSync } from 'child_process';
import { writeFileSync, readFileSync, appendFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { fileURLToPath } from 'url';

const ROOT    = dirname(fileURLToPath(import.meta.url));
const LOG_DIR = join(ROOT, 'logs');
const LOG_FILE = join(LOG_DIR, 'bridge.log');
mkdirSync(LOG_DIR, { recursive: true });

function log(level, sessionId, msg) {
  const line = `[${new Date().toISOString()}] [${level}] [${sessionId}] ${msg}`;
  console.log(line);
  try { appendFileSync(LOG_FILE, line + '\n'); } catch {}
}

const app    = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

app.post(
  '/api/merge-photoshop',
  upload.fields([
    { name: 'under',  maxCount: 1 },
    { name: 'normal', maxCount: 1 },
    { name: 'over',   maxCount: 1 },
  ]),
  async (req, res) => {
    const sessionId = randomBytes(6).toString('hex');
    const tmpDir    = join(tmpdir(), `ps-merge-${sessionId}`);
    mkdirSync(tmpDir, { recursive: true });
    log('INFO', sessionId, `Request received — tmpDir: ${tmpDir}`);

    try {
      const slots     = ['under', 'normal', 'over'];
      const filePaths = [];

      for (const slot of slots) {
        const uploaded = req.files[slot]?.[0];
        if (!uploaded) {
          log('ERROR', sessionId, `Missing file slot: ${slot}`);
          res.status(400).json({ error: `Missing file: ${slot}` });
          return;
        }
        const ext   = (uploaded.originalname.split('.').pop() || 'jpg').toLowerCase();
        const fPath = join(tmpDir, `${slot}.${ext}`);
        writeFileSync(fPath, uploaded.buffer);
        log('INFO', sessionId, `Saved ${slot}: ${uploaded.originalname} (${(uploaded.buffer.length / 1024 / 1024).toFixed(1)} MB) → ${fPath}`);
        filePaths.push(fPath.replace(/\\/g, '/'));
      }

      const outputPath = join(tmpDir, 'merged.jpg').replace(/\\/g, '/');
      const jsxPath    = join(tmpDir, 'merge.jsx');
      const ps1Path    = join(tmpDir, 'run.ps1');

      writeFileSync(jsxPath, buildJsx(filePaths, outputPath));
      writeFileSync(ps1Path, buildPs1(jsxPath.replace(/\\/g, '/')));
      log('INFO', sessionId, `Scripts written — jsx: ${jsxPath}  ps1: ${ps1Path}`);

      log('INFO', sessionId, 'Spawning PowerShell…');
      const ps = spawnSync('powershell.exe', [
        '-ExecutionPolicy', 'Bypass',
        '-File', ps1Path,
      ], { timeout: 240_000, encoding: 'utf8' });

      const stdout = (ps.stdout || '').trim();
      const stderr = (ps.stderr || '').trim();
      if (stdout) log('PS-OUT', sessionId, stdout);
      if (stderr) log('PS-ERR', sessionId, stderr);
      if (ps.error) log('SPAWN-ERR', sessionId, ps.error.message);
      log('INFO', sessionId, `PowerShell exit code: ${ps.status}`);

      // Preserve a permanent copy of the PS output for this session
      const psLogPath = join(LOG_DIR, `session-${sessionId}.txt`);
      writeFileSync(psLogPath,
        `=== PowerShell stdout ===\n${stdout}\n\n=== PowerShell stderr ===\n${stderr}\n\nExit code: ${ps.status}\n`
      );
      log('INFO', sessionId, `Full PS output saved → ${psLogPath}`);

      if (ps.status !== 0) {
        // Also check for error.txt written by ExtendScript
        const extErrFile = outputPath + '.error.txt';
        const extDetail  = existsSync(extErrFile) ? readFileSync(extErrFile, 'utf8').trim() : '';
        const detail = extDetail || stderr || `PowerShell exited with code ${ps.status}`;
        throw new Error(detail);
      }

      if (!existsSync(outputPath)) {
        const extErrFile = outputPath + '.error.txt';
        const detail     = existsSync(extErrFile) ? readFileSync(extErrFile, 'utf8').trim() : 'no output file was created';
        throw new Error(detail);
      }

      const jpeg = readFileSync(outputPath);
      log('INFO', sessionId, `Success — JPEG size: ${(jpeg.length / 1024).toFixed(0)} KB`);
      res.setHeader('Content-Type', 'image/jpeg');
      res.send(jpeg);

    } catch (err) {
      log('ERROR', sessionId, `Merge failed: ${err.message}`);
      if (!res.headersSent) res.status(500).json({ error: err.message });
    } finally {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      log('INFO', sessionId, 'Temp dir cleaned up');
    }
  },
);

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
  opt.quality            = 10;
  opt.embedColorProfile  = true;
  opt.formatOptions      = FormatOptions.STANDARDBASELINE;
  mergeDoc.saveAs(new File(outputPath), opt, true, Extension.LOWERCASE);
  mergeDoc.close(SaveOptions.DONOTSAVECHANGES);
} catch(e) {
  var ef = new File("${outPath}.error.txt");
  ef.open("w"); ef.write(e.toString()); ef.close();
  throw e;
}
`;
}

function buildPs1(jsxPath) {
  return `
# Launch Photoshop if it is not already running
$running = Get-Process -Name "Photoshop" -ErrorAction SilentlyContinue
if (-not $running) {
  $psExe = $null

  # 1) Registry
  $regKey = "HKLM:\\SOFTWARE\\Adobe\\Photoshop"
  if (Test-Path $regKey) {
    $sub = Get-ChildItem $regKey -ErrorAction SilentlyContinue |
           Sort-Object Name -Descending | Select-Object -First 1
    if ($sub) {
      $appPath = (Get-ItemProperty $sub.PSPath -ErrorAction SilentlyContinue).ApplicationPath
      if ($appPath) {
        $exe = Join-Path $appPath "Photoshop.exe"
        if (Test-Path $exe) { $psExe = $exe }
      }
    }
  }

  # 2) Scan Program Files
  if (-not $psExe) {
    $dirs = Get-ChildItem "\${env:ProgramFiles}\\Adobe" -Filter "Adobe Photoshop*" -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending
    foreach ($d in $dirs) {
      $exe = Join-Path $d.FullName "Photoshop.exe"
      if (Test-Path $exe) { $psExe = $exe; break }
    }
  }

  if ($psExe) {
    Write-Host "Launching Photoshop: $psExe"
    Start-Process $psExe
    Write-Host "Waiting 12 s for Photoshop to initialise..."
    Start-Sleep -Seconds 12
  } else {
    throw "Photoshop.exe not found. Please open Photoshop manually and try again."
  }
}

Write-Host "Connecting to Photoshop COM..."
$ps = New-Object -ComObject Photoshop.Application
Write-Host "Connected. Running ExtendScript..."
$ps.DoJavaScriptFile('${jsxPath}')
Write-Host "ExtendScript completed."
`;
}

app.listen(3001, () => {
  log('INFO', 'startup', `Photoshop bridge ready → http://localhost:3001`);
  log('INFO', 'startup', `Logs → ${LOG_FILE}`);
});
