import express from 'express';
import multer from 'multer';
import { execFileSync } from 'child_process';
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';

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
    const sessionId = randomBytes(8).toString('hex');
    const tmpDir    = join(tmpdir(), `ps-merge-${sessionId}`);
    mkdirSync(tmpDir, { recursive: true });

    try {
      const slots     = ['under', 'normal', 'over'];
      const filePaths = [];

      for (const slot of slots) {
        const uploaded = req.files[slot]?.[0];
        if (!uploaded) {
          res.status(400).json({ error: `Missing file: ${slot}` });
          return;
        }
        const ext   = (uploaded.originalname.split('.').pop() || 'jpg').toLowerCase();
        const fPath = join(tmpDir, `${slot}.${ext}`);
        writeFileSync(fPath, uploaded.buffer);
        filePaths.push(fPath.replace(/\\/g, '/'));
      }

      const outputPath = join(tmpDir, 'merged.jpg').replace(/\\/g, '/');
      const jsxPath    = join(tmpDir, 'merge.jsx');
      const ps1Path    = join(tmpDir, 'run.ps1');

      writeFileSync(jsxPath, buildJsx(filePaths, outputPath));
      writeFileSync(ps1Path, buildPs1(jsxPath.replace(/\\/g, '/')));

      execFileSync('powershell.exe', [
        '-ExecutionPolicy', 'Bypass',
        '-File', ps1Path,
      ], { timeout: 240_000 });

      if (!existsSync(outputPath)) {
        const errFile = outputPath + '.error.txt';
        const detail  = existsSync(errFile) ? readFileSync(errFile, 'utf8') : 'no output file was created';
        throw new Error(detail);
      }

      const jpeg = readFileSync(outputPath);
      res.setHeader('Content-Type', 'image/jpeg');
      res.send(jpeg);

    } catch (err) {
      console.error('[PS Bridge]', err.message);
      if (!res.headersSent) res.status(500).json({ error: err.message });
    } finally {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
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

  # 1) Try registry (works for all recent PS versions)
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

  # 2) Fallback: scan Program Files for any "Adobe Photoshop*" folder
  if (-not $psExe) {
    $dirs = Get-ChildItem "${env:ProgramFiles}\\Adobe" -Filter "Adobe Photoshop*" -ErrorAction SilentlyContinue |
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

$ps = New-Object -ComObject Photoshop.Application
$ps.DoJavaScriptFile('${jsxPath}')
`;
}

app.listen(3001, () => console.log('Photoshop bridge ready → http://localhost:3001'));
