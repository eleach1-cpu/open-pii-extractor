// Safety-handoff pins (2026-08-29): fail-closed truncation, page caps,
// per-page OCR quality, blank-page proof, terms store, input sniffing,
// WinAnsi C1 crash immunity, and main.js source contracts.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// ---- terms store (§9A) -----------------------------------------------------
test('terms: fresh dir not accepted; accept persists; version change re-gates; tampered fails closed', () => {
  const terms = require('../lib/terms');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ope-terms-'));
  assert.strictEqual(terms.isAccepted(dir), false, 'fresh dir must not be accepted');
  terms.accept(dir);
  assert.strictEqual(terms.isAccepted(dir), true, 'accept must persist');
  const f = terms.fileFor(dir);
  const saved = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.deepStrictEqual(Object.keys(saved).sort(), ['acceptedAt', 'version'], 'only version + timestamp may be stored');
  // stale version
  fs.writeFileSync(f, JSON.stringify({ version: terms.TERMS_VERSION - 1, acceptedAt: new Date().toISOString() }));
  assert.strictEqual(terms.isAccepted(dir), false, 'older version must re-gate');
  // malformed
  fs.writeFileSync(f, '{not json');
  assert.strictEqual(terms.isAccepted(dir), false, 'malformed must fail closed');
  // future-dated
  fs.writeFileSync(f, JSON.stringify({ version: terms.TERMS_VERSION, acceptedAt: new Date(Date.now() + 864e5).toISOString() }));
  assert.strictEqual(terms.isAccepted(dir), false, 'future-dated must fail closed');
});

// ---- limits + sniffing (§9) ------------------------------------------------
test('sniffKind: real signatures pass, deceptive extension content fails', () => {
  const { sniffKind } = require('../lib/limits');
  assert.strictEqual(sniffKind(Buffer.from('%PDF-1.7 rest')), 'pdf');
  assert.strictEqual(sniffKind(Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2])), 'image');
  assert.strictEqual(sniffKind(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image');
  assert.strictEqual(sniffKind(Buffer.from('MZ executable pretending to be letter.pdf')), null);
});

// ---- no-truncation contract (§5) -------------------------------------------
test('main.js never slices input as a success path and has no dead over-limit check', () => {
  const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  assert.ok(!/slice\(0,\s*(LIMITS\.)?MAX_CHARS\)/.test(src), 'slice-to-cap success path is back');
  assert.ok(!/redacted\.length\s*>\s*(LIMITS\.)?MAX_CHARS/.test(src), 'dead post-slice check is back');
  assert.ok(/original\.length\s*>\s*LIMITS\.MAX_CHARS/.test(src), 'whole-source measurement missing');
  assert.ok(/t\.length\s*>\s*LIMITS\.MAX_CHARS/.test(src), 'pasted-text whole measurement missing');
});

test('main.js IPC hardening: sandbox on, sender validated, terms-gated, no All files filter', () => {
  const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  assert.ok(/app\.enableSandbox\(\)/.test(src), 'enableSandbox missing');
  assert.ok(/sandbox:\s*true/.test(src) && !/sandbox:\s*false/.test(src), 'window sandbox not true');
  assert.ok(/function validSender\(/.test(src), 'validSender helper missing');
  assert.ok(/if \(!validSender\(event\)\) return err/.test(src), 'sender check not enforced in guard');
  for (const ch of ['redact', 'open-files', 'save-text', 'save-pdf', 'save-layout-pdf', 'reveal']) {
    assert.ok(new RegExp(`guard\\('${ch}', true`).test(src), `${ch} not routed through the terms-gated guard`);
  }
  assert.ok(!/name:\s*'All files'/.test(src), 'All-files dialog filter is back');
});

// ---- WinAnsi C1 immunity (§11) ---------------------------------------------
test('plain-text PDF builder survives every confirmed C1 hole plus mixed junk', async () => {
  const { buildRedactedPdf } = require('../lib/build-redacted-pdf');
  for (const code of [0x81, 0x8d, 0x8f, 0x90, 0x9d]) {
    const bytes = await buildRedactedPdf('pin ' + String.fromCharCode(code) + ' end');
    assert.ok(bytes.length > 500, `builder failed on 0x${code.toString(16)}`);
  }
  const mixed = 'tabs\there ' + String.fromCharCode(0x07, 0x1b, 0x81) + ' café “quotes” 你好 ✓ end';
  const bytes = await buildRedactedPdf(mixed);
  assert.ok(bytes.length > 500, 'mixed junk crashed the builder');
});

test('build-redacted-pdf source contains zero raw control bytes', () => {
  const buf = fs.readFileSync(path.join(ROOT, 'lib', 'build-redacted-pdf.js'));
  let ctrl = 0;
  for (const b of buf) { if (b < 9 || (b > 13 && b < 32) || b === 127) ctrl++; }
  assert.strictEqual(ctrl, 0, `${ctrl} raw control bytes in source`);
});

// ---- OCR page cap + per-page quality + blank proof (§6, §8) ----------------
async function imagePdf(pageImages) {
  const { PDFDocument } = require('pdf-lib');
  const doc = await PDFDocument.create();
  for (const img of pageImages) {
    const png = await doc.embedPng(img);
    const page = doc.addPage([png.width, png.height]);
    page.drawImage(png, { x: 0, y: 0, width: png.width, height: png.height });
  }
  return Buffer.from(await doc.save());
}

function noisePng(w, h) {
  const { PNG } = require('pngjs');
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < png.data.length; i += 4) {
    const v = Math.floor(Math.random() * 256);
    png.data[i] = v; png.data[i + 1] = v; png.data[i + 2] = v; png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

function whitePng(w, h) {
  const { PNG } = require('pngjs');
  const png = new PNG({ width: w, height: h });
  png.data.fill(255);
  return PNG.sync.write(png);
}

const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixture-letter.png'));

test('scanned PDF over the page cap is rejected whole, never shortened', { timeout: 300000 }, async () => {
  const { ocrPdf, MAX_PDF_PAGES } = require('../lib/local-ocr-worker');
  const eleven = await imagePdf(Array.from({ length: MAX_PDF_PAGES + 1 }, () => FIXTURE));
  await assert.rejects(
    () => ocrPdf(eleven.toString('base64'), 'eleven.pdf', true),
    (e) => e.userFacing && e.code === 'page_limit' && new RegExp(String(MAX_PDF_PAGES)).test(e.message),
    'eleven-page scanned PDF must reject with the page limit named'
  );
});

test('one unreadable page fails the file and is NAMED, in either order; a truly blank page passes', { timeout: 300000 }, async () => {
  const { ocrPdf } = require('../lib/local-ocr-worker');
  const noise = noisePng(900, 400);
  const goodBad = await imagePdf([FIXTURE, noise]);
  await assert.rejects(
    () => ocrPdf(goodBad.toString('base64'), 'goodbad.pdf'),
    (e) => e.userFacing && e.code === 'low_confidence' && /page\s*2\b/i.test(e.message),
    'good+bad must fail naming page 2'
  );
  const badGood = await imagePdf([noise, FIXTURE]);
  await assert.rejects(
    () => ocrPdf(badGood.toString('base64'), 'badgood.pdf'),
    (e) => e.userFacing && e.code === 'low_confidence' && /page\s*1\b/i.test(e.message),
    'bad+good must fail identically naming page 1'
  );
  const withBlank = await imagePdf([FIXTURE, whitePng(900, 400)]);
  const out = await ocrPdf(withBlank.toString('base64'), 'withblank.pdf', true);
  assert.ok(out.text.includes('tinnitus'), 'good page text lost');
  assert.strictEqual(out.layout.pages.length, 2, 'blank page dropped from layout');
});

test('isBlankRaster: white page is blank, noise and the fixture are not', () => {
  const { isBlankRaster } = require('../lib/local-ocr-worker');
  assert.strictEqual(isBlankRaster(whitePng(400, 400)), true);
  assert.strictEqual(isBlankRaster(noisePng(400, 400)), false);
  assert.strictEqual(isBlankRaster(FIXTURE), false);
});

// ---- mixed-PDF routing contract (§7), replicated headlessly ----------------
test('a mixed digital+scanned PDF routes to OCR as a whole (no page skipped)', { timeout: 300000 }, async () => {
  const { PDFDocument, StandardFonts } = require('pdf-lib');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p1 = doc.addPage([612, 792]);
  const filler = 'This is a digital page with plenty of ordinary text about benefits. ';
  p1.drawText((filler.repeat(4)).slice(0, 220), { x: 40, y: 700, size: 12, font, maxWidth: 530, lineHeight: 16 });
  const png = await doc.embedPng(FIXTURE);
  const p2 = doc.addPage([png.width, png.height]);
  p2.drawImage(png, { x: 0, y: 0, width: png.width, height: png.height });
  const mixed = Buffer.from(await doc.save());

  // Replicate the renderer's classifier decision: page text via pdfjs-dist,
  // blankness via the worker's raster proof.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loaded = await pdfjs.getDocument({ data: new Uint8Array(mixed), disableFontFace: true, verbosity: 0 }).promise;
  const { pdf } = await import('pdf-to-img');
  const rasters = [];
  for await (const p of await pdf(mixed, { scale: 1 })) rasters.push(Buffer.from(p));
  const { isBlankRaster } = require('../lib/local-ocr-worker');
  let hasScanned = false;
  for (let i = 1; i <= loaded.numPages; i++) {
    const c = await (await loaded.getPage(i)).getTextContent();
    const text = c.items.map((it) => (it && it.str) ? it.str : '').join(' ');
    if (text.trim().length >= 80) continue;
    if (!isBlankRaster(rasters[i - 1])) hasScanned = true;
  }
  assert.strictEqual(loaded.numPages, 2);
  assert.strictEqual(hasScanned, true, 'scanned page not detected: file would be misrouted as digital');
});
