// Shared VA-specific PII knowledge, used by BOTH redactors:
//   - src/lib/pii/strip-letter-pii.js (veteran-facing chat flow)
//   - src/lib/grounding/redact-pii.js (partner grounding API, /api/v1/letter)
// The rules live here once so the two redactors cannot drift apart. Each
// redactor keeps its OWN return shape and replace/span mechanics; only the
// underlying VA-specific knowledge (org denylist, ICN shapes, footer name
// discovery, fused-token detection) is shared. See
// docs/2026-08-04-pii-hardening-plan.md, "Half B", design decision 2.

// Org / heading / state words that look name-shaped but are not personal
// names. Used to avoid false-positive name redaction. This is the ONE place
// this Set may be defined (tests/pii-redaction.test.js enforces it); every
// other file must require it from here.
const PII_ORG_WORDS = new Set(
  ('VETERANS DEPARTMENT AFFAIRS ADMINISTRATION BENEFITS REGIONAL OFFICE FOREIGN WARS ' +
   'ARMY NAVY MARINE MARINES AIR FORCE COAST GUARD SPACE RESERVE NATIONAL ' +
   'RATING DECISION INTRODUCTION EVIDENCE REASONS FRAUD PREVENTION PAGE NUMBER FILE ' +
   'REPRESENTED COMPENSATION PENSION INTAKE CENTER BOARD APPEALS FIDUCIARY SURVIVORS ' +
   'DEPENDENT DEPENDENTS PAYMENT EXPLANATION CORRESPONDENCE ATTACHMENT FORM ' +
   'GULF ERA PEACETIME UNITED STATES AMERICA OF THE AND FOR DAV VFW AMVETS TERA SWA ICN ' +
   'AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV ' +
   'NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC ' +
   // Words that legitimately follow a dependent-type word ("Child SUPPORT",
   // "Spouse BENEFITS", "the child ATTENDING school") in ordinary prose and
   // must never be mistaken for a dependent's name (findDependentNameTokens).
   'SUPPORT ALLOWANCE STATUS CUSTODY CARE UNDER OVER ATTENDING SCHOOL NAME EFFECTIVE DATE').split(/\s+/)
);

// Month names/abbreviations, used ONLY as a guard so a dependents-table row
// like "Child Marcus Feb 17, 1995" never captures the date column's month as
// a second name token. Kept local to this module (not shared with the DOB
// expansion month lists in strip-letter-pii.js) since this is a narrower,
// uppercase-keyed guard, not a parser.
const PII_MONTH_TOKENS = new Set(
  ('JANUARY FEBRUARY MARCH APRIL MAY JUNE JULY AUGUST SEPTEMBER OCTOBER NOVEMBER DECEMBER ' +
   'JAN FEB MAR APR JUN JUL AUG SEP SEPT OCT NOV DEC').split(/\s+/)
);

// ICN (Integrated Control Number) pattern SOURCES, exported as strings (not
// compiled RegExp objects) so each caller builds its own RegExp with the
// flags it needs (global for span scanning, single-shot for a one-off test,
// case-insensitive where the label may vary case).
const ICN_BARE_SRC = '\\d{9,11}V\\d{5,7}';
const ICN_LABELED_SRC = '(?:ICN|integrated control number)[:#\\s]*' + ICN_BARE_SRC;

function escapeRegExp(x) { return String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// ── Footer name discovery ──────────────────────────────────────────────
// VA letters print the veteran's name in a repeated page footer, either
// "LAST, FIRST M" next to the ICN, or "FIRST LAST" right before "N of N".
// Collect name tokens ONLY from those footer-anchored spots, so ordinary
// "Word, Word" comma pairs in the evidence list and prose are never mistaken
// for a name. Returns a Set of the exact name TOKEN STRINGS found (not
// mutated text), so each caller can redact them however it needs to
// (stripLetterPII: its own replace loop; redactPII: spans on the original
// text). Extracted verbatim from stripLetterPII's inline logic (Phase 3).
function findFooterNameTokens(text) {
  const nameTokens = new Set();
  // The footer anchors below are TRUSTED name contexts, so two-character
  // surnames ("LI, AMY" next to an ICN) are accepted there (2026-08-29,
  // desktop-redactor safety pass). The three-character floor stays for any
  // caller that is not anchored: state codes and org abbreviations are
  // already excluded by PII_ORG_WORDS either way.
  const addName = (t) => { if (t && t.length >= 2 && !PII_ORG_WORDS.has(t.toUpperCase())) nameTokens.add(t); };
  let m;
  const footerComma = /\b([A-Z][A-Za-z'\-]{1,})\s*,\s+([A-Z][A-Za-z'\-]{1,})(?:\s+[A-Z]\b\.?)?(?=\s*(?:ICN\b|Page\b|\d+\s+of\s+\d+))/g;
  while ((m = footerComma.exec(text)) !== null) { addName(m[1]); addName(m[2]); }
  const footerPlain = /\b([A-Z][A-Za-z'\-]{1,})\s+([A-Z][A-Za-z'\-]{1,})(?=\s+\d+\s+of\s+\d+)/g;
  while ((m = footerPlain.exec(text)) !== null) { addName(m[1]); addName(m[2]); }
  return nameTokens;
}

// ── Personal phone / email discovery (2026-08-29, owner default 2) ────────
// Conservative by design: redact clear personal contact details while
// keeping the VA's own PUBLIC contact information readable. Guards:
//   - toll-free prefixes (800/888/877/866/855/844/833) stay: every VA
//     letter prints 1-800-827-1000 and friends as public help lines;
//   - TDD/relay 711 stays;
//   - emails at va.gov (any subdomain) stay: agency inboxes are public.
// Formats accepted for phones are the unambiguous 10-digit shapes
// ((xxx) xxx-xxxx, xxx-xxx-xxxx, xxx.xxx.xxxx, optional +1/1- prefix), so
// regulation cites, docket numbers, dates, and money can never match.
const PII_TOLL_FREE = new Set(['800', '888', '877', '866', '855', '844', '833']);
const PII_PHONE_RE = /(?:\+?1[-.\s]?)?(?:\((\d{3})\)\s?|(\d{3})[-.])(\d{3})[-.](\d{4})\b/g;
const PII_EMAIL_RE = /\b[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)\b/g;

function redactPersonalPhones(text, label) {
  return String(text).replace(PII_PHONE_RE, (whole, a1, a2) => {
    const area = a1 || a2;
    if (PII_TOLL_FREE.has(area)) return whole;
    return label;
  });
}

function redactPersonalEmails(text, label) {
  return String(text).replace(PII_EMAIL_RE, (whole, domain) => {
    const d = String(domain).toLowerCase();
    if (d === 'va.gov' || d.endsWith('.va.gov')) return whole;
    return label;
  });
}

// ── Dependents-table name discovery ──────────────────────────────────────
// VA award letters print a dependents TABLE ("Type of Dependent | Name |
// Effective Date") with the name printed BEFORE the date, after a type word
// (e.g. "Child   Marcus    Feb 17, 1995"), the mirror image of the
// year-then-name dependent-prose rule in strip-letter-pii.js. Fires ONLY
// when a dependents cue word appears within the 300 characters preceding the
// match, so ordinary prose ("child support payments", "the child attending
// school") never triggers it (lowercase "child" also never matches the
// capitalized type-word list below, a second, cheaper guard for the same
// cases). Returns a Set of name tokens the same way findFooterNameTokens
// does, so callers redact them the same way (stripLetterPII: replace loop;
// redactPII: spans on the original text).
const DEPENDENT_TYPE_WORD_SRC = '(?:Child|Spouse|Stepchild|Parent|Helpless Child)';
const DEPENDENT_CUE_RE = /\bdependent/i;

function findDependentNameTokens(text) {
  const tokens = new Set();
  if (!text) return tokens;
  const re = new RegExp(
    '\\b' + DEPENDENT_TYPE_WORD_SRC + '\\s+([A-Z][A-Za-z\'\\-]{2,})(?:\\s+([A-Z][A-Za-z\'\\-]{2,}))?',
    'g'
  );
  let m;
  while ((m = re.exec(text)) !== null) {
    const windowStart = Math.max(0, m.index - 300);
    const before = text.slice(windowStart, m.index);
    if (!DEPENDENT_CUE_RE.test(before)) continue;

    const first = m[1];
    if (first && !PII_ORG_WORDS.has(first.toUpperCase())) tokens.add(first);

    const second = m[2];
    if (second) {
      const secondUpper = second.toUpperCase();
      if (!PII_ORG_WORDS.has(secondUpper) && !PII_MONTH_TOKENS.has(secondUpper)) tokens.add(second);
    }
  }
  return tokens;
}

// ── Fused-token detection ────────────────────────────────────────────────
// OCR sometimes glues a PII label onto a preceding word ("recordSSN123456789")
// or glues a label straight onto its digit run with no space at all, so the
// word-boundary anchors on the plain rules never see a boundary to latch
// onto. This pass works token-by-token (whitespace-delimited) and fires ONLY
// on a recognized label fragment followed by a digit run, or an unlabeled
// digit run that is EXACTLY 9 digits. Never on a bare digit run alone, that
// is how currency, dockets, zip+4 and phone numbers stay untouched. Moved
// here from strip-letter-pii.js (Phase 3) so redact-pii.js can reuse the
// exact same detection logic as spans, byte-identical classification.
const FUSED_ICN_RE = /(ICN)[:#\-]*(\d{6,11}V\d{5,7})/i;
const FUSED_LABEL_RE = /(SSN|SS#|SOCIAL|EDIPI|DOD|FILE)[:#\-]*(\d[\d:#\-\s]{3,}\d|\d{6,})/i;
const FUSED_UNLABELED_SSN_RE = /\d{3}([-\s])\d{2}\1\d{4}|\d{9}/;

// A label fragment matched at index 0 of the token, or preceded by a
// non-letter character (digit, #, :, -, ...), is trusted as-is (case
// insensitive). A label fragment matched PAST index 0 with a LETTER
// immediately before it is a substring hit inside an ordinary lowercase word
// ("profile", "filed") unless the matched fragment itself is entirely
// uppercase, i.e. a real case break like "recordSSN123456789". That is the
// only case such a match may fire.
function fusedLabelAllowed(token, matchIndex, labelFragment) {
  if (matchIndex <= 0) return true;
  const precedingChar = token[matchIndex - 1];
  if (!/[A-Za-z]/.test(precedingChar)) return true;
  return labelFragment === labelFragment.toUpperCase();
}

// Used by strip-letter-pii.js: replaces fused tokens in place, returns the
// mutated string. Behavior unchanged from before the Phase 3 move.
function redactFusedTokens(s) {
  return s.replace(/\S+/g, (token) => {
    const hasLetter = /[A-Za-z]/.test(token);
    const hasDigit = /\d/.test(token);
    if (!hasLetter || !hasDigit) return token;

    const icnMatch = token.match(FUSED_ICN_RE);
    if (icnMatch && fusedLabelAllowed(token, icnMatch.index, icnMatch[1])) {
      return token.slice(0, icnMatch.index) + '[ID REDACTED]' + token.slice(icnMatch.index + icnMatch[0].length);
    }

    const labelMatch = token.match(FUSED_LABEL_RE);
    if (labelMatch && fusedLabelAllowed(token, labelMatch.index, labelMatch[1])) {
      const label = labelMatch[1].toUpperCase();
      const replacement = (label === 'SSN' || label === 'SS#' || label === 'SOCIAL')
        ? '[SSN REDACTED]'
        : '[FILE# REDACTED]'; // EDIPI, DOD, FILE
      return token.slice(0, labelMatch.index) + replacement + token.slice(labelMatch.index + labelMatch[0].length);
    }

    // Unlabeled: fire ONLY when the token's digits, once separators are
    // stripped, total EXACTLY 9 (the SSN shape) and no label fragment is
    // present. A docket number (8 digits), a zip+4 (broken by a hyphen into
    // 5+4), or any other stray digit run must not satisfy this.
    const digitsOnly = token.replace(/\D/g, '');
    if (digitsOnly.length === 9) {
      const unlabeledMatch = token.match(FUSED_UNLABELED_SSN_RE);
      if (unlabeledMatch) {
        return token.slice(0, unlabeledMatch.index) + '[SSN REDACTED]' + token.slice(unlabeledMatch.index + unlabeledMatch[0].length);
      }
    }

    return token;
  });
}

// Used by redact-pii.js: same detection logic as redactFusedTokens above,
// but returns SPANS on the ORIGINAL text instead of mutating a string, so
// the span-priority engine in redact-pii.js can consume them like any other
// pattern match. Same regexes, same guard function, same fire conditions as
// redactFusedTokens, so both redactors stay behaviorally consistent (same
// tokens detected, same classification) by construction.
function findFusedTokenSpans(text) {
  const spans = [];
  const tokenRe = /\S+/g;
  let tm;
  while ((tm = tokenRe.exec(text)) !== null) {
    const token = tm[0];
    const tokenStart = tm.index;
    const hasLetter = /[A-Za-z]/.test(token);
    const hasDigit = /\d/.test(token);
    if (!hasLetter || !hasDigit) continue;

    const icnMatch = token.match(FUSED_ICN_RE);
    if (icnMatch && fusedLabelAllowed(token, icnMatch.index, icnMatch[1])) {
      spans.push({
        start: tokenStart + icnMatch.index,
        end: tokenStart + icnMatch.index + icnMatch[0].length,
        type: 'icn',
        replacement: '[ICN]',
      });
      continue;
    }

    const labelMatch = token.match(FUSED_LABEL_RE);
    if (labelMatch && fusedLabelAllowed(token, labelMatch.index, labelMatch[1])) {
      const label = labelMatch[1].toUpperCase();
      const isSsn = (label === 'SSN' || label === 'SS#' || label === 'SOCIAL');
      spans.push({
        start: tokenStart + labelMatch.index,
        end: tokenStart + labelMatch.index + labelMatch[0].length,
        type: isSsn ? 'ssn' : 'edipi', // EDIPI, DOD, FILE all classify as edipi
        replacement: isSsn ? '[SSN]' : '[EDIPI]',
      });
      continue;
    }

    const digitsOnly = token.replace(/\D/g, '');
    if (digitsOnly.length === 9) {
      const unlabeledMatch = token.match(FUSED_UNLABELED_SSN_RE);
      if (unlabeledMatch) {
        spans.push({
          start: tokenStart + unlabeledMatch.index,
          end: tokenStart + unlabeledMatch.index + unlabeledMatch[0].length,
          type: 'ssn',
          replacement: '[SSN]',
        });
      }
    }
  }
  return spans;
}

module.exports = {
  PII_ORG_WORDS,
  ICN_BARE_SRC,
  ICN_LABELED_SRC,
  escapeRegExp,
  findFooterNameTokens,
  findDependentNameTokens,
  redactFusedTokens,
  findFusedTokenSpans,
  fusedLabelAllowed,
  redactPersonalPhones,
  redactPersonalEmails,
};
