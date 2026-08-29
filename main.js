// Open PII Extractor, Electron main process.
//
// The offline promise is enforced HERE, mechanically, not in copy:
//   - every outbound web request from any renderer is cancelled,
//   - every permission request is denied,
//   - the OCR worker reads its language data from the bundled tessdata dir,
//     so no first-run download exists.
// The redaction engine (lib/) is copied verbatim from RateMyVSO_Platform;
// see SYNC.md for source commit hashes. Rule changes land there FIRST.

'use strict';

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, dialog, session, shell } = require('electron');

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

const MAX_CHARS = 120000; // same budget as the site's redaction gate

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
      sandbox: false,
    },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  return win;
}

app.whenReady().then(() => {
  // ---- Offline by construction -------------------------------------------
  // Cancel every request that is not a local file / devtools resource.
  session.defaultSession.webRequest.onBeforeRequest((details, cb) => {
    const ok = /^(file|devtools|chrome-extension|data|blob):/.test(details.url);
    cb({ cancel: !ok });
  });
  // Deny every permission (camera, mic, geolocation, notifications, ...).
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => cb(false));

  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => app.quit());

// Any link a renderer tries to open in a new window is refused (nothing in
// the UI links out, but belt and suspenders).
app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (e, url) => { if (!url.startsWith('file:')) e.preventDefault(); });
});

// ---- IPC: the one round-trip that replaced POST /redact-preview -----------
// payload: { text }  OR  { files: [{ name, kind: 'pdf'|'image'|'text', base64?, text? }] }
// Mirrors the site handler's flow: extract (OCR when needed), join, strip,
// enforce the 20-char floor and 120K budget. Returns { redacted_text, ocr_used }
// or { error }.
ipcMain.handle('redact', async (_e, payload) => {
  try {
    const body = payload || {};
    if (typeof body.text === 'string' && body.text.trim()) {
      const { spans, redacted } = findRedactedSpans(body.text.trim().slice(0, MAX_CHARS));
      return { redacted_text: redacted, ocr_used: false, spans, layouts: [] };
    }
    const files = Array.isArray(body.files) ? body.files : [];
    if (!files.length) return { error: 'No input provided.' };
    if (files.length > 5) return { error: 'Up to 5 files at a time.' };

    let ocrUsed = false;
    const parts = [];
    // Per-file OCR layouts (word bounding boxes + page rasters), aligned by
    // index with the renderer's staged file list; null for text-lane files.
    // The renderer uses them for the original-layout export.
    const layouts = [];
    for (const f of files) {
      if (f.kind === 'text' && f.text) {
        parts.push(String(f.text).trim());
        layouts.push(null);
      } else if (f.kind === 'pdf' && f.base64) {
        ocrUsed = true;
        const out = await ocrPdf(f.base64, f.name || 'document.pdf', true);
        parts.push(out.text);
        layouts.push(out.layout || null);
      } else if (f.kind === 'image' && f.base64) {
        ocrUsed = true;
        const out = await ocrImage(f.base64, f.name || 'image', true);
        parts.push(out.text);
        layouts.push(out.layout || null);
      } else {
        layouts.push(null);
      }
    }
    const original = parts.join('\n\n').trim();
    const { spans, redacted } = findRedactedSpans(original.slice(0, MAX_CHARS));
    if (redacted.length < 20) {
      return { error: "We couldn't read enough text. Try a clearer copy, or paste the text instead." };
    }
    if (redacted.length > MAX_CHARS) {
      return { error: 'That is too long. Open the decision letter alone, or paste the key section.' };
    }
    return { redacted_text: redacted, ocr_used: ocrUsed, spans, layouts };
  } catch (err) {
    if (err && err.userFacing) return { error: err.message };
    console.error('[redact] error:', err && err.message);
    return { error: 'Could not redact that file. Please try again or paste the text.' };
  }
});

// ---- IPC: file open + save ------------------------------------------------
ipcMain.handle('open-files', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'Choose VA letter file(s)',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Letters (PDF, photo)', extensions: ['pdf', 'png', 'jpg', 'jpeg'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (canceled) return [];
  return filePaths.slice(0, 5).map((p) => ({
    name: path.basename(p),
    ext: path.extname(p).toLowerCase(),
    base64: fs.readFileSync(p).toString('base64'),
  }));
});

ipcMain.handle('save-text', async (_e, text) => {
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: 'Save redacted copy',
    defaultPath: 'redacted-letter.txt',
    filters: [{ name: 'Text file', extensions: ['txt'] }],
  });
  if (canceled || !filePath) return { saved: false };
  fs.writeFileSync(filePath, String(text || ''), 'utf8');
  return { saved: true, path: filePath };
});

ipcMain.handle('reveal', async (_e, p) => { if (p) shell.showItemInFolder(p); });

// Original-layout redacted PDF (owner decision 2026-08-29): image-only pages
// with black boxes drawn by pdf-lib; no text layer exists in the output.
const { buildLayoutPdf } = require('./lib/build-layout-pdf');
ipcMain.handle('save-layout-pdf', async (_e, pages) => {
  if (!Array.isArray(pages) || !pages.length) return { saved: false, error: 'Nothing to export.' };
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: 'Save redacted PDF (original layout)',
    defaultPath: 'redacted-letter.pdf',
    filters: [{ name: 'PDF file', extensions: ['pdf'] }],
  });
  if (canceled || !filePath) return { saved: false };
  fs.writeFileSync(filePath, Buffer.from(await buildLayoutPdf(pages)));
  return { saved: true, path: filePath };
});

// Text-reconstruction PDF export; the builder lives in lib/ so the test
// suite exercises it without Electron.
const { buildRedactedPdf } = require('./lib/build-redacted-pdf');
ipcMain.handle('save-pdf', async (_e, text) => {
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: 'Save redacted copy as PDF',
    defaultPath: 'redacted-letter.pdf',
    filters: [{ name: 'PDF file', extensions: ['pdf'] }],
  });
  if (canceled || !filePath) return { saved: false };
  fs.writeFileSync(filePath, Buffer.from(await buildRedactedPdf(text)));
  return { saved: true, path: filePath };
});
