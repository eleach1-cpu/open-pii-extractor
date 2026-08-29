// Open PII Extractor, Electron main process.
//
// Safety architecture (handoff 2026-08-29):
//   - the OS process sandbox is ON; contextIsolation on, nodeIntegration off;
//   - every privileged IPC handler validates the SENDER FRAME first, then the
//     terms-acceptance gate, then argument shapes and sizes (lib/limits.js);
//   - no input is ever silently truncated or partially processed: over-limit
//     input rejects the WHOLE request with a named reason (owner default 1);
//   - every save handler returns { saved:false, error } instead of throwing;
//   - all document processing happens locally: renderer web requests are
//     cancelled, permissions denied, new windows denied, OCR language data
//     bundled. (The user-facing claim uses the precise no-upload wording,
//     owner default 3.)
// The redaction engine (lib/) is synced from RateMyVSO_Platform, see SYNC.md.

'use strict';

const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { app, BrowserWindow, ipcMain, dialog, session, shell } = require('electron');

// The OS-level Chromium sandbox for every renderer (safety handoff §10).
app.enableSandbox();

// Point the OCR worker's traineddata cache at the bundled copy BEFORE any
// lib require. In dev (unpackaged) that's assets/tessdata; packaged, it's
// resources/tessdata via extraResources.
const TESSDATA_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'tessdata')
  : path.join(__dirname, 'assets', 'tessdata');
process.env.TESSERACT_CACHE_DIR = TESSDATA_DIR;

const { stripLetterPII } = require('./lib/strip-letter-pii');
const { ocrImage, ocrPdf } = require('./lib/local-ocr');
const { findRedactedSpans } = require('./lib/redaction-spans');
const { LIMITS, sniffKind } = require('./lib/limits');
const terms = require('./lib/terms');
const { buildRedactedPdf } = require('./lib/build-redacted-pdf');
const { buildLayoutPdf } = require('./lib/build-layout-pdf');

const SMOKE = process.env.OPE_SMOKE === '1';
const userDataDir = () => (SMOKE && process.env.OPE_SMOKE_USERDATA) ? process.env.OPE_SMOKE_USERDATA : app.getPath('userData');

function createWindow() {
  const win = new BrowserWindow({
    width: 1000,
    height: 760,
    minWidth: 640,
    minHeight: 480,
    title: 'Open PII Extractor',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  return win;
}

app.whenReady().then(() => {
  // ---- Local-only enforcement --------------------------------------------
  // Cancel every renderer request that is not a local file / devtools
  // resource; deny every permission; deny new windows and web navigation.
  session.defaultSession.webRequest.onBeforeRequest((details, cb) => {
    const ok = /^(file|devtools|chrome-extension|data|blob):/.test(details.url);
    cb({ cancel: !ok });
  });
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => cb(false));

  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  if (SMOKE) runSmoke().catch((e) => { console.error('[smoke] crashed:', e); app.exit(3); });
});

app.on('window-all-closed', () => app.quit());

app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (e, url) => { if (!url.startsWith('file:')) e.preventDefault(); });
});

// ---- IPC hardening ---------------------------------------------------------
// Only OUR packaged renderer page may invoke privileged handlers (safety
// handoff §10): exact file: URL match on the sender frame, no substring games.
const RENDERER_URL = require('url').pathToFileURL(path.join(__dirname, 'renderer', 'index.html')).href;
function validSender(event) {
  try {
    const u = event.senderFrame && event.senderFrame.url;
    return typeof u === 'string' && u.split('?')[0].split('#')[0] === RENDERER_URL;
  } catch (e) {
    return false;
  }
}

const err = (message) => ({ error: String(message) });

// Every privileged handler flows through guard(): sender check, then the
// terms gate (main-process enforced, §9A.10), then the handler.
function guard(channel, needsTerms, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!validSender(event)) return err('Request refused: untrusted sender.');
    if (needsTerms && !terms.isAccepted(userDataDir())) return err('Please accept the terms first.');
    try {
      return await fn(event, ...args);
    } catch (e) {
      if (e && e.userFacing) return err(e.message);
      console.error(`[${channel}] error:`, e && e.message);
      return err('Something went wrong. Please try again.');
    }
  });
}

// ---- Terms gate ------------------------------------------------------------
guard('terms-state', false, async () => ({ accepted: terms.isAccepted(userDataDir()), version: terms.TERMS_VERSION }));
guard('terms-accept', false, async () => { terms.accept(userDataDir()); return { accepted: true }; });
guard('terms-decline', false, async () => { setTimeout(() => app.quit(), 50); return { quitting: true }; });

// ---- Redaction -------------------------------------------------------------
// payload: { text }  OR  { files: [{ name, kind: 'pdf'|'image'|'text', base64?, text? }] }
// NEVER truncates: any over-limit input rejects the whole request with the
// limit named (safety handoff §5). Returns { redacted_text, ocr_used, spans,
// layouts } or { error }.
guard('redact', true, async (_e, payload) => {
  const body = payload && typeof payload === 'object' ? payload : {};
  if (typeof body.text === 'string' && body.text.trim()) {
    const t = body.text.trim();
    if (t.length > LIMITS.MAX_CHARS) {
      return err(`That text is ${t.length.toLocaleString()} characters; the limit is ${LIMITS.MAX_CHARS.toLocaleString()}. Paste the letter in parts.`);
    }
    const { spans, redacted } = findRedactedSpans(t);
    return { redacted_text: redacted, ocr_used: false, spans, layouts: [] };
  }
  const files = Array.isArray(body.files) ? body.files : [];
  if (!files.length) return err('No input provided.');
  if (files.length > LIMITS.MAX_FILES) return err(`Up to ${LIMITS.MAX_FILES} files at a time.`);

  let batchBytes = 0;
  for (const f of files) {
    if (!f || typeof f !== 'object') return err('Invalid file entry.');
    if (f.kind === 'text') {
      if (typeof f.text !== 'string') return err('Invalid text entry.');
      batchBytes += f.text.length;
    } else if (f.kind === 'pdf' || f.kind === 'image') {
      if (typeof f.base64 !== 'string') return err('Invalid file data.');
      const bytes = Math.floor(f.base64.length * 3 / 4);
      if (bytes > LIMITS.MAX_FILE_BYTES) return err(`"${f.name || 'file'}" is larger than the ${Math.round(LIMITS.MAX_FILE_BYTES / 1048576)} MB per-file limit.`);
      batchBytes += bytes;
      const head = Buffer.from(f.base64.slice(0, 12), 'base64');
      const sniffed = sniffKind(head);
      if (sniffed !== (f.kind === 'pdf' ? 'pdf' : 'image')) {
        return err(`"${f.name || 'file'}" does not look like a real ${f.kind === 'pdf' ? 'PDF' : 'image'} inside. Rename tricks are refused.`);
      }
    } else {
      return err(`Unsupported input type for "${f.name || 'file'}". PDF, PNG, and JPG are supported.`);
    }
  }
  if (batchBytes > LIMITS.MAX_BATCH_BYTES) return err(`That batch is over the ${Math.round(LIMITS.MAX_BATCH_BYTES / 1048576)} MB total limit. Process fewer files at once.`);

  let ocrUsed = false;
  const parts = [];
  const layouts = []; // per-file, index-aligned; null for text-lane files
  for (const f of files) {
    if (f.kind === 'text') {
      parts.push(String(f.text).trim());
      layouts.push(null);
    } else if (f.kind === 'pdf') {
      ocrUsed = true;
      const out = await ocrPdf(f.base64, f.name || 'document.pdf', true);
      parts.push(out.text);
      layouts.push(out.layout || null);
    } else {
      ocrUsed = true;
      const out = await ocrImage(f.base64, f.name || 'image', true);
      parts.push(out.text);
      layouts.push(out.layout || null);
    }
  }
  const original = parts.join('\n\n').trim();
  // Measure the COMPLETE source BEFORE redaction; reject, never slice.
  if (original.length > LIMITS.MAX_CHARS) {
    return err(`These files hold ${original.length.toLocaleString()} characters of text; the limit is ${LIMITS.MAX_CHARS.toLocaleString()}. Process fewer files or split the document.`);
  }
  const { spans, redacted } = findRedactedSpans(original);
  if (redacted.length < 20) {
    return err("We couldn't read enough text. Try a clearer copy, or paste the text instead.");
  }
  return { redacted_text: redacted, ocr_used: ocrUsed, spans, layouts };
});

// ---- File open -------------------------------------------------------------
guard('open-files', true, async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'Choose VA letter file(s)',
    properties: ['openFile', 'multiSelections'],
    // No "All files" option (safety handoff §9): supported formats only.
    filters: [{ name: 'Letters (PDF, PNG, JPG)', extensions: ['pdf', 'png', 'jpg', 'jpeg'] }],
  });
  if (canceled) return [];
  if (filePaths.length > LIMITS.MAX_FILES) {
    return err(`You picked ${filePaths.length} files; the limit is ${LIMITS.MAX_FILES}. Pick again.`);
  }
  const out = [];
  let batchBytes = 0;
  for (const p of filePaths) {
    const st = await fsp.stat(p);
    if (st.size > LIMITS.MAX_FILE_BYTES) {
      return err(`"${path.basename(p)}" is ${(st.size / 1048576).toFixed(1)} MB; the per-file limit is ${Math.round(LIMITS.MAX_FILE_BYTES / 1048576)} MB.`);
    }
    batchBytes += st.size;
    if (batchBytes > LIMITS.MAX_BATCH_BYTES) {
      return err(`Those files together are over the ${Math.round(LIMITS.MAX_BATCH_BYTES / 1048576)} MB batch limit.`);
    }
    const buf = await fsp.readFile(p);
    const kind = sniffKind(buf);
    if (!kind) return err(`"${path.basename(p)}" is not a PDF, PNG, or JPG inside.`);
    out.push({ name: path.basename(p), ext: path.extname(p).toLowerCase(), base64: buf.toString('base64') });
  }
  return out;
});

// ---- Saves -----------------------------------------------------------------
async function saveWithDialog(opts, writeFn) {
  try {
    const { canceled, filePath } = await dialog.showSaveDialog(opts);
    if (canceled || !filePath) return { saved: false };
    await writeFn(filePath);
    return { saved: true, path: filePath };
  } catch (e) {
    console.error('[save] failed:', e && e.message);
    return { saved: false, error: 'Could not save the file. Check disk space and permissions, then try again.' };
  }
}

guard('save-text', true, async (_e, text) => {
  if (typeof text !== 'string') return { saved: false, error: 'Nothing to save.' };
  return saveWithDialog(
    { title: 'Save redacted copy', defaultPath: 'redacted-letter.txt', filters: [{ name: 'Text file', extensions: ['txt'] }] },
    (fp) => fsp.writeFile(fp, text, 'utf8')
  );
});

guard('save-pdf', true, async (_e, text) => {
  if (typeof text !== 'string') return { saved: false, error: 'Nothing to save.' };
  return saveWithDialog(
    { title: 'Save redacted copy as PDF', defaultPath: 'redacted-letter.pdf', filters: [{ name: 'PDF file', extensions: ['pdf'] }] },
    async (fp) => fsp.writeFile(fp, Buffer.from(await buildRedactedPdf(text)))
  );
});

guard('save-layout-pdf', true, async (_e, pages) => {
  if (!Array.isArray(pages) || !pages.length) return { saved: false, error: 'Nothing to export.' };
  if (pages.length > LIMITS.MAX_LAYOUT_PAGES) return { saved: false, error: `Export is over the ${LIMITS.MAX_LAYOUT_PAGES}-page limit.` };
  let total = 0;
  for (const p of pages) {
    if (!p || typeof p.imgBase64 !== 'string' || !Array.isArray(p.rects)) return { saved: false, error: 'Invalid export data.' };
    total += Math.floor(p.imgBase64.length * 3 / 4);
  }
  if (total > LIMITS.MAX_LAYOUT_TOTAL_BYTES) return { saved: false, error: 'Export is too large. Process fewer pages at once.' };
  return saveWithDialog(
    { title: 'Save redacted PDF (original layout)', defaultPath: 'redacted-letter.pdf', filters: [{ name: 'PDF file', extensions: ['pdf'] }] },
    async (fp) => fsp.writeFile(fp, Buffer.from(await buildLayoutPdf(pages)))
  );
});

guard('reveal', true, async (_e, p) => {
  if (typeof p !== 'string' || !path.isAbsolute(p)) return err('Invalid path.');
  shell.showItemInFolder(p);
  return { ok: true };
});

// ---- Packaged/runtime smoke harness (safety handoff §10 runtime proof) -----
// OPE_SMOKE=1 boots the app, gathers runtime facts through the real window,
// writes them to OPE_SMOKE_OUT as JSON, and exits. The test suite spawns
// this and asserts on the file, so sandbox and gate claims are runtime-proven
// rather than grepped.
async function runSmoke() {
  const outPath = process.env.OPE_SMOKE_OUT || path.join(app.getPath('temp'), 'ope-smoke.json');
  const win = BrowserWindow.getAllWindows()[0];
  await new Promise((r) => win.webContents.once('did-finish-load', r));
  const facts = {};
  facts.rendererSandboxed = await win.webContents.executeJavaScript('window.api && window.api.smokeInfo ? window.api.smokeInfo().sandboxed : null');
  facts.termsAcceptedFresh = terms.isAccepted(userDataDir());
  // Privileged call BEFORE acceptance must be refused by the MAIN process.
  facts.redactBeforeTerms = await win.webContents.executeJavaScript("window.api.redact({ text: 'SSN 123-45-6789 probe' })");
  terms.accept(userDataDir());
  facts.redactAfterTerms = await win.webContents.executeJavaScript("window.api.redact({ text: 'SSN 123-45-6789 probe text that is long enough to pass the floor' })");
  fs.writeFileSync(outPath, JSON.stringify(facts, null, 1));
  app.exit(0);
}
