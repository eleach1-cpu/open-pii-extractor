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

// Source-level pins; the RUNTIME proof (process.sandboxed === true in the
// live renderer) lives in test/electron-smoke.test.js, because a grep can
// not prove a runtime property (safety handoff §10.6).
test('renderer isolation flags: contextIsolation, no nodeIntegration, OS sandbox ON', () => {
  assert.match(mainSrc, /contextIsolation:\s*true/);
  assert.match(mainSrc, /nodeIntegration:\s*false/);
  assert.match(mainSrc, /sandbox:\s*true/);
  assert.doesNotMatch(mainSrc, /sandbox:\s*false/);
  assert.match(mainSrc, /app\.enableSandbox\(\)/);
});

test('offline copy is the precise no-upload wording, not the absolute claim', () => {
  assert.ok(htmlSrc.includes('All processing happens on this computer. No uploads, no cloud OCR, no account, no telemetry.'));
  assert.ok(!/cannot use the internet/i.test(htmlSrc), 'absolute internet claim is back (owner default 3)');
});

test('first-launch terms gate markup: unchecked box, disabled Accept, Decline, no escape hatch', () => {
  assert.match(htmlSrc, /id="terms-gate" hidden/);
  assert.match(htmlSrc, /id="terms-checkbox"(?![^>]*checked)/, 'checkbox must start unchecked');
  assert.match(htmlSrc, /id="terms-accept" disabled/);
  assert.match(htmlSrc, /id="terms-decline"/);
  assert.ok(htmlSrc.includes('I have read and accept these terms.'));
  assert.ok(htmlSrc.includes('Important: You must verify the result'));
  const appSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8');
  assert.ok(/Escape'\) e\.preventDefault\(\)/.test(appSrc), 'Escape must not dismiss the gate');
});

test('the review reminder sits beside the save controls for all output modes', () => {
  const sp = fs.readFileSync(path.join(ROOT, 'renderer', 'safe-preview.js'), 'utf8');
  assert.ok(sp.includes('Review every page before sharing. Automatic redaction can miss information or remove the wrong text.'));
  // One actions row hosts all save buttons, so one reminder covers text,
  // plain-PDF, and original-layout output.
  assert.ok(sp.indexOf('li-save-reminder') > sp.indexOf('li-safe-save-layout'));
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

// REGRESSION GUARD, 2026-08-29. The shipped v1.0.0/v1.1.0 installers excluded
// node_modules/canvas/build from the bundle, so canvas.node was absent and
// canvas/lib/bindings.js (an unconditional require of ../build/Release/canvas.node)
// threw MODULE_NOT_FOUND. That killed every scanned PDF, because pdf-to-img
// rasterizes pages through canvas, and it took the original-layout export for
// scanned input with it. Dev and `npm test` could not see it: they run from the
// source tree where the binary exists, so only the packaged artifact was broken.
// A .node file also cannot be dlopen'ed from inside an asar archive, so shipping
// it is not enough on its own, it must be unpacked as well.
test('the packaging config ships the native canvas binary, unpacked', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const files = pkg.build.files || [];
  const excludesCanvas = files.some((f) => /^!.*canvas/.test(f));
  assert.ok(!excludesCanvas, 'build.files excludes canvas: scanned PDFs will fail in the packaged app');
  const unpack = pkg.build.asarUnpack || [];
  assert.ok(unpack.some((p) => p.includes('canvas')),
    'canvas must be in asarUnpack: a .node cannot load from inside app.asar');
});
