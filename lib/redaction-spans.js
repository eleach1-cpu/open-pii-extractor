// Which ORIGINAL substrings did the redactor remove? The rules live in
// strip-letter-pii.js and are never forked; this module recovers the removed
// spans by diffing original vs redacted output. Those spans (plus any words
// the veteran taps) are what the original-layout export blacks out.
//
// WORD-LEVEL diff (2026-08-29 rewrite). The first version walked characters
// and resynced on a raw substring probe; on a real 21-page letter the
// repeated page footers frayed it into glue spans ("ately.  LEACH") and
// shrapnel ("a.gov"), which both leaked the name in page headers and boxed
// every public va.gov link. Words + 3-gram resync are immune to the
// whitespace and punctuation rewrites the redactor is allowed to make.
'use strict';

const { stripLetterPII } = require('./strip-letter-pii');

const LABEL_WORD = String.fromCharCode(1);
const LABEL_ATOM = ' ' + LABEL_WORD + ' ';
const LABEL_RE = /\[(?:SSN|DOB|FILE#|ADDRESS|NAME|ID) REDACTED\]/g;
const RESYNC_WINDOW = 250; // words scanned ahead on each side to realign
const NGRAM = 3;

function findRedactedSpans(original) {
  const O = String(original || '');
  const R = stripLetterPII(O);
  // A label contains a space, so collapse each one to a single atom BEFORE
  // splitting the redacted text into words.
  const wordsO = O.split(/\s+/).filter(Boolean);
  const wordsR = R.replace(LABEL_RE, LABEL_ATOM).split(/\s+/).filter(Boolean);

  const spans = [];
  let i = 0, j = 0;
  const gramAt = (arr, k, n) => {
    if (k + n > arr.length) return null;
    const g = arr.slice(k, k + n);
    return g.includes(LABEL_WORD) || g.includes(LABEL_ATOM) ? null : g.join(' ');
  };
  // Graded resync: prefer a 3-word anchor; label-dense regions ("ICN:" alone
  // between two labels) have matched runs shorter than 3 words, so fall back
  // to 2, then to a single word that is at least 4 characters (so "the"
  // never becomes an anchor). Returns { oi, rj } or null.
  const resync = (fromO, fromR, allowLabelSkip) => {
    // All gram sizes compete on COST (words skipped on both sides); ties go
    // to the larger gram. First-found-at-n=3 alone overshot label-dense
    // regions and glued matched words into spans.
    let best = null;
    for (const n of [NGRAM, 2, 1]) {
      for (let rj = fromR; rj <= Math.min(fromR + RESYNC_WINDOW, wordsR.length - n); rj++) {
        if (wordsR[rj] === LABEL_WORD) {
          if (allowLabelSkip) continue;
          break;
        }
        const g = gramAt(wordsR, rj, n);
        if (g === null) continue;
        if (n === 1 && g.length < 4) continue;
        for (let oi = fromO; oi <= Math.min(fromO + RESYNC_WINDOW, wordsO.length - n); oi++) {
          if (gramAt(wordsO, oi, n) === g) {
            const cost = oi - fromO + (rj - fromR);
            if (!best || cost < best.cost) best = { oi, rj, cost };
            break;
          }
        }
        if (best && rj - fromR > best.cost) break; // cannot beat it any more
      }
    }
    return best;
  };
  while (j < wordsR.length) {
    if (wordsR[j] === LABEL_WORD) {
      // Removed content sits at i; realign past this label run.
      const best = resync(i, j + 1, true);
      let end;
      if (best) end = best.oi;
      else if (wordsR.length - j <= NGRAM) end = wordsO.length; // tail redaction
      else end = Math.min(i + 1, wordsO.length);               // FAIL SAFE: one word
      const removed = wordsO.slice(i, end).join(' ').trim();
      if (removed) spans.push(removed);
      i = end;
      j = best ? best.rj : j + 1;
      continue;
    }
    if (i < wordsO.length && wordsO[i] === wordsR[j]) { i++; j++; continue; }
    // Words differ without a label (a rewrite like "ICN:#123" -> "ICN:"):
    // resync the same way; O words skipped become a span, R glue is skipped.
    const best = resync(i, j, false);
    if (best && (best.oi > i || best.rj > j)) {
      const removed = wordsO.slice(i, best.oi).join(' ').trim();
      if (removed) spans.push(removed);
      i = best.oi;
      j = best.rj;
    } else {
      i++; j++; // FAIL SAFE: never stall, never swallow the document
    }
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
