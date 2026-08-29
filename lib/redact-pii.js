/**
 * PII redactor for the grounding API's letter-handling endpoints.
 *
 * v1 patterns are regex-based and conservative. They catch the common
 * VA-letter PII shapes (SSN, VA file number, claim number, DOB, name on
 * a label line, address, phone, email, dates of birth, ICN, EDIPI/DOD/
 * file-number fused tokens). They do NOT catch arbitrary free-text
 * mentions of a veteran's name outside a label line or a footer-anchored
 * spot. We document that limitation in the API terms and surface every
 * applied redaction to the caller so a manual pass is possible.
 *
 * Output:
 *   {
 *     redacted_text: string,
 *     redactions: [
 *       { type: "ssn"|"va_file"|"claim_no"|"dob"|"name"|"phone"|"email"|"address"|"icn"|"edipi",
 *         // "icn" and "edipi" added 2026-08-04 (Half B of
 *         // docs/2026-08-04-pii-hardening-plan.md), additive only.
 *         original_offset: number,  // offset in the ORIGINAL text
 *         length: number }
 *     ]
 *   }
 *
 * Notes on design choices:
 *   - We replace each match with a fixed token (e.g. "[SSN]") rather than
 *     same-length whitespace. This means downstream char-offset math
 *     must use the post-redaction text. We return the original offset
 *     in the redactions array so callers who need byte-accurate diff
 *     can reconstruct.
 *   - We process patterns in priority order. Once a span is redacted,
 *     subsequent patterns skip overlapping spans. ICN patterns sit ABOVE
 *     the phone and 9-digit SSN patterns for exactly this reason: a bare
 *     ICN's leading 10 digits satisfy the phone-number shape, and without
 *     priority the phone pattern would claim that span first and leave the
 *     "V123456" suffix as an unredacted remainder (2026-08-04 gap fix).
 *   - Fused OCR tokens (a PII label glued to its digit run with no word
 *     boundary, e.g. "SSN123456789") are found by
 *     va-pii-rules.findFusedTokenSpans and folded into the same span list.
 *   - Footer-anchored names (VA letters print "LAST, FIRST M" next to the
 *     ICN, or "FIRST LAST" before "N of N") are found by
 *     va-pii-rules.findFooterNameTokens on the ORIGINAL text, then every
 *     occurrence of each token anywhere in the text becomes a span. The
 *     org/state denylist is already applied inside that function.
 */

const {
  ICN_BARE_SRC,
  ICN_LABELED_SRC,
  escapeRegExp,
  findFooterNameTokens,
  findDependentNameTokens,
  findFusedTokenSpans,
} = require('./va-pii-rules');

const PATTERNS = [
  // ICN (both shapes) MUST sit above the phone pattern and the 9-digit SSN
  // pattern: see the file-header note above and Gotcha 3 in the hardening
  // plan. Labeled form first so its longer match wins ties at the same start.
  { type: 'icn',      re: new RegExp('\\b' + ICN_LABELED_SRC + '\\b', 'gi'),                                token: '[ICN]' },
  { type: 'icn',      re: new RegExp('\\b' + ICN_BARE_SRC + '\\b', 'g'),                                    token: '[ICN]' },
  { type: 'ssn',      re: /\b\d{3}[- ]\d{2}[- ]\d{4}\b/g,                                                  token: '[SSN]' },
  { type: 'ssn',      re: /\b\d{9}(?=\D|$)/g,                                                              token: '[SSN]',     guard: matchLooksLikeSsn },
  { type: 'va_file',  re: /\bC[\s-]?\d{2}[\s-]?\d{3}[\s-]?\d{3}\b/g,                                       token: '[VA-FILE]' },
  { type: 'claim_no', re: /\bclaim\s+(?:no\.?|number|#)\s*:?\s*\d{6,12}\b/gi,                              token: 'claim no. [CLAIM-NO]' },
  { type: 'dob',      re: /\b(?:DOB|Date of Birth|D\.O\.B\.|Born)\s*:?\s*(?:[A-Z][a-z]{2,9}\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})\b/gi, token: 'DOB: [DOB]' },
  // Name on a label line: keep the label, redact the rest.
  { type: 'name',     re: /^(\s*(?:Veteran|Claimant|Name|Recipient)\s*:?\s*)[A-Z][^\n]{2,80}$/gm,           token: '__PREFIX__[NAME]' },
  // Phone: optional leading paren, no word boundary required (so "(703)" parens are captured).
  { type: 'phone',    re: /\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?=\D|$)/g,                                  token: '[PHONE]' },
  { type: 'email',    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,                           token: '[EMAIL]' },
  // Address: either line-start "1234 Main St" OR "Address: 1234 Main St".
  { type: 'address',  re: /^(\s*(?:Address|Addr|Mailing(?:\s+Address)?)\s*:?\s*)?\d{1,6}\s+[A-Z][^\n]{2,80}\b(?:Street|St\.?|Avenue|Ave\.?|Road|Rd\.?|Lane|Ln\.?|Drive|Dr\.?|Boulevard|Blvd\.?|Court|Ct\.?|Place|Pl\.?|Way|Highway|Hwy\.?|Parkway|Pkwy\.?)\b[^\n]*$/gm, token: '__PREFIX__[ADDRESS]' },
];

// 9-digit numbers are commonly used for VA file numbers, EFT account
// numbers, etc. To reduce false positives we require the number to
// appear near an SSN-like cue.
function matchLooksLikeSsn(text, idx) {
  const window = text.slice(Math.max(0, idx - 32), idx);
  return /\bSSN|Social Security|Social-Security/i.test(window);
}

function redactPII(text) {
  if (!text || typeof text !== 'string') return { redacted_text: text || '', redactions: [] };
  // Collect non-overlapping spans in priority order.
  const spans = [];

  // Fused OCR tokens FIRST, same reasoning as stripLetterPII's pass order
  // (docs/2026-08-04-pii-hardening-plan.md gotcha 2): a fused label glued to
  // its digit run (e.g. "recordEDIPI1234567890") is a MORE specific signal
  // than the generic phone/SSN patterns below, and those generic patterns
  // have no word-boundary requirement on their leading edge, so they would
  // otherwise claim the digit run first and leave a mangled label prefix.
  // va-pii-rules.findFusedTokenSpans mirrors strip-letter-pii.js's
  // redactFusedTokens exactly, so both redactors classify the same tokens.
  for (const fs of findFusedTokenSpans(text)) {
    if (spans.some(s => !(fs.end <= s.start || fs.start >= s.end))) continue;
    spans.push({ start: fs.start, end: fs.end, type: fs.type, replacement: fs.replacement });
  }

  for (const p of PATTERNS) {
    const re = new RegExp(p.re.source, p.re.flags);
    let m;
    while ((m = re.exec(text)) !== null) {
      const fullStart = m.index;
      const fullEnd = m.index + m[0].length;
      if (p.guard && !p.guard(text, fullStart)) continue;
      // Skip if overlapping any prior span (higher-priority match wins).
      if (spans.some(s => !(fullEnd <= s.start || fullStart >= s.end))) continue;
      const prefix = m[1] || '';
      const replacement = p.token.replace('__PREFIX__', prefix);
      spans.push({ start: fullStart, end: fullEnd, type: p.type, replacement });
    }
  }

  // Footer-anchored names ("LAST, FIRST M" next to the ICN, or "FIRST LAST"
  // before "N of N"). va-pii-rules.findFooterNameTokens already applies the
  // org/state denylist; here we just find every occurrence of each
  // discovered token anywhere in the text and emit a span per occurrence.
  const nameTokens = findFooterNameTokens(text);
  // Dependents-TABLE names ("Child   Marcus    Feb 17, 1995"), same union as
  // stripLetterPII: fold into the same span pass so they redact everywhere.
  for (const tok of findDependentNameTokens(text)) nameTokens.add(tok);
  for (const tok of nameTokens) {
    const nameRe = new RegExp('\\b' + escapeRegExp(tok) + '\\b', 'gi');
    let nm;
    while ((nm = nameRe.exec(text)) !== null) {
      const nStart = nm.index;
      const nEnd = nm.index + nm[0].length;
      if (spans.some(s => !(nEnd <= s.start || nStart >= s.end))) continue;
      spans.push({ start: nStart, end: nEnd, type: 'name', replacement: '[NAME]' });
    }
  }

  spans.sort((a, b) => a.start - b.start);

  const out = [];
  const redactions = [];
  let cursor = 0;
  for (const s of spans) {
    if (s.start < cursor) continue;
    out.push(text.slice(cursor, s.start));
    out.push(s.replacement);
    redactions.push({ type: s.type, original_offset: s.start, length: s.end - s.start });
    cursor = s.end;
  }
  out.push(text.slice(cursor));
  return { redacted_text: out.join(''), redactions };
}

module.exports = { redactPII, PATTERNS };
