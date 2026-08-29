// One-time (and build-time) fetch of the Tesseract English language data so
// the packaged app never downloads anything at runtime. This script is the
// ONLY network use in the whole project, and it runs on the developer's
// machine, never on a veteran's.
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');

const DEST_DIR = path.join(__dirname, '..', 'assets', 'tessdata');
const DEST = path.join(DEST_DIR, 'eng.traineddata.gz');
// Same source tesseract.js v5 uses by default (tessdata_fast, gzipped).
const URL = 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0_best_int/eng.traineddata.gz';

fs.mkdirSync(DEST_DIR, { recursive: true });
if (fs.existsSync(DEST) && fs.statSync(DEST).size > 1000000) {
  console.log('tessdata already present:', DEST);
  process.exit(0);
}

function get(url, redirects = 0) {
  if (redirects > 5) { console.error('too many redirects'); process.exit(1); }
  https.get(url, (res) => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      return get(res.headers.location, redirects + 1);
    }
    if (res.statusCode !== 200) { console.error('HTTP', res.statusCode); process.exit(1); }
    const out = fs.createWriteStream(DEST);
    res.pipe(out);
    out.on('finish', () => {
      out.close(() => {
        console.log('saved', DEST, fs.statSync(DEST).size, 'bytes');
      });
    });
  }).on('error', (e) => { console.error(e.message); process.exit(1); });
}
get(URL);
