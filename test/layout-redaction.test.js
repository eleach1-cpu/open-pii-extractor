// Original-layout export: end-to-end adversarial proof on the OCR lane.
// fixture photo -> OCR with word boxes -> auto spans -> black boxes ->
// image-only PDF -> rasterize THAT -> OCR it again and assert the PII is
// physically unreadable while ordinary text survives. This is the test that
// makes "nothing can hide under a box" a checked fact instead of a claim.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { findRedactedSpans } = require('../lib/redaction-spans');
const { boxesForWords, normalizeToken } = require('../lib/layout-boxes');
const { buildLayoutPdf } = require('../lib/build-layout-pdf');

test('findRedactedSpans recovers the removed originals', () => {
  const t = 'SMITH, JOHN A ICN: 123456789V123456\nSocial Security: 123-45-6789\nDate of birth: 03/15/1975\n123 Maple Street, Springfield IL 62704\nYour claim for tinnitus has been granted.';
  const { spans, redacted } = findRedactedSpans(t);
  const joined = spans.join(' | ');
  assert.ok(joined.includes('123-45-6789'), 'SSN span missing: ' + joined);
  assert.ok(/123456789V123456/.test(joined), 'ICN span missing');
  assert.ok(/03\/15\/1975/.test(joined), 'DOB span missing');
  assert.ok(/Maple Street/.test(joined), 'street span missing');
  assert.ok(/SMITH/i.test(joined), 'name span missing');
  assert.ok(!redacted.includes('123-45-6789'), 'redacted text still has SSN');
  assert.ok(redacted.includes('tinnitus'), 'safe text lost');
});

test('boxesForWords: exact, windowed, and fused matches; safe words unboxed', () => {
  const words = [
    { text: 'Social', x: 0, y: 0, w: 40, h: 10 },
    { text: 'Security:', x: 45, y: 0, w: 50, h: 10 },
    { text: '123-45-6789', x: 100, y: 0, w: 70, h: 10 },
    { text: '123', x: 0, y: 20, w: 20, h: 10 },
    { text: 'Maple', x: 25, y: 20, w: 30, h: 10 },
    { text: 'Street', x: 60, y: 20, w: 30, h: 10 },
    { text: 'tinnitus', x: 0, y: 40, w: 40, h: 10 },
    { text: 'ICN:123456789V123456', x: 0, y: 60, w: 120, h: 10 },
  ];
  const lists = [['123456789'], ['123', 'maple', 'street'], ['123456789v123456']];
  const rects = boxesForWords(words, lists);
  // Regression (real letter, 2026-08-29): a fused page-header run like
  // "LEACH,ERIC" must be boxed by the standalone 5-char name token.
  const fused = boxesForWords([{ text: 'LEACH,ERIC', x: 0, y: 0, w: 80, h: 10 }], [['leach']]);
  assert.strictEqual(fused.length, 1, 'fused 5-char name token not boxed');
  const covers = (wordIdx) => rects.some((r) => r.x <= words[wordIdx].x && r.x + r.w >= words[wordIdx].x + words[wordIdx].w && r.y <= words[wordIdx].y);
  assert.ok(covers(2), 'SSN word not boxed');
  assert.ok(covers(3) && covers(4) && covers(5), 'address words not all boxed');
  assert.ok(covers(7), 'fused ICN word not boxed');
  assert.ok(!covers(6), 'safe word got boxed');
});

test('adversarial round trip: OCR the boxed output, PII gone, prose intact', { timeout: 300000 }, async () => {
  const { ocrImage } = require('../lib/local-ocr');
  const b64 = fs.readFileSync(path.join(__dirname, 'fixture-letter.png')).toString('base64');
  const first = await ocrImage(b64, 'fixture.png', true);
  assert.ok(first.layout && first.layout.pages.length === 1, 'layout missing from OCR');

  const { spans } = findRedactedSpans(first.text);
  const lists = spans.map((s) => s.split(/\s+/).map(normalizeToken).filter(Boolean)).filter((l) => l.length);
  const page = first.layout.pages[0];
  const rects = boxesForWords(page.words, lists);
  assert.ok(rects.length >= 4, `implausibly few boxes: ${rects.length}`);
  // The export must redact the PII, not the letter: boxes must cover well
  // under the full word count (the mega-span diff bug boxed 26 of 30 words).
  assert.ok(rects.length <= page.words.length * 0.6, `document destroyed: ${rects.length} boxes over ${page.words.length} words`);

  const pdfBytes = await buildLayoutPdf([{ imgBase64: page.imgBase64, scale: first.layout.scale, rects }]);
  // The output must contain ZERO text objects (image-only by construction).
  const { PDFDocument } = require('pdf-lib');
  const outDoc = await PDFDocument.load(pdfBytes);
  assert.strictEqual(outDoc.getPageCount(), 1);
  assert.ok(!String.fromCharCode(...pdfBytes.slice(0, 4000)).includes('/Font'), 'output page carries a font, text may exist');

  // Rasterize the output and OCR it: what a determined reader would do.
  const { pdf } = await import('pdf-to-img');
  let outPng;
  for await (const p of await pdf(Buffer.from(pdfBytes), { scale: 2 })) { outPng = Buffer.from(p); break; }
  // No leniency: a correctly redacted letter still OCRs (prose survives);
  // an unreadable page would mean the export destroyed the document.
  const secondText = await require('../lib/local-ocr').ocrImage(outPng.toString('base64'), 'roundtrip.png');
  const norm = secondText.replace(/[^0-9a-zA-Z]/g, '').toLowerCase();
  assert.ok(!norm.includes('123456789'), 'SSN/ICN digits readable in the redacted output');
  // The OCR-split ICN tail ("...V 123456") leaked past the pre-2026-08-29
  // rules and was visible in this very artifact; it must never come back.
  assert.ok(!norm.includes('123456'), 'ICN tail digits readable in the redacted output');
  assert.ok(!norm.includes('maplestreet'), 'address readable in the redacted output');
  assert.ok(!norm.includes('smith'), 'name readable in the redacted output');
  assert.ok(/tinnitus|granted|veterans/i.test(secondText), 'ordinary prose should survive the boxes');
});
