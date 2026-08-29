// First-launch terms acceptance store (safety handoff §9A). Pure Node so
// the suite tests it without Electron; main.js supplies the user-data dir.
// Fails CLOSED: a missing, malformed, tampered, stale-version, or
// future-dated record means NOT accepted. Stores ONLY the accepted terms
// version and a local timestamp; no identifier, no telemetry, no network.
'use strict';

const fs = require('fs');
const path = require('path');

const TERMS_VERSION = 1;
const FILE_NAME = 'terms-acceptance.json';

function fileFor(dir) {
  return path.join(dir, FILE_NAME);
}

function isAccepted(dir) {
  try {
    const raw = fs.readFileSync(fileFor(dir), 'utf8');
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object') return false;
    if (j.version !== TERMS_VERSION) return false;
    const t = Date.parse(j.acceptedAt);
    if (!Number.isFinite(t)) return false;
    if (t > Date.now() + 5 * 60 * 1000) return false; // future-dated = tampered
    return true;
  } catch (e) {
    return false;
  }
}

function accept(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(fileFor(dir), JSON.stringify({ version: TERMS_VERSION, acceptedAt: new Date().toISOString() }) + '\n', 'utf8');
  return true;
}

module.exports = { TERMS_VERSION, isAccepted, accept, fileFor };
