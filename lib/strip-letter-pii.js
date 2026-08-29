// Patterns shared with the client-side "Show me it's safe" preview in
// public/js/letter-safe-preview.js. Keep the two in sync: if you change a
// pattern here, change it there so the preview stays truthful.
const PII_STATES = 'AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC';
const PII_ADDR_SUFFIX = 'Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Court|Ct|Way|Circle|Cir|Place|Pl|Terrace|Ter|Highway|Hwy|Parkway|Pkwy|Trail|Trl|Square|Sq';
// Word-gap is letters only (no digits/periods) so regulation citations like
// "38 CFR 4.130. Dr" are not mistaken for a "<num> ... Drive" address.
const PII_STREET_RE = new RegExp('\\b\\d{1,6}\\s+(?:[A-Za-z\'-]+\\s+){1,4}(?:' + PII_ADDR_SUFFIX + ')\\b\\.?(?:,?\\s+(?:Apt|Suite|Ste|Unit|#)\\.?\\s*\\w+)?', 'gi');
const PII_CITYSTATEZIP_RE = new RegExp('\\b[A-Z][A-Za-z.\'-]+(?:\\s+[A-Z][A-Za-z.\'-]+)*,?\\s+(?:' + PII_STATES + ')\\s+\\d{5}(?:-\\d{4})?\\b', 'g');

// VA-specific shared knowledge (org denylist, fused-token detection, footer
// name discovery) now lives in va-pii-rules.js so redact-pii.js can reuse
// the exact same rules (docs/2026-08-04-pii-hardening-plan.md, Half B).
const { PII_ORG_WORDS, findFooterNameTokens, findDependentNameTokens, redactFusedTokens } = require('./va-pii-rules');

function escapeRegExp(x) { return String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// ── Unlabeled-DOB expansion helpers ───────────────────────────────────────
// If (and only if) the letter labels a DOB somewhere (numeric or written
// month), capture that value and redact every OTHER occurrence of it,
// in common date-format variants, anywhere else in the text. If the letter
// never labels a DOB, there is nothing to expand from and dates survive,
// same limit as the reference project (it asks the user; we do not, per the
// hardening plan's no-user-input-regression rule).
const PII_MONTHS_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const PII_MONTHS_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const PII_MONTH_LOOKUP = (() => {
  const map = {};
  PII_MONTHS_FULL.forEach((name, i) => { map[name.toLowerCase()] = i + 1; });
  PII_MONTHS_ABBR.forEach((abbr, i) => { map[abbr.toLowerCase()] = i + 1; });
  map.sept = 9;
  return map;
})();
// Order matters: longer alternatives (Sept, full names) must come before
// their shorter prefixes (Sep) or the regex engine stops short.
const PII_MONTH_MATCH_ALT = PII_MONTHS_FULL.concat(['Sept'], PII_MONTHS_ABBR).join('|');

function buildDobLabelRegex() {
  return new RegExp(
    '\\b(date of birth|DOB|born)[:\\s]*(' +
      '\\d{1,2}[\\/\\-]\\d{1,2}[\\/\\-]\\d{2,4}' + // numeric, e.g. 03/15/1975
      '|(?:' + PII_MONTH_MATCH_ALT + ')\\.?\\s+\\d{1,2},?\\s+\\d{4}' + // Month D, YYYY
      '|\\d{1,2}\\s+(?:' + PII_MONTH_MATCH_ALT + ')\\.?,?\\s+\\d{4}' + // D Month YYYY
    ')',
    'gi'
  );
}

function pad2(n) { return String(n).padStart(2, '0'); }

// Parses the exact three shapes buildDobLabelRegex()'s group 2 can capture.
// Returns { month, day, year } (year always 4-digit) or null if it does not
// recognize the shape, in which case expansion is skipped rather than guessed.
function parseDobValue(raw) {
  if (!raw) return null;
  let m = raw.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (m) {
    const month = parseInt(m[1], 10);
    const day = parseInt(m[2], 10);
    let year = parseInt(m[3], 10);
    if (m[3].length === 2) year = year >= 50 ? 1900 + year : 2000 + year;
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return { month, day, year };
  }
  m = raw.match(/^([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m) {
    const month = PII_MONTH_LOOKUP[m[1].toLowerCase()];
    if (!month) return null;
    return { month, day: parseInt(m[2], 10), year: parseInt(m[3], 10) };
  }
  m = raw.match(/^(\d{1,2})\s+([A-Za-z]+)\.?,?\s+(\d{4})$/);
  if (m) {
    const month = PII_MONTH_LOOKUP[m[2].toLowerCase()];
    if (!month) return null;
    return { month, day: parseInt(m[1], 10), year: parseInt(m[3], 10) };
  }
  return null;
}

function expandDobVariants(parsed) {
  const { month, day, year } = parsed;
  const yy = pad2(year % 100);
  const monthFull = PII_MONTHS_FULL[month - 1];
  const monthAbbr = PII_MONTHS_ABBR[month - 1];

  const variants = new Set();

  // Numeric: every combination of unpadded/padded month, unpadded/padded
  // day, 4-digit/2-digit year, across both common separators. Padded and
  // unpadded forms collapse into the same string once month/day >= 10,
  // the Set below is what dedupes that for free.
  const monthForms = [String(month), pad2(month)];
  const dayForms = [String(day), pad2(day)];
  const yearForms = [String(year), yy];
  const separators = ['/', '-'];
  for (const sep of separators) {
    for (const m of monthForms) {
      for (const d of dayForms) {
        for (const y of yearForms) {
          variants.add(`${m}${sep}${d}${sep}${y}`);
        }
      }
    }
  }
  // ISO.
  variants.add(`${year}-${pad2(month)}-${pad2(day)}`);

  // Written month, in full / abbreviated / abbreviated-with-period form,
  // each with unpadded and padded day, comma and no-comma, and both
  // "Month Day Year" and "Day Month Year" orderings.
  const monthNames = [monthFull, monthAbbr, `${monthAbbr}.`];
  for (const monthName of monthNames) {
    for (const d of dayForms) {
      variants.add(`${monthName} ${d}, ${year}`);
      variants.add(`${monthName} ${d} ${year}`);
      variants.add(`${d} ${monthName} ${year}`);
    }
  }

  return [...variants];
}

// Redact personally identifying details before any text reaches the AI.
// Tuned to real VA decision-letter anatomy: the veteran's name prints with no
// salutation, repeated in an all-caps "LAST, FIRST M" footer next to an ICN on
// every page. We anchor on that footer, then redact those name tokens
// everywhere, which also clears the header copy of the name. Regex-based and
// not guaranteed exhaustive, but covers the structured PII these letters emit.
function stripLetterPII(s) {
  if (!s) return '';
  let out = s;

  // Numeric identifiers.
  // Fused-token pass FIRST: catches OCR-glued labels/digits a \b anchor
  // cannot see (design decision 5 / gotcha 2, must land before every
  // \b-anchored rule below so a fused case is not half-consumed by a
  // looser rule and left with a stray label prefix).
  out = redactFusedTokens(out);
  // Bare SSN: tightened to require EITHER a consistent 3-2-4 separator
  // (same separator character reused, so "12345-6789" cannot be read as a
  // 5-4 zip+4 pretending to be a 3-2 then a 4) OR exactly 9 contiguous
  // digits with no separator at all.
  out = out.replace(/\b\d{3}([-\s])\d{2}\1\d{4}\b|\b\d{9}\b/g, '[SSN REDACTED]');           // SSN
  out = out.replace(/\b\d{9,11}V\d{5,7}\b/g, '[ID REDACTED]');                              // ICN / participant ID
  out = out.replace(/\b(ICN|integrated control number)[:#\s]*[\dV]{6,}/gi, '$1: [ID REDACTED]');
  // Capture the labeled DOB value BEFORE it is redacted, so it can be
  // expanded into format variants and redacted everywhere else too.
  let dobValue = null;
  const dobCaptureMatch = buildDobLabelRegex().exec(out);
  if (dobCaptureMatch) dobValue = dobCaptureMatch[2];
  out = out.replace(buildDobLabelRegex(), '$1: [DOB REDACTED]');
  out = out.replace(/\b(VA file(?:\s*number)?|file number|claim number|EDIPI)[:\s#]*\d[\d\-\s]{4,}\d/gi, '$1: [FILE# REDACTED]');
  // Unlabeled-DOB expansion: only runs if a labeled DOB existed somewhere.
  if (dobValue) {
    const parsed = parseDobValue(dobValue);
    if (parsed) {
      for (const variant of expandDobVariants(parsed)) {
        out = out.replace(new RegExp('\\b' + escapeRegExp(variant) + '\\b', 'gi'), '[DOB REDACTED]');
      }
    }
  }

  // Address.
  out = out.replace(PII_STREET_RE, '[ADDRESS REDACTED]');
  out = out.replace(PII_CITYSTATEZIP_RE, '[ADDRESS REDACTED]');

  // Veteran name: VA letters print the name in a repeated page footer, either
  // "LAST, FIRST M" next to the ICN, or "FIRST LAST" right before "N of N".
  // findFooterNameTokens (va-pii-rules.js) collects name tokens ONLY from
  // those footer-anchored spots, so ordinary "Word, Word" comma pairs in the
  // evidence list and prose are never mistaken for a name. Redact the
  // collected tokens everywhere (incl. the header) with our own replace loop.
  const nameTokens = findFooterNameTokens(out);
  // Dependents-TABLE name discovery (name printed BEFORE the date, after a
  // type word, e.g. "Child   Marcus    Feb 17, 1995"): union into the same
  // token set so collected dependent names are wiped everywhere, including
  // the prose repeat ("Marcus has been added to your award...").
  for (const tok of findDependentNameTokens(out)) nameTokens.add(tok);
  for (const tok of nameTokens) {
    out = out.replace(new RegExp('\\b' + escapeRegExp(tok) + '\\b', 'gi'), '[NAME REDACTED]');
  }
  // Drop an orphaned middle initial left between the redacted name and the
  // ICN / page marker in the repeated footer (e.g. "[NAME] J ICN: ...").
  out = out.replace(/(\[NAME REDACTED\][\s,]*)[A-Z]\b\.?(?=\s*(?:ICN\b|Page\b|\d+\s+of\s+\d+))/g, '$1');

  // Salutation / titled names (letters that DO use "Dear Mr. X").
  out = out.replace(/\b(Dear)\s+(?:Mr\.?|Mrs\.?|Ms\.?|Mx\.?|Dr\.?)?\s*[A-Z][A-Za-z'.\-]+(?:\s+[A-Z][A-Za-z'.\-]+){0,2}/g, '$1 [NAME REDACTED]');
  out = out.replace(/\b(?:Mr|Mrs|Ms|Mx)\.?\s+[A-Z][A-Za-z'.\-]+(?:\s+[A-Z][A-Za-z'.\-]+){0,2}/g, '[NAME REDACTED]');

  // Dependent name printed after a dependent-context date line.
  out = out.replace(/((?:dependent\(s\)|dependents)[\s\S]{0,140}?\b\d{4}\s+)([A-Z][A-Za-z'\-]{2,})/gi, function (mm, pre, nm) {
    return PII_ORG_WORDS.has(nm.toUpperCase()) ? mm : (pre + '[NAME REDACTED]');
  });

  return out;
}

module.exports = { stripLetterPII, PII_ORG_WORDS, escapeRegExp };
