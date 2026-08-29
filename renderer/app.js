// File staging + routing + original-layout export.
// Staging mirrors the website's flow: digital PDFs get pdf.js text extraction
// right here (fast, no OCR); image-only scans and photos go to the main
// process OCR worker. The 80-chars-per-page floor separating the two regimes
// is the site's measured threshold, unchanged.
// The original-layout export blacks out every auto-redacted span plus every
// word the veteran tapped, on rasterized pages, assembled image-only in the
// main process (lib/build-layout-pdf.js) so no text can survive a box.
'use strict';

import * as pdfjsLib from './pdfjs/pdf.min.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = './pdfjs/pdf.worker.min.mjs';

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg']);
const RASTER_SCALE = 2;
// Renderer-side copies of the limits for early, friendly rejection. The main
// process re-validates everything; these are convenience, not the boundary.
const R_LIMITS = { MAX_FILES: 5, MAX_FILE_BYTES: 30 * 1024 * 1024, MAX_BATCH_BYTES: 80 * 1024 * 1024, MAX_DIGITAL_PDF_PAGES: 60, MAX_IMAGE_PIXELS: 40 * 1000 * 1000 };

// What the last staging produced. app.js owns the buffers; safe-preview.js
// owns the redaction metadata (window.__redactMeta = { spans, layouts }).
let stagedFiles = [];

async function extractTextFromPdf(arrayBuffer) {
  try {
    const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer, disableFontFace: true, verbosity: 0 });
    const pdf = await loadingTask.promise;
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      pages.push(content.items.map((it) => (it && it.str) ? it.str : '').join(' '));
    }
    const fullText = pages.join('\n\n').trim();
    const avgPerPage = fullText.length / Math.max(1, pdf.numPages);
    return { text: fullText, isImageOnly: avgPerPage < 80 };
  } catch (err) {
    return { text: '', isImageOnly: true };
  }
}

function b64FromBuffer(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

// Stale-state clearing (safety handoff §5/§9): every rejection wipes the
// staged buffers AND the redaction metadata so an old result can never be
// exported after a failed newer attempt. safe-preview calls this from its
// error path too.
window.clearStagedState = function clearStagedState() {
  stagedFiles = [];
  window.__redactMeta = null;
};

function stageError(msg) {
  window.clearStagedState();
  window.LetterSafePreview.showError(msg);
}

// Per-page classification of a digital PDF (safety handoff §7): a page with
// real digital text is 'digital'; a page below the text floor is proven
// BLANK from its raster ink or it makes the whole file OCR-routed (minimum
// safe implementation: one scanned page routes the entire file to OCR, so
// no page can silently skip processing).
async function classifyPdf(arrayBuffer) {
  const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer, disableFontFace: true, verbosity: 0 });
  const pdf = await loadingTask.promise;
  if (pdf.numPages > R_LIMITS.MAX_DIGITAL_PDF_PAGES) {
    throw new Error(`This PDF has ${pdf.numPages} pages; the limit is ${R_LIMITS.MAX_DIGITAL_PDF_PAGES}.`);
  }
  const pages = [];
  const pageTexts = [];
  let hasScanned = false;
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const text = content.items.map((it) => (it && it.str) ? it.str : '').join(' ');
    pageTexts.push(text);
    if (text.trim().length >= 80) {
      pages.push({ pageNumber: i, route: 'digital', chars: text.length });
    } else {
      // Blank proof: render small and count ink. Low text alone is never
      // proof of blank (safety handoff §8).
      const viewport = page.getViewport({ scale: 0.4 });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      const img = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
      let dark = 0;
      for (let p = 0; p < img.data.length; p += 4) {
        const lum = 0.3 * img.data[p] + 0.6 * img.data[p + 1] + 0.1 * img.data[p + 2];
        if (lum < 160) dark++;
      }
      const blank = dark / (img.data.length / 4) < 0.001;
      if (blank) pages.push({ pageNumber: i, route: 'blank', chars: text.length });
      else { hasScanned = true; pages.push({ pageNumber: i, route: 'scanned', chars: text.length }); }
    }
  }
  return { pages, hasScanned, fullText: pageTexts.join('\n\n').trim(), pageCount: pdf.numPages };
}

// files: [{ name, ext, base64 }] (open dialog) or [{ name, ext, arrayBuffer }]
// (drag-drop). Route each to text or OCR; remember everything for export.
// Any invalid or over-limit file rejects the WHOLE batch with a visible,
// named reason (owner default 1); unsupported types are never ignored.
async function stageAndPreview(files) {
  window.clearStagedState();
  if (files.length > R_LIMITS.MAX_FILES) {
    return stageError(`You dropped ${files.length} files; the limit is ${R_LIMITS.MAX_FILES} at a time.`);
  }
  const payload = [];
  let batchBytes = 0;
  try {
    for (const f of files) {
      const ext = (f.ext || '').toLowerCase();
      const size = f.arrayBuffer ? f.arrayBuffer.byteLength : Math.floor((f.base64 || '').length * 3 / 4);
      if (size > R_LIMITS.MAX_FILE_BYTES) {
        return stageError(`"${f.name}" is ${(size / 1048576).toFixed(1)} MB; the per-file limit is ${Math.round(R_LIMITS.MAX_FILE_BYTES / 1048576)} MB.`);
      }
      batchBytes += size;
      if (batchBytes > R_LIMITS.MAX_BATCH_BYTES) {
        return stageError(`Those files together pass the ${Math.round(R_LIMITS.MAX_BATCH_BYTES / 1048576)} MB batch limit.`);
      }
      if (ext === '.pdf') {
        const buf = f.arrayBuffer || Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0)).buffer;
        // pdf.js consumes (detaches) the buffer it is given, so keep OUR
        // copy and hand pdf.js a throwaway clone.
        const classified = await classifyPdf(buf.slice(0));
        if (!classified.hasScanned && classified.fullText.trim()) {
          stagedFiles.push({ name: f.name, kind: 'digital-pdf', buffer: buf, pages: classified.pages });
          payload.push({ name: f.name, kind: 'text', text: classified.fullText });
        } else {
          // At least one non-blank page has no digital text: the ENTIRE
          // file goes through OCR so no page is skipped.
          stagedFiles.push({ name: f.name, kind: 'ocr-pdf', pages: classified.pages });
          payload.push({ name: f.name, kind: 'pdf', base64: f.base64 || b64FromBuffer(buf) });
        }
      } else if (IMAGE_EXT.has(ext)) {
        const b64 = f.base64 || b64FromBuffer(f.arrayBuffer);
        const dims = await imageDims(b64).catch(() => null);
        if (dims && dims.w * dims.h > R_LIMITS.MAX_IMAGE_PIXELS) {
          return stageError(`"${f.name}" is ${Math.round(dims.w * dims.h / 1e6)} megapixels; the limit is ${Math.round(R_LIMITS.MAX_IMAGE_PIXELS / 1e6)} MP.`);
        }
        stagedFiles.push({ name: f.name, kind: 'image' });
        payload.push({ name: f.name, kind: 'image', base64: b64 });
      } else {
        return stageError(`"${f.name}" is not a supported type. PDF, PNG, and JPG are supported.`);
      }
    }
  } catch (e) {
    return stageError(e.message || 'Could not read that file.');
  }
  if (!payload.length) return stageError('No supported files found.');
  window.LetterSafePreview.previewFiles(payload);
}

function imageDims(base64) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve({ w: im.naturalWidth, h: im.naturalHeight });
    im.onerror = () => reject(new Error('undecodable image'));
    im.src = 'data:image/png;base64,' + base64;
  });
}

// ---- Original-layout export ------------------------------------------------

// Split a pdf.js text item into word-level boxes. Sub-item x/width comes from
// character-count proportion, so each word box gets 12% width padding per
// side to stay conservative with proportional fonts.
function itemWords(item, viewport) {
  const out = [];
  const str = item.str || '';
  if (!str.trim()) return out;
  const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
  const fontH = Math.hypot(tx[2], tx[3]) || 10;
  const baseX = tx[4];
  const topY = tx[5] - fontH;
  const itemW = (item.width || 0) * viewport.scale;
  const re = /\S+/g;
  let m;
  while ((m = re.exec(str)) !== null) {
    const startFrac = m.index / str.length;
    const endFrac = (m.index + m[0].length) / str.length;
    const w = (endFrac - startFrac) * itemW;
    out.push({
      text: m[0],
      x: baseX + startFrac * itemW - w * 0.12,
      y: topY - fontH * 0.15,
      w: w * 1.24,
      h: fontH * 1.4,
    });
  }
  return out;
}

// Words too common to ever black out on their own. A single-token span like
// "of" (a diff fail-safe artifact) boxed EVERY "of" on a real letter,
// including "Explanation of Payment" in the sidebar (found 2026-08-29).
// Multi-token spans are positional (consecutive words) and skip this filter;
// a word the veteran TAPPED is honored verbatim, whatever it is.
const COMMON_WORDS = new Set(['of', 'the', 'and', 'for', 'you', 'your', 'was', 'has', 'have', 'been', 'with', 'this', 'that', 'from', 'are', 'not', 'a', 'an', 'in', 'on', 'to', 'is', 'we', 'or', 'by', 'va', 'be', 'as', 'at', 'it']);

// Public web addresses are never PII, but a diff span that swallows the
// contact sidebar carries them, and their long tokens then contains-match
// EVERY va.gov link on the letter (v2 export blacked four public URLs on one
// page). Tokens for known public destinations are dropped from AUTO spans;
// a tapped word is still honored verbatim.
const PUBLIC_TOKEN_RE = /vagov|facebook|twitter|instagram|youtube|httpswww|wwwva/;

function tokenLists(spans, tappedWords) {
  const norm = window.LayoutBoxes.normalizeToken;
  const lists = [];
  const spanTokenSets = [];
  for (const s of spans || []) {
    const l = String(s).split(/\s+/).map(norm).filter(Boolean).filter((t) => !PUBLIC_TOKEN_RE.test(t));
    if (!l.length) continue;
    spanTokenSets.push(new Set(l));
    if (l.length > 1) { lists.push(l); continue; }
    if (l[0].length >= 4 && !COMMON_WORDS.has(l[0])) lists.push(l);
  }
  // A name rides through the letter in DIFFERENT word orders ("ERIC J LEACH"
  // in the address block, "LEACH, ERIC J" in footers), so positional windows
  // alone miss the page-header order (real letter, 2026-08-29). Any alphabetic
  // token redacted in two or more distinct spans is promoted to a global
  // single so every occurrence is boxed regardless of order.
  const seenIn = new Map();
  for (const set of spanTokenSets) {
    for (const t of set) seenIn.set(t, (seenIn.get(t) || 0) + 1);
  }
  for (const [t, n] of seenIn) {
    if (n >= 2 && t.length >= 4 && !/\d/.test(t) && !COMMON_WORDS.has(t)) lists.push([t]);
  }
  for (const w of tappedWords || []) {
    const t = norm(w);
    if (t) lists.push([t]);
  }
  return lists;
}

// QR codes carry identifiers no text rule can read; every decoded code on a
// page gets boxed too (lib/qr-boxes.js, owner decision 2026-08-29).
function qrRectsFromCanvas(canvas) {
  const ctx = canvas.getContext('2d');
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return window.QrBoxes.qrRects(img.data, canvas.width, canvas.height);
}

function imageToCanvas(base64) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = im.naturalWidth;
      canvas.height = im.naturalHeight;
      canvas.getContext('2d').drawImage(im, 0, 0);
      resolve(canvas);
    };
    im.onerror = () => reject(new Error('could not decode page image'));
    im.src = 'data:image/png;base64,' + base64;
  });
}

// Build the export pages for every staged file and hand them to the main
// process. Returns { saved } or { error }.
window.exportLayoutPdf = async function exportLayoutPdf(tappedWords) {
  const meta = window.__redactMeta || {};
  const lists = tokenLists(meta.spans, tappedWords);
  const pages = [];
  for (let idx = 0; idx < stagedFiles.length; idx++) {
    const f = stagedFiles[idx];
    if (f.kind === 'digital-pdf') {
      // disableFontFace must stay OFF for the RENDER pass: with it on,
      // pdf.js silently paints nothing for VA letters' embedded subset
      // fonts and whole paragraphs vanish from the raster (found on a real
      // decision letter 2026-08-29). Extraction-only opens keep it on.
      const pdf = await pdfjsLib.getDocument({ data: f.buffer.slice(0), disableFontFace: false, verbosity: 0 }).promise;
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const viewport = page.getViewport({ scale: RASTER_SCALE });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
        const content = await page.getTextContent();
        const words = [];
        for (const item of content.items) words.push(...itemWords(item, viewport));
        const rects = window.LayoutBoxes.boxesForWords(words, lists).concat(qrRectsFromCanvas(canvas));
        pages.push({ imgBase64: canvas.toDataURL('image/png').split(',')[1], scale: RASTER_SCALE, rects });
      }
    } else {
      const layout = (meta.layouts || [])[idx];
      if (!layout) continue;
      for (const p of layout.pages) {
        let qr = [];
        try { qr = qrRectsFromCanvas(await imageToCanvas(p.imgBase64)); } catch (e) { /* undecodable page image: text boxes still apply */ }
        pages.push({
          imgBase64: p.imgBase64,
          scale: layout.scale || 1,
          rects: window.LayoutBoxes.boxesForWords(p.words || [], lists).concat(qr),
        });
      }
    }
  }
  if (!pages.length) return { error: 'Original-layout export needs an opened PDF or photo. Pasted text has no layout; use the other save buttons.' };
  return window.api.saveLayoutPdf(pages);
};

// ---- First-launch terms gate (safety handoff §9A) --------------------------
// The gate is enforced in the MAIN process; this overlay is the honest UI
// for it. No Escape, no backdrop, no way around it in the renderer, and even
// a bypassed renderer gets refused by every privileged IPC handler.
async function initTermsGate() {
  const gate = document.getElementById('terms-gate');
  const box = document.getElementById('terms-checkbox');
  const accept = document.getElementById('terms-accept');
  const decline = document.getElementById('terms-decline');
  const why = document.getElementById('terms-why');
  const state = await window.api.termsState();
  if (state && state.accepted) { gate.hidden = true; return; }
  gate.hidden = false;
  document.getElementById('terms-title').focus();
  box.addEventListener('change', () => {
    accept.disabled = !box.checked;
    why.textContent = box.checked ? '' : 'Check the box above to enable Accept and continue.';
  });
  accept.addEventListener('click', async () => {
    if (!box.checked) return;
    const r = await window.api.termsAccept();
    if (r && r.accepted) gate.hidden = true;
  });
  decline.addEventListener('click', () => window.api.termsDecline());
  gate.addEventListener('keydown', (e) => { if (e.key === 'Escape') e.preventDefault(); });
}

document.addEventListener('DOMContentLoaded', () => {
  const drop = document.getElementById('drop-zone');
  const choose = document.getElementById('choose-files');
  const redactPaste = document.getElementById('redact-paste');
  const pasteBox = document.getElementById('paste-text');

  initTermsGate();

  choose.addEventListener('click', async () => {
    const files = await window.api.openFiles();
    if (files && files.error) return stageError(files.error);
    if (Array.isArray(files) && files.length) stageAndPreview(files);
  });

  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('dragging'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('dragging'));
  drop.addEventListener('drop', async (e) => {
    e.preventDefault();
    drop.classList.remove('dragging');
    // Count check BEFORE reading a single byte (safety handoff §9).
    if (e.dataTransfer.files.length > R_LIMITS.MAX_FILES) {
      return stageError(`You dropped ${e.dataTransfer.files.length} files; the limit is ${R_LIMITS.MAX_FILES} at a time.`);
    }
    const files = [];
    for (const file of e.dataTransfer.files) {
      const dot = file.name.lastIndexOf('.');
      files.push({
        name: file.name,
        ext: dot >= 0 ? file.name.slice(dot).toLowerCase() : '',
        arrayBuffer: await file.arrayBuffer(),
      });
    }
    if (files.length) stageAndPreview(files);
  });

  redactPaste.addEventListener('click', () => {
    window.clearStagedState();
    const t = (pasteBox.value || '').trim();
    if (t) window.LetterSafePreview.previewText(t);
  });
});
