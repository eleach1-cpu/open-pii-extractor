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

// files: [{ name, ext, base64 }] (open dialog) or [{ name, ext, arrayBuffer }]
// (drag-drop). Route each to text or OCR; remember everything for export.
async function stageAndPreview(files) {
  stagedFiles = [];
  const payload = [];
  for (const f of files.slice(0, 5)) {
    const ext = (f.ext || '').toLowerCase();
    if (ext === '.pdf') {
      const buf = f.arrayBuffer || Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0)).buffer;
      // pdf.js consumes (detaches) the buffer it is given, so keep OUR copy
      // and hand pdf.js a throwaway clone.
      const extracted = await extractTextFromPdf(buf.slice(0));
      if (!extracted.isImageOnly && extracted.text) {
        stagedFiles.push({ name: f.name, kind: 'digital-pdf', buffer: buf });
        payload.push({ name: f.name, kind: 'text', text: extracted.text });
      } else {
        stagedFiles.push({ name: f.name, kind: 'ocr-pdf' });
        payload.push({ name: f.name, kind: 'pdf', base64: f.base64 || b64FromBuffer(buf) });
      }
    } else if (IMAGE_EXT.has(ext)) {
      stagedFiles.push({ name: f.name, kind: 'image' });
      payload.push({ name: f.name, kind: 'image', base64: f.base64 || b64FromBuffer(f.arrayBuffer) });
    }
  }
  if (!payload.length) {
    window.LetterSafePreview.previewText('');
    return;
  }
  window.LetterSafePreview.previewFiles(payload);
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

function tokenLists(spans, tappedWords) {
  const norm = window.LayoutBoxes.normalizeToken;
  const lists = [];
  for (const s of spans || []) {
    const l = String(s).split(/\s+/).map(norm).filter(Boolean);
    if (l.length) lists.push(l);
  }
  for (const w of tappedWords || []) {
    const t = norm(w);
    if (t) lists.push([t]);
  }
  return lists;
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
      const pdf = await pdfjsLib.getDocument({ data: f.buffer.slice(0), disableFontFace: true, verbosity: 0 }).promise;
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
        const rects = window.LayoutBoxes.boxesForWords(words, lists);
        pages.push({ imgBase64: canvas.toDataURL('image/png').split(',')[1], scale: RASTER_SCALE, rects });
      }
    } else {
      const layout = (meta.layouts || [])[idx];
      if (!layout) continue;
      for (const p of layout.pages) {
        pages.push({
          imgBase64: p.imgBase64,
          scale: layout.scale || 1,
          rects: window.LayoutBoxes.boxesForWords(p.words || [], lists),
        });
      }
    }
  }
  if (!pages.length) return { error: 'Original-layout export needs an opened PDF or photo. Pasted text has no layout; use the other save buttons.' };
  return window.api.saveLayoutPdf(pages);
};

document.addEventListener('DOMContentLoaded', () => {
  const drop = document.getElementById('drop-zone');
  const choose = document.getElementById('choose-files');
  const redactPaste = document.getElementById('redact-paste');
  const pasteBox = document.getElementById('paste-text');

  choose.addEventListener('click', async () => {
    const files = await window.api.openFiles();
    if (files.length) stageAndPreview(files);
  });

  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('dragging'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('dragging'));
  drop.addEventListener('drop', async (e) => {
    e.preventDefault();
    drop.classList.remove('dragging');
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
    stagedFiles = [];
    const t = (pasteBox.value || '').trim();
    if (t) window.LetterSafePreview.previewText(t);
  });
});
