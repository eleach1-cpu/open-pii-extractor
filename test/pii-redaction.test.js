/* PII redaction pinning suite (Phase 1 of docs/2026-08-04-pii-hardening-plan.md).
 *
 * Pins CURRENT behavior of the two redactors before any behavior change.
 * All fixtures are SYNTHETIC: invented names, invented numbers. Never text
 * from a real letter or from either third-party reference repo named in
 * docs/2026-08-04-pii-redaction-ocr-gaps.md.
 *
 * Known-gap cases (fused OCR tokens, unlabeled DOB repeats, redactPII's
 * missing ICN/footer-name coverage) are written as { todo: true } tests that
 * assert the DESIRED future behavior. They do not fail this suite; Phase 2
 * and Phase 3 flip them live.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { stripLetterPII } = require('../lib/strip-letter-pii');
const { redactPII, PATTERNS } = require('../lib/redact-pii');

// The only six token labels stripLetterPII may ever emit. The client-side
// "Show me it's safe" preview (public/js/letter-safe-preview.js) parses this
// exact literal set; a new label renders as plain, unstyled text there.
const ALLOWED_TOKENS = new Set([
  '[SSN REDACTED]',
  '[ID REDACTED]',
  '[DOB REDACTED]',
  '[FILE# REDACTED]',
  '[ADDRESS REDACTED]',
  '[NAME REDACTED]',
]);

function tokensIn(s) {
  return s.match(/\[[^\]]+\]/g) || [];
}

// ── stripLetterPII: pinned current behavior ──────────────────────────────

test('stripLetterPII: SSN both separator forms', () => {
  assert.strictEqual(stripLetterPII('123-45-6789'), '[SSN REDACTED]');
  assert.strictEqual(stripLetterPII('123 45 6789'), '[SSN REDACTED]');
});

test('stripLetterPII: ICN bare and labeled', () => {
  assert.strictEqual(stripLetterPII('1234567890V123456'), '[ID REDACTED]');
  assert.strictEqual(stripLetterPII('ICN: 1234567890V123456'), 'ICN: [ID REDACTED]');
});

test('stripLetterPII: labeled DOB, both date forms', () => {
  assert.strictEqual(stripLetterPII('DOB: 01/02/1980'), 'DOB: [DOB REDACTED]');
  // "date of birth" label form: the shared label group is echoed back lowercase
  // followed by a literal colon inserted by the replacement (current behavior).
  assert.strictEqual(stripLetterPII('date of birth 1-2-80'), 'date of birth: [DOB REDACTED]');
});

test('stripLetterPII: VA file / claim number / EDIPI labeled forms', () => {
  assert.strictEqual(stripLetterPII('VA file number 12345678'), 'VA file number: [FILE# REDACTED]');
  assert.strictEqual(stripLetterPII('EDIPI 1234567890'), 'EDIPI: [FILE# REDACTED]');
  // SURPRISE (pinned, not "fixed"): the bare SSN pattern runs BEFORE the
  // claim-number rule and a 9-digit run with no separators also satisfies
  // the SSN shape, so a bare "claim number: 123456789" is consumed as an
  // SSN, not a FILE#. Documented here rather than silently asserting the
  // "intended" FILE# outcome.
  assert.strictEqual(stripLetterPII('claim number: 123456789'), 'claim number: [SSN REDACTED]');
});

test('stripLetterPII: street address and city/state/zip', () => {
  assert.strictEqual(stripLetterPII('123 Main Street'), '[ADDRESS REDACTED]');
  assert.strictEqual(stripLetterPII('Springfield, IL 62704'), '[ADDRESS REDACTED]');
});

test('stripLetterPII: CFR citation is never mistaken for an address', () => {
  assert.strictEqual(stripLetterPII('38 CFR 4.130. Dr'), '38 CFR 4.130. Dr');
});

test('stripLetterPII: footer name discovery redacts everywhere, incl. header, with orphan-initial cleanup', () => {
  const fixture = 'Header mentions DOE and JOHN in the salutation area.\n' +
    'DOE, JOHN Q ICN: 1234567890V123456';
  const out = stripLetterPII(fixture);
  assert.strictEqual(
    out,
    'Header mentions [NAME REDACTED] and [NAME REDACTED] in the salutation area.\n' +
    '[NAME REDACTED], [NAME REDACTED]  ICN: [ID REDACTED]'
  );
  // No stray middle-initial "Q" left dangling before the ICN marker.
  assert.ok(!/\bQ\b/.test(out), 'orphaned middle initial "Q" must be cleaned up');
});

test('stripLetterPII: footer plain "First Last N of N" form redacts both tokens', () => {
  assert.strictEqual(stripLetterPII('John Doe 1 of 6'), '[NAME REDACTED] [NAME REDACTED] 1 of 6');
});

test('stripLetterPII: org words and state codes are never name-redacted', () => {
  assert.strictEqual(stripLetterPII('VETERANS AFFAIRS'), 'VETERANS AFFAIRS');
  assert.strictEqual(stripLetterPII('Filed with the VA regional office'), 'Filed with the VA regional office');
});

test('stripLetterPII: salutation forms', () => {
  assert.strictEqual(stripLetterPII('Dear Mr. Smith'), 'Dear [NAME REDACTED]');
  assert.strictEqual(stripLetterPII('Mr. Smith'), '[NAME REDACTED]');
});

test('stripLetterPII: dependent-name rule redacts the name printed after the year', () => {
  const out = stripLetterPII('dependent(s) added ... 2020 Janedoe');
  assert.strictEqual(out, 'dependent(s) added ... 2020 [NAME REDACTED]');
});

test('stripLetterPII: token pin, only the six documented labels ever appear', () => {
  const fixtures = [
    '123-45-6789', '1234567890V123456', 'ICN: 1234567890V123456',
    'DOB: 01/02/1980', 'date of birth 1-2-80',
    'VA file number 12345678', 'claim number: 123456789', 'EDIPI 1234567890',
    '123 Main Street', 'Springfield, IL 62704',
    'DOE, JOHN Q ICN: 1234567890V123456',
    'John Doe 1 of 6', 'Dear Mr. Smith', 'Mr. Smith',
    'dependent(s) added ... 2020 Janedoe',
    'SSN123456789', 'recordSSN123456789', 'SSN:123-45-6789',
    'recordICN1234567890V123456 text', 'recordEDIPI1234567890 text',
    'EDIPI:1234567890', 'fileICN1234567890V123456',
    'date of birth: March 15, 1975',
    'DOB: 03/15/1975 later the letter says March 15, 1975 again',
  ];
  for (const f of fixtures) {
    for (const tok of tokensIn(stripLetterPII(f))) {
      assert.ok(ALLOWED_TOKENS.has(tok), `unexpected token label "${tok}" from fixture ${JSON.stringify(f)}`);
    }
  }
});

test('stripLetterPII: empty and null input', () => {
  assert.strictEqual(stripLetterPII(''), '');
  assert.strictEqual(stripLetterPII(null), '');
  assert.strictEqual(stripLetterPII(undefined), '');
});

// ── stripLetterPII: fused tokens + unlabeled DOB (Phase 2, flipped live) ──

test('stripLetterPII: fused SSN with no word boundary ("SSN123456789") redacts', () => {
  assert.strictEqual(stripLetterPII('SSN123456789'), '[SSN REDACTED]');
});

test('stripLetterPII: fused ICN glued to a preceding word redacts', () => {
  // Bare "ICN1234567890V123456" already redacted before this change (the
  // labeled ICN regex allows zero characters between the label and the
  // digits). The genuine gap was an OCR fusion onto the PRECEDING word,
  // which breaks the \b before "ICN".
  assert.strictEqual(stripLetterPII('recordICN1234567890V123456 text'), 'record[ID REDACTED] text');
});

test('stripLetterPII: fused EDIPI glued to a preceding word redacts', () => {
  // Same shape as the ICN case above: bare "EDIPI1234567890" already
  // redacted before this change; gluing it to a preceding word (no space)
  // breaks the leading \b.
  assert.strictEqual(stripLetterPII('recordEDIPI1234567890 text'), 'record[FILE# REDACTED] text');
});

test('stripLetterPII: unlabeled repeat of a labeled DOB also redacts', () => {
  const out = stripLetterPII('DOB: 03/15/1975 later the letter says March 15, 1975 again');
  assert.ok(!/March 15, 1975/.test(out), 'the unlabeled repeat of the labeled DOB should be redacted too');
  assert.strictEqual(out, 'DOB: [DOB REDACTED] later the letter says [DOB REDACTED] again');
});

// ── stripLetterPII: Phase 2 additional fused-token positive cases ────────

test('stripLetterPII: fused SSN glued to a preceding word, with internal separators', () => {
  assert.strictEqual(stripLetterPII('recordSSN123456789'), 'record[SSN REDACTED]');
});

test('stripLetterPII: labeled SSN with colon and hyphenated digits fused into one token', () => {
  const out = stripLetterPII('SSN:123-45-6789');
  assert.strictEqual(out, '[SSN REDACTED]');
  assert.strictEqual(tokensIn(out).length, 1);
});

test('stripLetterPII: fused EDIPI standalone (no preceding word)', () => {
  assert.strictEqual(stripLetterPII('EDIPI:1234567890'), '[FILE# REDACTED]');
});

test('stripLetterPII: fused ICN glued to a preceding word (different word than the todo case)', () => {
  assert.strictEqual(stripLetterPII('fileICN1234567890V123456'), 'file[ID REDACTED]');
});

// ── stripLetterPII: fused-label case-break guard (repair, defect verified live) ─

test('stripLetterPII: "file" inside an ordinary word ("profile123456") is not treated as a fused FILE# label', () => {
  const out = stripLetterPII('profile123456');
  assert.ok(!/\[FILE# REDACTED\]/.test(out));
});

test('stripLetterPII: "filed20260804" is untouched by the label rule', () => {
  assert.strictEqual(stripLetterPII('filed20260804'), 'filed20260804');
});

test('stripLetterPII: real case-break fused SSN still redacts (regression guard on the fix)', () => {
  assert.strictEqual(stripLetterPII('recordSSN123456789'), 'record[SSN REDACTED]');
});

test('stripLetterPII: capitalized ordinary word ("Profile123456") is not treated as a fused FILE# label', () => {
  const out = stripLetterPII('Profile123456');
  assert.ok(!/\[FILE# REDACTED\]/.test(out));
});

test('stripLetterPII: uppercase FILE# fused mid-token after a case break still redacts', () => {
  assert.strictEqual(stripLetterPII('caseFILE#123456789'), 'case[FILE# REDACTED]');
});

// ── stripLetterPII: written-month labeled DOB (extension made in Phase 2) ─

test('stripLetterPII: labeled DOB accepts a written-out month, not just numeric', () => {
  assert.strictEqual(stripLetterPII('date of birth: March 15, 1975'), 'date of birth: [DOB REDACTED]');
});

test('stripLetterPII: unlabeled DOB expansion also catches a written-month repeat when the label used numeric form', () => {
  const out = stripLetterPII('DOB 3/15/1975 ... March 15, 1975 ... 03-15-1975 ... 1975-03-15');
  assert.ok(!/March 15, 1975/.test(out));
  assert.ok(!/03-15-1975/.test(out));
  assert.ok(!/1975-03-15/.test(out));
});

// ── stripLetterPII: unlabeled DOB expansion, missing combos (repair) ─────

test('stripLetterPII: unlabeled DOB expansion catches M/D/YY 2-digit-year repeat', () => {
  const out = stripLetterPII('DOB: 03/15/1975 later 3/15/75');
  assert.ok(!/3\/15\/75/.test(out));
});

test('stripLetterPII: unlabeled DOB expansion catches MM-DD-YY repeat', () => {
  const out = stripLetterPII('DOB: 03/15/1975 later 03-15-75');
  assert.ok(!/03-15-75/.test(out));
});

test('stripLetterPII: unlabeled DOB expansion catches written month with no comma', () => {
  const out = stripLetterPII('DOB: 03/15/1975 later March 15 1975');
  assert.ok(!/March 15 1975/.test(out));
});

test('stripLetterPII: unlabeled DOB expansion catches Day Month Year order', () => {
  const out = stripLetterPII('DOB: 03/15/1975 later 15 March 1975');
  assert.ok(!/15 March 1975/.test(out));
});

test('stripLetterPII false-positive guard: without any labeled DOB, a bare M/D/YY date survives untouched', () => {
  assert.strictEqual(stripLetterPII('appointment on 3/15/75'), 'appointment on 3/15/75');
});

// ── stripLetterPII: Phase 2 false-positive guards ─────────────────────────

test('stripLetterPII false-positive guard: currency survives untouched', () => {
  assert.strictEqual(stripLetterPII('$1,234,567.89'), '$1,234,567.89');
});

test('stripLetterPII false-positive guard: a BVA docket number survives', () => {
  assert.strictEqual(stripLetterPII('A24051002'), 'A24051002');
});

test('stripLetterPII false-positive guard: a zip+4 (9 digits, 5-4 grouping) survives', () => {
  assert.strictEqual(stripLetterPII('12345-6789'), '12345-6789');
});

test('stripLetterPII false-positive guard: a legit labeled claim number is not double-redacted', () => {
  const out = stripLetterPII('claim number: 123-45-6789');
  assert.strictEqual(tokensIn(out).length, 1);
});

test('stripLetterPII false-positive guard: a regulation citation with digits survives', () => {
  assert.strictEqual(stripLetterPII('38 CFR 4.130'), '38 CFR 4.130');
});

test('stripLetterPII false-positive guard: a 10-digit phone-shaped number without a label survives (no phone rule, out of scope)', () => {
  assert.strictEqual(stripLetterPII('703-555-1234'), '703-555-1234');
  assert.strictEqual(stripLetterPII('7035551234'), '7035551234');
});

test('stripLetterPII false-positive guard: a plain prose date survives when no labeled DOB exists anywhere', () => {
  assert.strictEqual(stripLetterPII('The hearing was held on March 15, 1975 at the regional office.'),
    'The hearing was held on March 15, 1975 at the regional office.');
});

// ── stripLetterPII: dependents-TABLE name discovery (fix, 2026-08-04) ────
// VA award letters print a dependents table with the name printed BEFORE
// the date, after a type word ("Child   Marcus    Feb 17, 1995"), the
// mirror image of the existing year-then-name dependent-prose rule.

test('stripLetterPII: dependents table, all names redacted, type words and dates survive, prose repeat also redacted', () => {
  const fixture =
    'Type of Dependent   Name   Effective Date\n' +
    'Child   Marcus    Feb 17, 1995\n' +
    'Spouse   Thanhmai    Aug 20, 1991\n' +
    'Child   Devon    Jan 9, 2001\n' +
    'Marcus has been added to your award effective Feb 17, 1995.';
  const out = stripLetterPII(fixture);

  assert.ok(!/\bMarcus\b/.test(out), 'Marcus must be redacted everywhere');
  assert.ok(!/\bThanhmai\b/.test(out), 'Thanhmai must be redacted everywhere');
  assert.ok(!/\bDevon\b/.test(out), 'Devon must be redacted everywhere');

  assert.ok(/\bChild\b/.test(out), 'type word "Child" must survive');
  assert.ok(/\bSpouse\b/.test(out), 'type word "Spouse" must survive');

  assert.ok(/Feb 17, 1995/.test(out), 'the date must survive');
  assert.ok(/Aug 20, 1991/.test(out), 'the date must survive');
  assert.ok(/Jan 9, 2001/.test(out), 'the date must survive');

  assert.ok(/\[NAME REDACTED\] has been added to your award/.test(out), 'the prose repeat must be redacted too');
});

test('stripLetterPII dependents-table false positive guard: "child support payments" produces no name redaction', () => {
  const out = stripLetterPII('Type of Dependent table follows. child support payments are unaffected.');
  assert.ok(!/\[NAME REDACTED\]/.test(out));
});

test('stripLetterPII dependents-table false positive guard: "Spouse Benefits are unchanged" produces no name redaction', () => {
  const out = stripLetterPII('Dependents on file: Spouse Benefits are unchanged.');
  assert.ok(!/\[NAME REDACTED\]/.test(out));
});

test('stripLetterPII dependents-table false positive guard: "the child attending school" produces no name redaction', () => {
  const out = stripLetterPII('Dependent status: the child attending school remains eligible.');
  assert.ok(!/\[NAME REDACTED\]/.test(out));
});

test('stripLetterPII dependents-table gate proof: "Child Marcus" with no dependents cue anywhere within 300 chars produces no redaction', () => {
  const out = stripLetterPII('Nothing about dependency here. Child Marcus plays outside.');
  assert.ok(!/\[NAME REDACTED\]/.test(out));
});

test('stripLetterPII dependents-table month guard: "Child Marcus Feb 17, 1995" never redacts "Feb"', () => {
  const out = stripLetterPII('Type of Dependent: Child Marcus Feb 17, 1995');
  assert.ok(/\bFeb\b/.test(out), '"Feb" must survive, never mistaken for a second name token');
  assert.ok(!/\bMarcus\b/.test(out));
});

test('redactPII parity: dependents table names redacted with valid reconstructable offsets', () => {
  const fixture =
    'Type of Dependent   Name   Effective Date\n' +
    'Child   Marcus    Feb 17, 1995\n' +
    'Spouse   Thanhmai    Aug 20, 1991\n' +
    'Child   Devon    Jan 9, 2001';
  const r = redactPII(fixture);
  assert.ok(!/\bMarcus\b/.test(r.redacted_text));
  assert.ok(!/\bThanhmai\b/.test(r.redacted_text));
  assert.ok(!/\bDevon\b/.test(r.redacted_text));

  for (const red of r.redactions) {
    const slice = fixture.slice(red.original_offset, red.original_offset + red.length);
    assert.ok(slice.length > 0, 'sliced span must not be empty');
  }
  const sorted = [...r.redactions].sort((a, b) => a.original_offset - b.original_offset);
  let cursor = 0;
  let rebuilt = '';
  for (const red of sorted) {
    rebuilt += fixture.slice(cursor, red.original_offset);
    rebuilt += '[NAME]';
    cursor = red.original_offset + red.length;
  }
  rebuilt += fixture.slice(cursor);
  assert.strictEqual(rebuilt, r.redacted_text);
});

// ── redactPII: pinned current behavior ───────────────────────────────────

test('redactPII: each of the 9 pattern types fires on a matching fixture', () => {
  const cases = [
    ['SSN: 123-45-6789', 'ssn'],
    ['SSN 123456789 is here', 'ssn'],
    ['VA file C-12-345-678', 'va_file'],
    ['claim no. 123456789', 'claim_no'],
    ['DOB: 01/02/1980', 'dob'],
    ['Veteran: John Q Doe', 'name'],
    ['call (703) 555-1234', 'phone'],
    ['email me at test@example.com', 'email'],
    ['Address: 123 Main Street, Apt 4', 'address'],
    ['ICN: 1234567890V123456', 'icn'],
  ];
  // PATTERNS gained a 9th type ("icn") in Phase 3 (Half B); "edipi" is a
  // 10th type but is emitted only via the fused-token pass, not a PATTERNS
  // entry, so it does not show up in this array.
  const seenTypes = new Set(PATTERNS.map(p => p.type));
  assert.strictEqual(seenTypes.size, 9, 'PATTERNS should declare exactly 9 distinct types');
  for (const [text, type] of cases) {
    const r = redactPII(text);
    assert.ok(r.redactions.some(red => red.type === type), `expected a "${type}" redaction for ${JSON.stringify(text)}, got ${JSON.stringify(r.redactions)}`);
  }
});

test('redactPII: offsets contract, every redaction span slices back to the replaced text', () => {
  const original = 'SSN: 123-45-6789 and DOB: 01/02/1980 and email test@example.com';
  const r = redactPII(original);
  assert.ok(r.redactions.length >= 3);
  for (const red of r.redactions) {
    const slice = original.slice(red.original_offset, red.original_offset + red.length);
    assert.ok(slice.length > 0, 'sliced span must not be empty');
  }
  // Reconstruct: walking spans in original order and splicing tokens must
  // reproduce redacted_text exactly.
  const sorted = [...r.redactions].sort((a, b) => a.original_offset - b.original_offset);
  let cursor = 0;
  let rebuilt = '';
  const tokenByType = { ssn: '[SSN]', dob: 'DOB: [DOB]', email: '[EMAIL]' };
  for (const red of sorted) {
    rebuilt += original.slice(cursor, red.original_offset);
    rebuilt += tokenByType[red.type];
    cursor = red.original_offset + red.length;
  }
  rebuilt += original.slice(cursor);
  assert.strictEqual(rebuilt, r.redacted_text);
});

test('redactPII: overlap priority, the higher-priority (earlier-listed) pattern wins', () => {
  // The "name" pattern's greedy line match would otherwise swallow the whole
  // line including the SSN. Because the guarded 9-digit SSN pattern is
  // earlier in PATTERNS, its span is claimed first and the later, overlapping
  // "name" match is skipped entirely (not trimmed, not both applied).
  const r = redactPII('Name: John Doe SSN 123456789');
  assert.deepStrictEqual(r.redactions.map(x => x.type), ['ssn']);
  assert.strictEqual(r.redacted_text, 'Name: John Doe SSN [SSN]');
});

test('redactPII: non-string and empty input', () => {
  assert.deepStrictEqual(redactPII(''), { redacted_text: '', redactions: [] });
  assert.deepStrictEqual(redactPII(null), { redacted_text: '', redactions: [] });
  assert.deepStrictEqual(redactPII(undefined), { redacted_text: '', redactions: [] });
  // SURPRISE (pinned, not "fixed"): the guard is `!text || typeof text !== 'string'`.
  // For a truthy non-string like a number, `!text` is false, so the fallback
  // `text || ''` keeps the ORIGINAL value (not an empty string). redacted_text
  // is a number here, not the empty-string contract the header implies.
  assert.deepStrictEqual(redactPII(12345), { redacted_text: 12345, redactions: [] });
});

// ── redactPII: gap closures (Phase 3, previously { todo: true }) ─────────

test('redactPII: redacts a bare ICN', () => {
  const r = redactPII('1234567890V123456');
  assert.strictEqual(r.redacted_text, '[ICN]');
});

test('redactPII: discovers a footer-anchored name, not just label lines', () => {
  const r = redactPII('DOE, JOHN Q ICN: 1234567890V123456');
  assert.ok(!/DOE/.test(r.redacted_text) && !/JOHN/.test(r.redacted_text),
    'footer name tokens should be redacted the way stripLetterPII already does it');
});

// GAP PIN (Phase 3 fix, was: '1234567890V123456' -> '[PHONE]V123456'). ICN
// patterns now sit above phone/9-digit-SSN in PATTERNS priority, so the
// bare ICN redacts fully with no leftover "[PHONE]" fragment and no
// leftover "V123456" remnant.
test('redactPII: GAP PIN (fixed), bare ICN redacts fully, no phone misfire, no remnant', () => {
  const r = redactPII('1234567890V123456');
  assert.strictEqual(r.redacted_text, '[ICN]');
  assert.ok(!/\[PHONE\]/.test(r.redacted_text), 'must not contain a leftover [PHONE] fragment');
  assert.ok(!/V123456/.test(r.redacted_text), 'must not contain a leftover V123456 remnant');
  assert.deepStrictEqual(r.redactions.map(x => x.type), ['icn']);
});

// GAP PIN (Phase 3 fix, was: footer names survived unredacted). Now
// discovered via findFooterNameTokens and redacted everywhere in the text.
test('redactPII: GAP PIN (fixed), footer-anchored names are discovered and redacted', () => {
  const r = redactPII('DOE, JOHN Q ICN: 1234567890V123456');
  assert.ok(!/DOE/.test(r.redacted_text), 'DOE must no longer survive');
  assert.ok(!/JOHN/.test(r.redacted_text), 'JOHN must no longer survive');
});

// ── redactPII / stripLetterPII parity (Phase 3) ───────────────────────────
// For each fixture, the raw sensitive value must not survive in EITHER
// redactor's output.

test('parity: fused SSN raw digits absent from both redactors\' output', () => {
  const fixture = 'recordSSN123456789 end';
  assert.ok(!/123456789/.test(stripLetterPII(fixture)));
  assert.ok(!/123456789/.test(redactPII(fixture).redacted_text));
});

test('parity: fused EDIPI raw digits absent from both redactors\' output', () => {
  const fixture = 'recordEDIPI1234567890 end';
  assert.ok(!/1234567890/.test(stripLetterPII(fixture)));
  assert.ok(!/1234567890/.test(redactPII(fixture).redacted_text));
});

test('parity: bare/labeled ICN raw digits absent from both redactors\' output', () => {
  const fixture = 'ICN: 1234567890V123456';
  assert.ok(!/1234567890V123456/.test(stripLetterPII(fixture)));
  assert.ok(!/1234567890V123456/.test(redactPII(fixture).redacted_text));
});

test('parity: footer-discovered name absent from both redactors\' output', () => {
  const fixture = 'Header mentions DOE and JOHN earlier.\nDOE, JOHN Q ICN: 1234567890V123456';
  const strippedOut = stripLetterPII(fixture);
  const redactedOut = redactPII(fixture).redacted_text;
  for (const raw of ['DOE', 'JOHN']) {
    assert.ok(!new RegExp(raw).test(strippedOut), `${raw} must be absent from stripLetterPII output`);
    assert.ok(!new RegExp(raw).test(redactedOut), `${raw} must be absent from redactPII output`);
  }
});

// ── redactPII: offsets contract on the NEW pattern types ─────────────────

test('redactPII: offsets contract holds for ICN + footer name + fused SSN combined', () => {
  const original = 'DOE, JOHN Q ICN: 1234567890V123456 and recordSSN123456789 end';
  const r = redactPII(original);
  assert.ok(r.redactions.length >= 3, `expected at least 3 redactions, got ${r.redactions.length}`);

  // Every span's slice of the ORIGINAL text must be exactly the raw text
  // that got replaced.
  for (const red of r.redactions) {
    const slice = original.slice(red.original_offset, red.original_offset + red.length);
    assert.ok(slice.length > 0, 'sliced span must not be empty');
  }

  // Splicing all spans (in offset order) against the original text must
  // reproduce redacted_text exactly. Reconstruct using the SAME token per
  // type that redactPII itself would have used.
  const tokenByType = { icn: '[ICN]', name: '[NAME]', ssn: '[SSN]', edipi: '[EDIPI]' };
  const sorted = [...r.redactions].sort((a, b) => a.original_offset - b.original_offset);
  let cursor = 0;
  let rebuilt = '';
  for (const red of sorted) {
    rebuilt += original.slice(cursor, red.original_offset);
    assert.ok(red.type in tokenByType, `unexpected redaction type "${red.type}" for this reconstruction`);
    rebuilt += tokenByType[red.type];
    cursor = red.original_offset + red.length;
  }
  rebuilt += original.slice(cursor);
  assert.strictEqual(rebuilt, r.redacted_text);
});

// ── redactPII: type enumeration across every fixture in this file ────────

test('redactPII: every emitted redaction type is in the documented set', () => {
  const DOCUMENTED_TYPES = new Set(['ssn', 'va_file', 'claim_no', 'dob', 'name', 'phone', 'email', 'address', 'icn', 'edipi']);
  const fixtures = [
    'SSN: 123-45-6789', 'SSN 123456789 is here', 'VA file C-12-345-678',
    'claim no. 123456789', 'DOB: 01/02/1980', 'Veteran: John Q Doe',
    'call (703) 555-1234', 'email me at test@example.com',
    'Address: 123 Main Street, Apt 4', 'ICN: 1234567890V123456',
    '1234567890V123456', 'DOE, JOHN Q ICN: 1234567890V123456',
    'recordSSN123456789 end', 'recordEDIPI1234567890 end',
    'Name: John Doe SSN 123456789',
    'DOE, JOHN Q ICN: 1234567890V123456 and recordSSN123456789 end',
    'VETERANS AFFAIRS',
  ];
  const seen = new Set();
  for (const f of fixtures) {
    for (const red of redactPII(f).redactions) seen.add(red.type);
  }
  assert.ok(seen.size > 0, 'at least one redaction type should have fired across the fixture set');
  for (const t of seen) {
    assert.ok(DOCUMENTED_TYPES.has(t), `redaction type "${t}" is not in the documented set`);
  }
});

// ── redactPII: org denylist parity ────────────────────────────────────────

test('redactPII: never name-redacts an org-only footer line ("VETERANS AFFAIRS")', () => {
  const r = redactPII('VETERANS AFFAIRS 1 of 6');
  assert.ok(!r.redactions.some(red => red.type === 'name'), 'org words must never produce a name redaction');
  assert.strictEqual(r.redacted_text, 'VETERANS AFFAIRS 1 of 6');
});

// ── one-definition guard ──────────────────────────────────────────────────

test('PII_ORG_WORDS is defined exactly once, in va-pii-rules.js', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const stripSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'strip-letter-pii.js'), 'utf8');
  const rulesSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'va-pii-rules.js'), 'utf8');
  const definitionRe = /PII_ORG_WORDS\s*=\s*new\s+Set\s*\(/;
  const definedInStrip = definitionRe.test(stripSrc);
  const definedInRules = definitionRe.test(rulesSrc);
  assert.strictEqual(definedInStrip, false, 'strip-letter-pii.js must not define PII_ORG_WORDS, only require it');
  assert.strictEqual(definedInRules, true, 'va-pii-rules.js must define PII_ORG_WORDS');
});

// OCR-split ICN (found 2026-08-29 by the desktop redactor's adversarial
// round trip): Tesseract reads "123456789V123456" with a space after the V,
// and the pre-fix rule order let the bare-SSN rule half-consume the nine
// digits, leaving the "123456" tail readable. The whole spaced form must be
// consumed as ONE ID, in every spacing variant, before any other digit rule.
test('stripLetterPII: OCR-split ICN is consumed whole in all spacing variants', () => {
  for (const t of ['ICN: 123456789V 123456', 'ICN: 123456789 V123456', 'bare 123456789 V 123456 end']) {
    const out = stripLetterPII(t);
    assert.ok(out.includes('[ID REDACTED]'), `${t} -> ${out}: no ID redaction`);
    assert.ok(!/123456/.test(out), `${t} -> ${out}: ICN tail survived`);
  }
});
