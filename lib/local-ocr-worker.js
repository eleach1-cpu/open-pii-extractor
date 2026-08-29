/**
 * Local OCR worker, the REAL Tesseract/PDF implementation. Runs as a
 * short-lived CHILD PROCESS spawned per job by local-ocr.js.
 *
 * Why a child process: tesseract.js (WASM) and pdf-to-img (native canvas)
 * allocate hundreds of MB per run that Node/glibc do NOT return to the OS
 * even after worker.terminate(). Measured in prod: RSS climbed ~300-400 MB
 * per Letter Interpreter use and never came back without a restart, which
 * drove GC pressure and intermittent site-wide slowness. Running OCR in a
 * child that EXITS after each job lets the OS reclaim 100% of that memory,
 * guaranteed, so nothing accumulates in the long-lived server process.
 *
 * CLI protocol (used by local-ocr.js):
 *   stdin : JSON { kind: 'image'|'pdf', base64, filename }
 *   stdout: one line `__OCR_RESULT__ <json>` where json is
 *           { ok:true, text } or { ok:false, message, userFacing, statusCode }
 *           (sentinel-prefixed so stray library stdout can't corrupt it)
 *   exit  : 0 for both handled outcomes; non-zero only on an unexpected crash.
 *
 * Also exports the functions for direct use/testing.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// DESKTOP-APP CHANGE (the only edit vs the RateMyVSO_Platform source, see
// SYNC.md): traineddata comes from the BUNDLED tessdata directory. main.js
// sets TESSERACT_CACHE_DIR before any lib require, and the spawned worker
// inherits it; the fallback covers plain-node test runs.
const CACHE_DIR = process.env.TESSERACT_CACHE_DIR
  || path.join(__dirname, '..', 'assets', 'tessdata');

try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch (_) { /* best effort */ }

// Quality guardrail. Below these, treat the read as failed.
const MIN_CONFIDENCE = 55;
const MIN_TEXT_CHARS = 25;
const MAX_PDF_PAGES = 10;       // time/memory cap for big rating packets
const RASTER_SCALE = 2;         // 2x render = sharper glyphs for Tesseract

function userErr(message, statusCode = 400, code = null) {
  const e = new Error(message);
  e.userFacing = true;
  e.statusCode = statusCode;
  // Machine-readable failure kind, plumbed through the child protocol so the
  // server can count OCR quality-gate rejections separately from every other
  // extraction failure (2026-08-05, sizes THE LIST's OCR-preprocessing item).
  if (code) e.code = code;
  return e;
}

// Create a fresh worker per call. Reused across a multi-page PDF within the
// same call, then terminated. traineddata is cached on disk so repeat calls
// do not re-download.
async function withWorker(fn) {
  const { createWorker } = require('tesseract.js');
  const worker = await createWorker('eng', 1, {
    cachePath: CACHE_DIR,
    // DESKTOP-APP CHANGE (see SYNC.md): langPath points at the BUNDLED
    // tessdata directory, so even a cache miss loads the local
    // eng.traineddata.gz and the app never downloads language data.
    langPath: CACHE_DIR,
    gzip: true,
    // Quieter logs in prod; tesseract.js is chatty by default.
    logger: () => {},
  });
  try {
    return await fn(worker);
  } finally {
    try { await worker.terminate(); } catch (_) { /* ignore */ }
  }
}

// Strip the obvious Tesseract noise lines (the VA seal/emblem reads as a few
// lines of gibberish). Drops short lines that are mostly non-alphanumeric.
function denoise(text) {
  return String(text || '')
    .split('\n')
    .filter(line => {
      const t = line.trim();
      if (!t) return true; // keep blank lines (paragraph structure)
      const alnum = (t.match(/[A-Za-z0-9]/g) || []).length;
      if (t.length <= 4 && alnum < 2) return false;       // "&", "$F", etc.
      if (t.length <= 12 && alnum / t.length < 0.45) return false; // mostly symbols
      return true;
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// OCR a single raster image (PNG/JPG buffer).
// DESKTOP-APP CHANGE (see SYNC.md): also surfaces Tesseract word bounding
// boxes so the original-layout export can black out matched words.
async function ocrImageBuffer(worker, buf) {
  const { data } = await worker.recognize(buf);
  const words = (data.words || []).map((w) => ({
    text: w.text || '',
    x: w.bbox ? w.bbox.x0 : 0,
    y: w.bbox ? w.bbox.y0 : 0,
    w: w.bbox ? (w.bbox.x1 - w.bbox.x0) : 0,
    h: w.bbox ? (w.bbox.y1 - w.bbox.y0) : 0,
  }));
  return { text: data.text || '', confidence: data.confidence || 0, words };
}

/**
 * OCR an image file. mediaType e.g. image/jpeg. Returns plain text.
 * Throws a userFacing error when the read is too poor to use.
 */
async function ocrImage(base64, filename = 'image', withLayout = false) {
  const buf = Buffer.from(base64, 'base64');
  return withWorker(async (worker) => {
    const { text, confidence, words } = await ocrImageBuffer(worker, buf);
    const cleaned = denoise(text);
    if (cleaned.length < MIN_TEXT_CHARS || confidence < MIN_CONFIDENCE) {
      throw userErr("We couldn't read that photo clearly. Try a sharper, well-lit photo, or paste the text instead.", 400, 'low_confidence');
    }
    if (!withLayout) return cleaned;
    // The original image IS the page raster; its natural pixel space is the
    // words' bbox space (scale 1).
    return { text: cleaned, layout: { scale: 1, pages: [{ imgBase64: base64, words }] } };
  });
}

/**
 * OCR a scanned/image PDF by rasterizing each page then running Tesseract.
 * Returns plain text across pages. Throws userFacing when nothing readable.
 */
// Blank-page PROOF (safety handoff §8): a page is blank only when its raster
// carries essentially no ink. Low OCR text alone never proves blank.
function isBlankRaster(pngBuffer) {
  const { PNG } = require('pngjs');
  let img;
  try { img = PNG.sync.read(Buffer.from(pngBuffer)); } catch (e) { return false; }
  let dark = 0;
  const total = img.width * img.height;
  const step = Math.max(1, Math.floor(total / 400000)); // sample big pages
  for (let p = 0; p < total; p += step) {
    const o = p * 4;
    const lum = 0.3 * img.data[o] + 0.6 * img.data[o + 1] + 0.1 * img.data[o + 2];
    if (lum < 160) dark++;
  }
  return dark / Math.ceil(total / step) < 0.001; // <0.1% dark pixels = blank
}

async function ocrPdf(base64, filename = 'document', withLayout = false) {
  const { pdf } = await import('pdf-to-img');
  const buf = Buffer.from(base64, 'base64');
  const doc = await pdf(buf, { scale: RASTER_SCALE });
  // PAGE CAP IS FAIL-CLOSED (safety handoff §6): a scanned PDF past the cap
  // is rejected as a whole, never silently shortened to its first ten pages.
  if (doc.length > MAX_PDF_PAGES) {
    throw userErr(`That scanned PDF has ${doc.length} pages; this app reads scanned PDFs up to ${MAX_PDF_PAGES} pages. Split the file, or open the pages you need.`, 400, 'page_limit');
  }

  return withWorker(async (worker) => {
    const parts = [];
    const pages = [];
    const failedPages = [];
    let pageNum = 0;
    for await (const pageImage of doc) {
      pageNum++;
      if (pageNum > MAX_PDF_PAGES) { // defense in depth if doc.length lied
        throw userErr(`That scanned PDF is over the ${MAX_PDF_PAGES}-page limit for scanned files.`, 400, 'page_limit');
      }
      const { text, confidence, words } = await ocrImageBuffer(worker, pageImage);
      const cleaned = denoise(text);
      // EVERY nonblank page must individually pass the quality floor
      // (safety handoff §8): one excellent page can no longer conceal an
      // unreadable one. Blankness is proven from the raster, not assumed.
      if (cleaned.length < MIN_TEXT_CHARS || confidence < MIN_CONFIDENCE) {
        if (!isBlankRaster(pageImage)) failedPages.push(pageNum);
      }
      if (cleaned) parts.push(cleaned);
      if (withLayout) pages.push({ imgBase64: Buffer.from(pageImage).toString('base64'), words });
    }
    if (failedPages.length) {
      throw userErr(`We couldn't read page${failedPages.length > 1 ? 's' : ''} ${failedPages.join(', ')} of that PDF clearly. Try a sharper scan of ${failedPages.length > 1 ? 'those pages' : 'that page'}, or paste the text instead.`, 400, 'low_confidence');
    }
    const combined = parts.join('\n\n').trim();
    if (combined.length < MIN_TEXT_CHARS) {
      throw userErr("We couldn't read enough text from that PDF. Try a clearer scan, or paste the key section instead.", 400, 'low_confidence');
    }
    if (!withLayout) return combined;
    // Word bboxes are in the RASTER_SCALE pixel space of these page PNGs.
    return { text: combined, layout: { scale: RASTER_SCALE, pages } };
  });
}

const RESULT_SENTINEL = '__OCR_RESULT__';

// Emit the single result line exactly once, then exit so the OS reclaims all
// WASM/native memory. Guarded so a late async error can't double-emit.
let _emitted = false;
function emit(obj) {
  if (_emitted) return;
  _emitted = true;
  try { process.stdout.write(RESULT_SENTINEL + ' ' + JSON.stringify(obj) + '\n'); } catch (_) {}
  process.exit(0);
}

// CLI entry: read one job from stdin, OCR it, emit a sentinel-prefixed JSON
// result on stdout, then exit.
async function runCli() {
  // tesseract.js surfaces a corrupt-image failure as an async 'error' event
  // that becomes an uncaughtException/unhandledRejection here. Convert those
  // into a clean userFacing result instead of a stack-trace crash, so the
  // parent gets a tidy answer and prod logs stay quiet.
  process.on('uncaughtException', () => emit({ ok: false, message: "We couldn't read that file. Please paste the text instead.", userFacing: true, statusCode: 400 }));
  process.on('unhandledRejection', () => emit({ ok: false, message: "We couldn't read that file. Please paste the text instead.", userFacing: true, statusCode: 400 }));

  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  let job;
  try {
    job = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (e) {
    return emit({ ok: false, message: 'Bad OCR job input.', userFacing: false, statusCode: 500 });
  }
  try {
    const out = job.kind === 'pdf'
      ? await ocrPdf(job.base64, job.filename || 'document.pdf', !!job.withLayout)
      : await ocrImage(job.base64, job.filename || 'image', !!job.withLayout);
    if (out && typeof out === 'object') emit({ ok: true, text: out.text, layout: out.layout });
    else emit({ ok: true, text: out });
  } catch (err) {
    emit({
      ok: false,
      message: err && err.message ? err.message : 'OCR failed.',
      userFacing: !!(err && err.userFacing),
      statusCode: (err && err.statusCode) || 500,
      code: (err && err.code) || null,
    });
  }
}

if (require.main === module) {
  runCli();
}

module.exports = { ocrImage, ocrPdf, isBlankRaster, CACHE_DIR, MIN_CONFIDENCE, MAX_PDF_PAGES, RESULT_SENTINEL };
