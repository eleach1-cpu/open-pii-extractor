// Which ORIGINAL substrings did the redactor remove? The rules live in
// strip-letter-pii.js and are never forked; this module recovers the removed
// spans by diffing original vs redacted output. Those spans (plus any words
// the veteran taps) are what the original-layout export blacks out.
'use strict';

const { stripLetterPII } = require('./strip-letter-pii');

const LABEL_RE = /^\[(?:SSN|DOB|FILE#|ADDRESS|NAME|ID) REDACTED\]/;

// Walk original O and redacted R together. On divergence, consume any
// rewritten glue up to the next label in R, consume the label, then resync
// by searching O for the next run of R. Everything skipped in O is a span.
function findRedactedSpans(original) {
  const O = String(original || '');
  const R = stripLetterPII(O);
  const spans = [];
  let i = 0, j = 0;
  while (j < R.length) {
    if (i < O.length && O[i] === R[j]) { i++; j++; continue; }
    // Divergence. Find the next label at or shortly after j (replacement
    // glue like ": " may precede it).
    let labelAt = -1;
    for (let k = j; k < Math.min(j + 12, R.length); k++) {
      if (R[k] === '[' && LABEL_RE.test(R.slice(k))) { labelAt = k; break; }
    }
    if (labelAt === -1) {
      // Not a redaction site (should not happen); fail safe by advancing.
      i++; j++;
      continue;
    }
    j = labelAt + R.slice(labelAt).match(LABEL_RE)[0].length;
    // Probe = the next stretch of R up to the following label (or 24 chars).
    let probeEnd = j;
    while (probeEnd < R.length && probeEnd - j < 24 && R[probeEnd] !== '[') probeEnd++;
    const probe = R.slice(j, probeEnd);
    // The redactor is allowed to rewrite whitespace around a replacement
    // (e.g. the orphan-initial rule leaves a double space), so the resync is
    // WHITESPACE-TOLERANT: probe words must reappear in order, any gaps.
    const probeWords = probe.split(/\s+/).filter(Boolean);
    let resync = -1;
    if (probeWords.length) {
      const rx = new RegExp(probeWords.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'));
      const m2 = rx.exec(O.slice(i));
      if (m2) resync = i + m2.index;
    }
    if (resync === -1) {
      // FAIL SAFE: over-redact one token, never the rest of the document.
      const gap = O.slice(i).search(/\s/);
      resync = gap === -1 ? O.length : i + gap;
    }
    const removed = O.slice(i, resync).trim();
    if (removed) spans.push(removed);
    i = resync;
  }
  return { spans: dedupe(spans), redacted: R };
}

function dedupe(list) {
  return [...new Set(list)];
}

// A span like "123 Maple Street, Springfield IL 62704" must black out its
// words wherever they appear TOGETHER; single-token spans (a name token)
// black out everywhere. The exporter matches on normalized tokens.
function normalizeToken(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function spanTokenLists(spans) {
  return spans
    .map((s) => s.split(/\s+/).map(normalizeToken).filter(Boolean))
    .filter((l) => l.length);
}

module.exports = { findRedactedSpans, spanTokenLists, normalizeToken };
