// App-level guards that must never regress.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');

test('offline enforcement: every web request cancelled, every permission denied', () => {
  assert.match(mainSrc, /webRequest\.onBeforeRequest/, 'request blocker gone');
  assert.match(mainSrc, /cancel:\s*!ok/, 'blocker no longer cancels');
  assert.match(mainSrc, /setPermissionRequestHandler\(\(wc, permission, cb\) => cb\(false\)\)/, 'permission denial gone');
  assert.match(mainSrc, /setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\)/, 'window-open denial gone');
  assert.match(htmlSrc, /connect-src 'none'/, 'renderer CSP lost connect-src none');
});

test('renderer is sandboxed from Node', () => {
  assert.match(mainSrc, /contextIsolation:\s*true/);
  assert.match(mainSrc, /nodeIntegration:\s*false/);
});

test('tessdata is bundled and env-pinned before lib requires', () => {
  assert.match(mainSrc, /TESSERACT_CACHE_DIR/, 'tessdata pin gone');
  assert.ok(fs.existsSync(path.join(ROOT, 'assets', 'tessdata', 'eng.traineddata.gz')),
    'bundled eng.traineddata.gz missing: run node scripts/fetch-tessdata.js');
  const worker = fs.readFileSync(path.join(ROOT, 'lib', 'local-ocr-worker.js'), 'utf8');
  assert.match(worker, /langPath: CACHE_DIR/, 'worker no longer reads language data locally');
});

test('PDF export is a labeled text reconstruction with wrapped, paginated text', async () => {
  const { buildRedactedPdf, NOTE } = require('../lib/build-redacted-pdf');
  const longLine = 'The veteran [NAME REDACTED] filed for tinnitus. '.repeat(40);
  const manyLines = Array.from({ length: 120 }, (_, i) => `Line ${i + 1}: [SSN REDACTED] entry.`).join('\n');
  const bytes = await buildRedactedPdf(longLine + '\n' + manyLines + '\nUnicode smoke: café — ✓');
  assert.ok(bytes.length > 2000, 'implausibly small PDF');
  const { PDFDocument } = require('pdf-lib');
  const doc = await PDFDocument.load(bytes);
  assert.ok(doc.getPageCount() >= 3, `expected pagination, got ${doc.getPageCount()} page(s)`);
  assert.ok(NOTE.includes('Not the original document layout'), 'reconstruction label text changed');
});
