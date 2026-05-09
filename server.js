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
      const innerPs1    = join(tmpDir, 'inner.ps1');   // runs COM — must be in interactive session
      const outerPs1    = join(tmpDir, 'outer.ps1');   // schedules inner via Task Scheduler

      writeFileSync(jsxPath,  buildJsx(filePaths, outputPath));
      writeFileSync(innerPs1, buildInnerPs1(jsxPath.replace(/\\/g, '/'), outputPath));
      writeFileSync(outerPs1, buildOuterPs1(innerPs1, outputPath));
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

      // Check for ExtendScript error sidecar
      const extErr = existsSync(outputPath + '.error.txt')
        ? readFileSync(outputPath + '.error.txt', 'utf8').trim() : '';

      if (ps.status !== 0 || !existsSync(outputPath)) {
        throw new Error(extErr || stderr || `Process exited ${ps.status} — no output produced`);
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
    throw "Photoshop.exe not found — open Photoshop and try again"
  }
}
Write-Host "Inner: connecting COM..."
$ps = New-Object -ComObject Photoshop.Application
Write-Host "Inner: COM connected, running JSX..."
$ps.DoJavaScriptFile('${jsxPath}')
Write-Host "Inner: done."
`;
}

// ── Outer PS1: schedules inner.ps1 via Task Scheduler in the interactive session
function buildOuterPs1(innerPs1Path, outputPath) {
  const taskName = `ZZMerge_${randomBytes(4).toString('hex')}`;
  const safe = (s) => s.replace(/\\/g, '\\\\');
  return `$ErrorActionPreference = 'Stop'
$taskName   = '${taskName}'
$innerScript = '${safe(innerPs1Path)}'
$outputPath  = '${safe(outputPath)}'

Write-Host "Outer: registering scheduled task $taskName"
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$action      = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \`"$innerScript\`""
$settings    = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 4)
$principal   = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $taskName -Action $action -Settings $settings -Principal $principal -Force | Out-Null

Write-Host "Outer: starting task..."
Start-ScheduledTask -TaskName $taskName

# Poll until the task finishes or 4-minute deadline
$deadline = (Get-Date).AddMinutes(4)
do {
  Start-Sleep -Seconds 3
  $state = (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue).State
  Write-Host "Outer: task state = $state"
} while ($state -eq 'Running' -and (Get-Date) -lt $deadline)

$info = Get-ScheduledTaskInfo -TaskName $taskName -ErrorAction SilentlyContinue
Write-Host "Outer: last result = $($info.LastTaskResult)"
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue | Out-Null

if ($info.LastTaskResult -ne 0) {
  throw "Photoshop task exited with code $($info.LastTaskResult)"
}
if (-not (Test-Path $outputPath)) {
  throw "Task succeeded but output file not found: $outputPath"
}
Write-Host "Outer: output confirmed at $outputPath"
`;
}

app.listen(3001, () => {
  log('INFO', 'startup', 'Photoshop bridge ready → http://localhost:3001');
  log('INFO', 'startup', `Logs → ${LOG_FILE}`);
});
