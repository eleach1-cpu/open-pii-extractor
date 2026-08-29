// File staging + routing. Mirrors the website's flow: digital PDFs get
// pdf.js text extraction right here (fast, no OCR); image-only scans and
// photos go to the main process OCR worker. The 80-chars-per-page floor
// separating the two regimes is the site's measured threshold, unchanged.
'use strict';

import * as pdfjsLib from './pdfjs/pdf.min.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = './pdfjs/pdf.worker.min.mjs';

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg']);

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

// files: [{ name, ext, base64 }] (from the main-process open dialog) or
// [{ name, ext, arrayBuffer }] (from drag-drop). Route each to text or OCR.
async function stageAndPreview(files) {
  const staged = [];
  for (const f of files.slice(0, 5)) {
    const ext = (f.ext || '').toLowerCase();
    if (ext === '.pdf') {
      const buf = f.arrayBuffer || Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0)).buffer;
      // pdf.js consumes (detaches) the buffer it is given, so keep OUR copy
      // for the OCR fallback and hand pdf.js a throwaway clone.
      const extracted = await extractTextFromPdf(buf.slice(0));
      if (!extracted.isImageOnly && extracted.text) {
        staged.push({ name: f.name, kind: 'text', text: extracted.text });
      } else {
        staged.push({ name: f.name, kind: 'pdf', base64: f.base64 || b64FromBuffer(buf) });
      }
    } else if (IMAGE_EXT.has(ext)) {
      staged.push({ name: f.name, kind: 'image', base64: f.base64 || b64FromBuffer(f.arrayBuffer) });
    }
  }
  if (!staged.length) {
    window.LetterSafePreview.previewText('');
    return;
  }
  window.LetterSafePreview.previewFiles(staged);
}

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
    const t = (pasteBox.value || '').trim();
    if (t) window.LetterSafePreview.previewText(t);
  });
});
