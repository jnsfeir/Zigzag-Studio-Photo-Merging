import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import express from 'express';
import multer from 'multer';
import { spawn, spawnSync } from 'child_process';
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

// ── MCP client (JSON-RPC 2.0 over stdio) ─────────────────────────────────────
class McpClient {
  constructor() {
    this.proc    = null;
    this.pending = new Map();
    this.msgId   = 1;
    this.buffer  = '';
  }

  start() {
    this.proc = spawn('npx', ['-y', '@alisaitteke/photoshop-mcp'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env:   { ...process.env, LOG_LEVEL: '0' },
      shell: false,
    });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', chunk => {
      this.buffer += chunk;
      const lines = this.buffer.split('\n');
      this.buffer  = lines.pop();
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        try {
          const msg = JSON.parse(t);
          if (msg.id != null && this.pending.has(msg.id)) {
            const { resolve, reject } = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
            else           resolve(msg.result);
          }
        } catch {}
      }
    });
    this.proc.stderr.on('data', () => {});
  }

  _send(obj) { this.proc.stdin.write(JSON.stringify(obj) + '\n'); }

  _request(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.msgId++;
      this.pending.set(id, { resolve, reject });
      this._send({ jsonrpc: '2.0', id, method, params });
      setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`MCP timeout: ${method}`));
      }, 60_000);
    });
  }

  async initialize() {
    await this._request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'zigzag-bridge', version: '1.0' },
    });
    this._send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
  }

  async listTools() {
    const r = await this._request('tools/list');
    return r.tools || [];
  }

  async callTool(name, args = {}) {
    return this._request('tools/call', { name, arguments: args });
  }

  stop() {
    try { this.proc?.stdin.end(); this.proc?.kill(); } catch {}
  }
}

const app      = express();
const upload   = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });
const anthropic = process.env.ANTHROPIC_AUTH_TOKEN
  ? new Anthropic({ authToken: process.env.ANTHROPIC_AUTH_TOKEN })
  : process.env.ANTHROPIC_API_KEY
    ? new Anthropic()
    : null;

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
    return res.status(503).json({ error: 'No Anthropic credentials configured in .env' });
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

// ── AI + Photoshop MCP merge ──────────────────────────────────────────────────
app.post(
  '/api/merge-ai',
  upload.fields([
    { name: 'under',  maxCount: 1 },
    { name: 'normal', maxCount: 1 },
    { name: 'over',   maxCount: 1 },
  ]),
  async (req, res) => {
    const sid    = randomBytes(6).toString('hex');
    const tmpDir = join(tmpdir(), `ai-merge-${sid}`);
    mkdirSync(tmpDir, { recursive: true });
    log('INFO', sid, `AI merge request — tmpDir: ${tmpDir}`);

    let mcp = null;
    try {
      if (!anthropic) {
        return res.status(503).json({ error: 'No Anthropic credentials configured in .env' });
      }

      const filePaths = {};
      for (const slot of ['under', 'normal', 'over']) {
        const uploaded = req.files[slot]?.[0];
        if (!uploaded) return res.status(400).json({ error: `Missing file: ${slot}` });
        const ext   = (uploaded.originalname.split('.').pop() || 'jpg').toLowerCase();
        const fPath = join(tmpDir, `${slot}.${ext}`).replace(/\\/g, '/');
        writeFileSync(fPath, uploaded.buffer);
        filePaths[slot] = fPath;
        log('INFO', sid, `Saved ${slot}: ${fPath}`);
      }
      const outputPath = join(tmpDir, 'merged.jpg').replace(/\\/g, '/');

      mcp = new McpClient();
      mcp.start();
      log('INFO', sid, 'MCP started — initializing…');
      await mcp.initialize();

      const mcpTools = await mcp.listTools();
      log('INFO', sid, `MCP tools (${mcpTools.length}): ${mcpTools.map(t => t.name).join(', ')}`);

      const anthropicTools = mcpTools.map(t => ({
        name:         t.name,
        description:  t.description || t.name,
        input_schema: t.inputSchema || { type: 'object', properties: {} },
      }));

      const messages = [{
        role: 'user',
        content: `You are controlling Adobe Photoshop via MCP tools to merge 3 bracketed exposures using the flambient technique (Auto-Blend Layers — Stack Images mode).

File paths (forward-slashes, already on disk):
  under:   ${filePaths.under}
  normal:  ${filePaths.normal}
  over:    ${filePaths.over}
  output:  ${outputPath}

Instructions:
1. Open all 3 files in Photoshop.
2. Create a new document matching the normal exposure dimensions (RGB, 72 dpi).
3. Duplicate each image's active layer into the new document — normal at bottom, under in middle, over on top.
4. Close the 3 source documents without saving.
5. In the new document select all layers and run Auto-Blend Layers (Stack Images, seamless tones & colors = true).
6. Flatten the document.
7. Save flattened as JPEG quality 10 to: ${outputPath}
8. Close the document without saving.

When the JPEG is saved, respond with only the word: DONE`,
      }];

      for (let round = 0; round < 30; round++) {
        log('INFO', sid, `Claude round ${round + 1}`);
        const response = await anthropic.messages.create({
          model:      'claude-sonnet-4-6',
          max_tokens: 4096,
          tools:      anthropicTools,
          messages,
        });
        messages.push({ role: 'assistant', content: response.content });

        const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
        if (text.toUpperCase().includes('DONE') || response.stop_reason === 'end_turn') {
          log('INFO', sid, 'Claude finished');
          break;
        }
        if (response.stop_reason !== 'tool_use') break;

        const toolResults = [];
        for (const block of response.content) {
          if (block.type !== 'tool_use') continue;
          log('INFO', sid, `→ ${block.name} ${JSON.stringify(block.input).slice(0, 200)}`);
          try {
            const result = await mcp.callTool(block.name, block.input);
            const out = result?.content?.[0]?.text ?? JSON.stringify(result);
            log('INFO', sid, `← ${out.slice(0, 300)}`);
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: out });
          } catch (err) {
            log('ERROR', sid, `Tool error: ${err.message}`);
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `Error: ${err.message}`, is_error: true });
          }
        }
        messages.push({ role: 'user', content: toolResults });
      }

      if (!existsSync(outputPath)) {
        throw new Error('Photoshop did not produce output — make sure Photoshop is open and try again');
      }

      const jpeg = readFileSync(outputPath);
      log('INFO', sid, `Success — ${(jpeg.length / 1024).toFixed(0)} KB`);
      res.setHeader('Content-Type', 'image/jpeg');
      res.send(jpeg);

    } catch (err) {
      log('ERROR', sid, `AI merge failed: ${err.message}`);
      if (!res.headersSent) res.status(500).json({ error: err.message });
    } finally {
      mcp?.stop();
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      log('INFO', sid, 'Temp dir cleaned up');
    }
  },
);

app.listen(3001, () => {
  log('INFO', 'startup', 'Photoshop bridge ready → http://localhost:3001');
  log('INFO', 'startup', `Logs → ${LOG_FILE}`);
});
