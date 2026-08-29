/**
 * Local OCR for the Letter Interpreter, PUBLIC API (thin spawner).
 *
 * Runs entirely on our server (Tesseract via tesseract.js + pdf-to-img). The
 * raw image NEVER leaves our infrastructure for a third-party AI: only
 * redacted TEXT is sent to the interpretation model downstream.
 *
 * The actual OCR runs in a short-lived CHILD PROCESS (local-ocr-worker.js)
 * spawned per job. tesseract.js (WASM) + pdf-to-img (native canvas) allocate
 * hundreds of MB that Node/glibc do not return to the OS even after
 * worker.terminate() (measured in prod: RSS climbed ~300-400 MB per use and
 * never came back without a restart, driving GC pressure and intermittent
 * site-wide slowness). Isolating each job in a process that EXITS afterward
 * lets the OS reclaim 100% of that memory, so the long-lived server stays
 * lean. This module's public interface (ocrImage / ocrPdf) is unchanged, so
 * callers do not change.
 */

'use strict';

const path = require('path');
const { spawn } = require('child_process');
// Constants are defined in the worker; importing the module here does NOT run
// its CLI (that is gated by require.main===module) and does NOT pull in the
// heavy OCR deps (tesseract.js / pdf-to-img are lazy-loaded inside the worker
// functions, not at module load).
const { CACHE_DIR, MIN_CONFIDENCE, RESULT_SENTINEL } = require('./local-ocr-worker');

const WORKER_PATH = path.join(__dirname, 'local-ocr-worker.js');
// Generous ceiling: a 10-page scanned PDF legitimately takes tens of seconds
// (prod saw 66-76s). Past this the child is presumed hung and is killed.
const OCR_TIMEOUT_MS = Number(process.env.OCR_TIMEOUT_MS) || 150000;

function userErr(message, statusCode = 400) {
  const e = new Error(message);
  e.userFacing = true;
  e.statusCode = statusCode;
  return e;
}

// Spawn the worker child, feed it the job on stdin, resolve with the OCR text
// (or reject with a reconstructed userFacing error). The child exits after
// each job so its WASM/native memory is fully reclaimed by the OS.
function runOcr(kind, base64, filename, withLayout) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      // DESKTOP-APP CHANGE (see SYNC.md): cwd is the app root (lib/..), and
      // ELECTRON_RUN_AS_NODE makes the spawned Electron binary behave as
      // plain Node for the worker script.
      child = spawn(process.execPath, [WORKER_PATH], {
        cwd: path.join(__dirname, '..'),
        stdio: ['pipe', 'pipe', 'inherit'],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      });
    } catch (e) {
      return reject(userErr('Could not start the document reader. Please paste the text instead.', 500));
    }

    let stdout = '';
    let settled = false;
    const done = (fn, arg) => { if (!settled) { settled = true; clearTimeout(timer); fn(arg); } };

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) {}
      done(reject, userErr('Reading the document timed out. Try a smaller or clearer file, or paste the text instead.', 504));
    }, OCR_TIMEOUT_MS);

    child.stdout.setEncoding('utf8'); // per-chunk toString('utf8') split multi-byte chars into U+FFFD
    child.stdout.on('data', (d) => { stdout += d; });
    child.on('error', () => done(reject, userErr('The document reader failed to run. Please paste the text instead.', 500)));
    child.on('close', () => {
      // Pull the sentinel-prefixed JSON result line out of stdout (any stray
      // library output on stdout is ignored).
      const line = stdout.split('\n').filter(Boolean).reverse().find(l => l.startsWith(RESULT_SENTINEL));
      if (!line) return done(reject, userErr("We couldn't read that file. Please paste the text instead.", 500));
      let res;
      try { res = JSON.parse(line.slice(RESULT_SENTINEL.length).trim()); }
      catch (_) { return done(reject, userErr("We couldn't read that file. Please paste the text instead.", 500)); }
      if (res.ok) return done(resolve, res.layout ? { text: res.text, layout: res.layout } : res.text);
      // Reconstruct the error so the caller's userFacing/statusCode handling
      // works exactly as it did when OCR ran in-process.
      const e = new Error(res.message || 'OCR failed.');
      e.userFacing = !!res.userFacing;
      e.statusCode = res.statusCode || 500;
      if (res.code) e.code = res.code; // failure kind (e.g. 'low_confidence') for instrumentation
      done(reject, e);
    });

    // Feed the job and close stdin so the child's `for await` completes.
    try {
      child.stdin.write(JSON.stringify({ kind, base64, filename, withLayout: !!withLayout }));
      child.stdin.end();
    } catch (e) {
      try { child.kill('SIGKILL'); } catch (_) {}
      done(reject, userErr('Could not send the document to the reader. Please paste the text instead.', 500));
    }
  });
}

async function ocrImage(base64, filename = 'image', withLayout = false) {
  return runOcr('image', base64, filename, withLayout);
}

async function ocrPdf(base64, filename = 'document', withLayout = false) {
  return runOcr('pdf', base64, filename, withLayout);
}

module.exports = { ocrImage, ocrPdf, CACHE_DIR, MIN_CONFIDENCE };
