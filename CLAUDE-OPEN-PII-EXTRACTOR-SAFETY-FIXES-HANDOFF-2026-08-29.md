# Claude Handoff: Open PII Extractor Safety and Correctness Fixes

**Date:** 2026-08-29  
**Repository:** `C:\Users\eleac\open-pii-extractor`  
**Prepared by:** Codex, after a read-only rescan  
**Implementation owner:** Claude  
**Status:** Ready for owner-directed implementation after the active installer lane is stable

## 1. Purpose

Harden the Open PII Extractor against incomplete redaction, incomplete PDF output, misleading success states, renderer compromise, unsupported input, and export crashes.

This is not a cosmetic redesign. The highest-priority fixes prevent the app from silently processing only part of a document while presenting the result as complete.

## 2. Hard boundaries

1. Re-read this file completely before editing.
2. Re-run `git status --short --branch` and `git log -3 --oneline --decorate` immediately before starting. The repository was changing during review.
3. Preserve all unrelated modified and untracked files.
4. Do not delete, overwrite, clean, or absorb `test/roundtrip-out.pdf`; it was already untracked at the final rescan.
5. Installer work was still in progress during the earlier review. Do not mix speculative installer rewrites into the core correctness pass.
6. Redaction-rule changes follow `SYNC.md`: change the RateMyVSO Platform source first, test there, then sync the approved files into this repository and update the sync record.
7. Use synthetic test data only. Do not add a real Veteran's letter, real PII, or a derived real-letter fixture to Git.
8. Do not weaken a failing assertion to make the suite green. Fix the behavior the assertion protects.
9. Nothing is to be staged, committed, pushed, published, or distributed without Eric's specific approval for that action.

## 3. Verified checkpoint at the final rescan

### Git

```text
## master...origin/master
M  README.md
?? CLAUDE-OPEN-PII-EXTRACTOR-SAFETY-FIXES-HANDOFF-2026-08-29.md
?? test/roundtrip-out.pdf
```

`README.md` became staged by separate ongoing work after the safety rescan. Codex did not edit or stage it. Preserve it exactly and do not include it in this safety pass unless Eric separately places it in scope.

Current local commit:

```text
fed02d3 Word-level span diff + fused-name floor + public-URL filter +
repeat-token promotion + QR boxing ... suites 74/74
```

`origin/master` advanced to `fed02d3` after the initial safety rescan. The handoff file itself is the only file Codex created.

### Tests

Fresh command:

```powershell
npm test
```

Fresh result:

```text
74 tests
74 pass
0 fail
```

The earlier surname leak in the original-layout export was fixed by `fed02d3`. Do not reopen it as an unfixed finding. Preserve its tests.

### Dependency audit

Fresh command:

```powershell
npm audit --omit=dev --json
```

Fresh result:

- 1 critical vulnerability
- 1 high vulnerability
- Both are in the `tar` / `@mapbox/node-pre-gyp` dependency path represented in the current lockfile.

This belongs in the packaging gate described in Section 11. Do not run `npm audit fix --force` blindly.

## 4. Priority order

Implement in this order:

1. **P0: eliminate every silent partial-document success path**
2. **P0: classify and process PDFs per page, or fail the entire file safely**
3. **P0: make OCR confidence and page failures page-specific and fail closed**
4. **P1: add input count, type, size, page-count, and IPC payload limits**
5. **P1: add the mandatory first-launch terms checkbox and main-process acceptance gate**
6. **P1: enable the Electron process sandbox and validate every IPC sender**
7. **P1: fix PDF export character crashes and error propagation**
8. **P1 owner decision: add conservative phone/email coverage and short-name coverage**
9. **P2: make the offline claim match what is mechanically enforced**
10. **Separate packaging gate: supported Electron and dependency remediation**

The P0 items should block public distribution. A green 74-test suite does not currently cover them.

## 5. P0 finding: the 120,000-character cap silently truncates content

### Current evidence

`main.js` currently does this for pasted text:

```js
findRedactedSpans(body.text.trim().slice(0, MAX_CHARS))
```

It does this for file-derived text:

```js
findRedactedSpans(original.slice(0, MAX_CHARS))
```

It then checks:

```js
if (redacted.length > MAX_CHARS)
```

That check cannot detect an over-limit source after the source was already sliced. The app can therefore report success after discarding everything after character 120,000.

### Why this is dangerous

- Pasted text after the cap disappears with no warning.
- Plain-text export contains only the truncated result.
- For a large digital PDF, the original-layout export can still render every original page while its auto-redaction spans came only from the first 120,000 characters. PII on later pages can remain visible in the exported PDF.
- The user is told to review a result that is not clearly identified as partial.

### Required behavior

Choose one complete behavior, never a partial success:

1. **Recommended v1:** measure the complete source before redaction and reject the entire input with a clear message if it exceeds the supported character budget; or
2. Process the entire input in bounded chunks while preserving page boundaries and proving every chunk completed.

Do not use `slice(0, MAX_CHARS)` as a successful processing path.

When any input is rejected or incomplete:

- return a structured error;
- clear stale prior results and stale layout metadata;
- disable every save/export control;
- name the affected file and the exact reason;
- do not allow an original-layout PDF export from partial span data.

### Required tests

1. Pasted text of `MAX_CHARS + 1` characters must produce an explicit error, not a truncated preview.
2. A synthetic over-limit document with a labeled SSN after character 120,000 must never return success.
3. A multi-file batch whose combined extracted text exceeds the cap must fail the entire batch or process every byte using a proven chunk contract.
4. After a successful preview, submit an over-limit input and prove the old result cannot still be saved.
5. Prove the `redacted.length > MAX_CHARS` dead check is removed or made reachable by checking the unsliced source.

## 6. P0 finding: scanned PDFs over 10 pages are silently shortened

### Current evidence

`lib/local-ocr-worker.js` contains:

```js
const MAX_PDF_PAGES = 10;
...
if (pageNum > MAX_PDF_PAGES) break;
```

There is no error or incomplete flag when page 11 exists. The first ten pages can be returned as a successful result.

With original-layout export, this can also create a PDF containing only the first ten pages while looking like a completed redacted copy.

### Required behavior

Never silently break.

**Recommended v1:** reject a scanned or OCR-routed PDF above the supported page cap before showing a redacted result. The message must say the page limit and identify the file. The worker must independently enforce the same limit even if renderer validation is bypassed.

Batch processing beyond ten pages is acceptable only if every page has an explicit completion state and export is impossible until all pages finish.

### Required tests

1. Synthetic 11-page scanned PDF: explicit rejection, no partial text, no partial layout, no save controls.
2. Synthetic 10-page scanned PDF: complete success with ten layout pages.
3. Worker-level test bypassing the renderer: page 11 still causes failure.
4. Batch containing a valid file plus an 11-page file: define and test all-or-nothing behavior. Recommended default is all-or-nothing.

## 7. P0 finding: mixed PDFs are classified using a whole-document average

### Current evidence

`renderer/app.js` joins all PDF page text and calculates:

```js
const avgPerPage = fullText.length / Math.max(1, pdf.numPages);
return { text: fullText, isImageOnly: avgPerPage < 80 };
```

A three-page PDF with two text-rich digital pages and one scanned page can exceed the average threshold. The entire file is then treated as digital even though the scanned page produced no extracted text and received no OCR.

### Required behavior

Classify each page.

For every PDF page, record at least:

```text
page number
digital text character count
route: digital or OCR
OCR confidence if used
processing status
layout/raster status
```

Two acceptable implementations:

1. **Minimum safe implementation:** if any page falls below the digital-text threshold, OCR the entire PDF; or
2. **Preferred implementation:** use digital extraction for text pages and OCR only the scanned pages, then restore the original page order.

The preferred implementation is faster, but the minimum implementation is acceptable if it is simpler and all pages are proven complete.

### Required tests

1. Three-page mixed fixture: digital page, scanned page containing synthetic PII, digital page.
2. The scanned page's PII must be absent from preview and from an OCR-after-export round trip.
3. Page order must remain 1, 2, 3.
4. A single text-heavy page must not hide an unreadable page elsewhere in the file.
5. A PDF page extraction exception must fail the file, not convert the exception into a silent empty page.

## 8. P0 finding: OCR quality uses the best page, not every page

### Current evidence

`lib/local-ocr-worker.js` currently tracks:

```js
let bestConfidence = 0;
bestConfidence = Math.max(bestConfidence, confidence);
```

The final check uses `bestConfidence`. One excellent page can make a multi-page PDF pass even if another page is unreadable.

### Required behavior

Track results per page. Do not call the file complete merely because one page was good.

Recommended policy:

- Require every nonblank OCR-routed page to meet the minimum confidence and minimum readable-text rule.
- Return page-number-specific failure details.
- If blank-page handling is allowed, define and test how a page is proven blank. Do not assume low OCR text means blank.
- Disable export when any required page failed.

### Required tests

1. Two-page PDF with high-confidence page 1 and low-confidence page 2 containing synthetic PII must not return clean success.
2. Low-confidence page 1 plus high-confidence page 2 must behave identically.
3. Test an intentionally blank page separately from an unreadable image page.
4. Verify the UI names the failed page and file without displaying its extracted PII.

## 9. P1 finding: input and IPC payloads are not bounded early enough

### Current evidence

- `main.js` open dialog includes an `All files` option.
- `open-files` reads selected files synchronously and converts each whole file to base64 with `fs.readFileSync`.
- The dialog silently keeps only the first five paths.
- Drag/drop calls `await file.arrayBuffer()` for every dropped file before the five-file slice in `stageAndPreview` takes effect.
- Unsupported files are ignored instead of producing a clear error.
- `save-layout-pdf` accepts an unbounded page/image array from the renderer.
- IPC handlers do not apply a shared schema or payload budget.

### Required behavior

Define and centralize limits for:

- maximum files per batch;
- maximum bytes per file;
- maximum total bytes per batch;
- maximum PDF pages;
- maximum decoded image dimensions and pixel count;
- maximum pasted characters;
- maximum layout-export page count and total raster bytes.

Validate before full reads or base64 conversion whenever possible.

Also:

1. Reject more than five files explicitly before reading any of them.
2. Remove `All files`, or retain it only if unsupported formats are explicitly rejected with a visible message.
3. Validate extension plus file signature/magic where practical.
4. Use asynchronous reads rather than blocking `readFileSync` on the main process.
5. Validate all IPC argument types and sizes again in the main process. Renderer checks are not a security boundary.
6. Clear staged state on every validation failure.

### Required tests

- six-file dialog path and six-file drag/drop path;
- oversized PDF, oversized image, and oversized total batch;
- deceptive extension with wrong magic bytes;
- unsupported type;
- huge image dimensions with modest compressed bytes;
- over-limit `save-layout-pdf` IPC payload;
- stale-result clearing after every rejection.

## 9A. P1 requirement: mandatory first-launch terms acceptance

The app must not be usable until the user affirmatively accepts a local responsibility notice. This is a real acceptance gate, not a passive paragraph in the footer.

### Required first-launch behavior

1. On the first launch for a Windows user profile, show a blocking terms screen before the file picker, drag/drop area, paste field, OCR, redaction, copy, or save controls can be used.
2. The acceptance checkbox starts unchecked.
3. The **Accept and continue** button stays disabled until the user personally checks the box.
4. Do not treat scrolling, closing the window, opening a file, or continued use as acceptance.
5. Provide a **Decline and exit** button. Declining closes the application without processing anything.
6. The terms screen cannot be dismissed with Escape, a backdrop click, an X button, or navigation around it.
7. Store only the acceptance terms version and local acceptance timestamp in the app's user-data directory. Do not add telemetry, an account, a device identifier, or any network call.
8. Re-prompt whenever `TERMS_VERSION` changes. Do not re-prompt on every launch when the accepted version still matches.
9. Treat a missing, malformed, or future/unknown acceptance record as not accepted.
10. Enforce acceptance in the main process. Do not rely only on a hidden renderer panel or localStorage. Until acceptance is valid, privileged IPC handlers for opening, redacting, copying/exporting, saving, and revealing files must reject the request.

### Exact proposed checkbox label

```text
I have read and accept these terms. I understand that this tool provides an automated first pass only, and I am responsible for personally reviewing every page and every redaction before I save, share, send, print, or upload the result.
```

### Proposed responsibility notice

Use clear language substantially equivalent to the following. Eric may revise the wording before release, and counsel may review it without changing the required behavior.

```text
Important: You must verify the result

Open PII Extractor is an automated aid. It can miss personal information, misread a document, remove information that is not personal, or produce an incomplete result if a file is damaged or unsupported.

You are responsible for reviewing every page of the original document and every page of the redacted output before saving, sharing, sending, printing, or uploading it. Do not rely on a black box, removed-text label, preview, or success message without checking the finished file yourself.

You are responsible for identifying and correcting anything the tool missed or removed incorrectly. RateMyVSO.net and Open PII Extractor do not guarantee that a document is complete, accurate, anonymous, compliant with any law or policy, or safe to disclose.

This tool is provided for general informational and document-assistance purposes. It is not legal advice, privacy advice, records-management advice, or a substitute for professional review when the document is sensitive or disclosure could cause harm.

All document processing is intended to occur on this computer. The app does not require an account, cloud OCR, or document upload. You should still protect the original and redacted files using appropriate device, storage, and transmission security.
```

Do not use a prechecked box, vague text such as `By continuing`, or a single button that combines acknowledgment without an explicit checkbox.

### Persistent reminders after acceptance

Acceptance on first launch does not replace an operational warning at the point of use.

Keep a concise reminder beside the save/export controls:

```text
Review every page before sharing. Automatic redaction can miss information or remove the wrong text.
```

The reminder must remain visible for text, plain-PDF, and original-layout PDF output. Do not hide it only in Terms, Help, or an About screen.

### Accessibility requirements

- Use a real heading and labeled checkbox.
- Associate the complete checkbox text with the input.
- Put initial keyboard focus on the terms heading or first meaningful control.
- Maintain a logical Tab order between the checkbox, local terms/details control if present, Decline, and Accept.
- Announce why Accept is disabled.
- Meet color contrast and visible-focus requirements in light and dark themes.
- Do not require a mouse.
- At 320px width and 200% zoom, all terms remain readable with no horizontal scrolling or clipped controls.

### Required tests

1. Fresh user-data directory shows the gate before the app can process a document.
2. Checkbox is unchecked and Accept is disabled.
3. Clicking Accept without checking does nothing.
4. Checking the box enables Accept; accepting stores only terms version and timestamp.
5. Restart with the current accepted version opens the app normally.
6. Incrementing `TERMS_VERSION` shows the gate again.
7. Decline exits and stores no acceptance.
8. Escape, backdrop click, and direct renderer manipulation cannot bypass the gate.
9. Direct IPC invocation before acceptance is rejected by the main process.
10. Malformed or tampered acceptance state fails closed and shows the gate.
11. Acceptance works by keyboard and screen reader.
12. The save-area review reminder is present for all three output modes.
13. No acceptance action produces network traffic.

## 10. P1 finding: renderer sandbox is explicitly disabled and IPC senders are not validated

### Current evidence

`main.js` uses:

```js
contextIsolation: true,
nodeIntegration: false,
sandbox: false,
```

`test/app-guards.test.js` calls its test `renderer is sandboxed from Node`, but it asserts only `contextIsolation: true` and `nodeIntegration: false`. It does not assert the Chromium OS process sandbox. The test name currently overstates what it proves.

Every privileged handler currently accepts messages without validating `event.senderFrame`, including:

- `redact`
- `open-files`
- `save-text`
- `reveal`
- `save-layout-pdf`
- `save-pdf`

Installed Electron at rescan:

```text
electron@33.4.11
```

Electron 33 is end-of-life. Electron's current official security guidance recommends process sandboxing, a current Electron version, and sender validation for all IPC messages.

Official references:

- https://www.electronjs.org/docs/latest/tutorial/security
- https://www.electronjs.org/docs/latest/tutorial/sandbox
- https://releases.electronjs.org/schedule
- https://releases.electronjs.org/release/v33.4.11

### Required behavior

1. Remove `sandbox: false` and explicitly set `sandbox: true`, or enforce `app.enableSandbox()` before the ready event.
2. Verify the preload bridge still works in the sandbox.
3. Add one shared `validateSender(frame)` helper using a parsed, exact allowlist for the packaged local application origin.
4. Reject every untrusted frame before any file read, write, dialog, shell action, OCR job, or export.
5. Validate handler arguments after sender validation.
6. Make the test name and assertions accurate.

### Required tests

1. Source guard rejects `sandbox: false` and requires sandbox enablement.
2. Runtime Electron smoke test proves `process.sandboxed === true` in the renderer.
3. Trusted main frame can invoke every intended API.
4. Synthetic untrusted child frame cannot invoke any privileged API.
5. Invalid `reveal` and save/export arguments are rejected.

Do not rely only on regex searches of source files for these runtime properties.

## 11. P1 finding: plain-text PDF export can crash on C1 control characters

### Current evidence

`lib/build-redacted-pdf.js` allows the Latin-1 range through this sanitizer:

```js
s.replace(/[\t\v\f]/g, ' ').replace(/[^\x20-\x7E -ÿ]/g, '?')
```

Some C1 control characters are within that broad range but are not encodable by pdf-lib's WinAnsi font.

Fresh direct probes all threw `WinAnsi cannot encode`:

```text
U+0081
U+008D
U+008F
U+0090
U+009D
```

The generic `wireSave` promise chain in `renderer/safe-preview.js` has no `.catch(...)`, so a failed text/PDF save can also become an unhandled rejection with no useful user recovery.

### Required behavior

1. Sanitize against an explicit WinAnsi-encodable allowlist or use a font/encoding path that supports the intended Unicode range.
2. Remove or replace all unsupported C0/C1 controls while preserving line breaks intentionally.
3. Wrap every save handler in `main.js` and return `{ saved: false, error: <safe message> }` on failure.
4. Add catch/error handling to text, plain-PDF, and layout-PDF save controls.
5. Never include raw document text or PII in logs or user-facing exception details.

### Required tests

1. One pin for each of the five code points above.
2. Mixed OCR text containing tabs, C1 controls, smart punctuation, accented Latin text, and non-Latin glyphs.
3. Simulated disk-write failure and PDF-builder failure.
4. Button state returns to normal after the error and retry succeeds.

## 12. P1 owner decision: phone, email, and short-name coverage

### Confirmed active behavior

The desktop app calls `stripLetterPII`, not the more broadly patterned `redactPII` output path.

Fresh direct probes:

```text
Phone: 703-555-1234       -> unchanged
Email: veteran@example.com -> unchanged
```

The test suite explicitly calls an unlabeled ten-digit phone number out of scope.

Short footer names also have a known floor in the shared rules:

```text
COX, JOHN ... -> both names redacted
LI, AMY ...   -> LI remains visible
```

### Recommended owner default

Add conservative, high-confidence support for:

- labeled personal phone numbers;
- standard email addresses;
- two-character names when they appear in an already-trusted name context such as a VA footer, salutation, or dependent-name structure.

Do not broadly remove every phone-shaped or two-letter token. Preserve false-positive guards for regulation numbers, docket numbers, organization abbreviations, state codes, dates, money, and public VA contact information.

Because these are shared redaction rules:

1. implement and test them in the RateMyVSO Platform source first;
2. obtain the normal product review there;
3. sync the exact approved files here;
4. update `SYNC.md` with the source commit;
5. prove text preview and original-layout PDF parity.

If Eric declines automatic phone/email handling, the app must state the exclusion prominently before export. The recommended fix is support, not silent exclusion.

### Required tests

- labeled and unlabeled personal phone variants;
- email with plus tag and subdomain;
- public VA phone/email false-positive decisions explicitly locked;
- `LI`, `NG`, `YU`, `COX`, hyphenated names, and apostrophe names in trusted contexts;
- short state/organization tokens remain untouched outside trusted name contexts;
- OCR-after-export proves the accepted short names, phones, and emails cannot be recovered.

## 13. P2 finding: the absolute offline claim is stronger than the current enforcement proof

### Current evidence

The UI says:

```text
100% offline. This app cannot use the internet.
```

Current defenses are useful:

- renderer `webRequest` cancellation;
- restrictive CSP with `connect-src 'none'`;
- denied permission requests;
- denied new windows and non-file navigation;
- bundled OCR language data.

However, the `session.webRequest` hook constrains renderer-session requests. It is not a general operating-system firewall and does not mechanically prove that Node code in the Electron main process or a dependency can never create network traffic.

### Recommended owner default

Use precise copy unless a real main-process egress control is added and runtime-tested:

```text
All document processing happens on this computer. The app does not upload your files, use cloud OCR, require an account, or send telemetry.
```

Keep the existing technical defenses. If the absolute `cannot use the internet` claim is retained, Claude must add enforceable main-process network restrictions and packaged runtime tests that cover Node/Electron networking paths.

### Required tests

- renderer fetch/XHR/WebSocket attempt blocked;
- navigation and new-window attempt blocked;
- main-process `http`, `https`, `fetch`, Electron `net`, DNS, and raw socket attempts handled according to the claimed policy;
- OCR completes using bundled language data with the machine offline;
- no document bytes, text, filenames, or metadata appear in any request capture.

## 14. Separate packaging gate: Electron and dependency remediation

This section should not be mixed casually into the active installer changes.

### Electron

Electron 33.4.11 is end-of-life. At the rescan date, Electron 44 was the current stable major and 42 through 44 were supported. Follow Electron's recommendation to migrate one major at a time, reviewing breaking changes and running packaged smoke tests at each meaningful step.

Do not merely change the version range and assume compatibility. Verify:

- sandboxed preload IPC;
- OCR child process with `ELECTRON_RUN_AS_NODE`;
- PDF.js rendering and embedded VA fonts;
- native canvas/pdf-to-img packaging;
- NSIS and portable builds;
- install/uninstall, launch, file dialogs, all three save paths, and offline behavior.

### Dependency audit

Trace the current `tar` and optional `@mapbox/node-pre-gyp` paths from the lockfile and packaged artifact. Determine what actually ships, what is build-only, and which parent dependency update removes the vulnerable versions.

Acceptance gate:

- no unexplained critical or high `npm audit` result;
- no vulnerable `tar` version in the shipped application or installer dependency tree;
- clean-install audit and packaged-artifact inventory attached to the handback;
- no `--force` upgrade without a documented compatibility review.

Relevant advisories reported by the fresh audit include:

- https://github.com/advisories/GHSA-23hp-3jrh-7fpw
- https://github.com/advisories/GHSA-34x7-hfp2-rc4v
- https://github.com/advisories/GHSA-8x88-c5mf-7j5w

## 15. Original-layout and QR regression coverage to preserve and extend

Preserve the `fed02d3` protections:

- word-level redaction-span recovery;
- repeated-token promotion;
- public URL filtering;
- embedded-font render behavior;
- QR boxing;
- the real-letter-derived assertions that contain no real PII;
- adversarial OCR of the finished image-only PDF.

Add synthetic coverage for:

1. punctuation immediately adjacent to every redaction label;
2. repeated headers/footers across 1, 10, and 21 pages;
3. short names and fused short-name headers;
4. two QR codes, rotated QR, small QR, low-contrast QR, and a deliberately undecodable code;
5. an undecodable QR must produce a review warning if the app can detect a QR-like region but cannot decode it;
6. every exported page has no text layer;
7. no source page is missing from the export;
8. no source page is exported unless its redaction analysis completed;
9. ordinary prose and public `va.gov` addresses remain readable;
10. box coverage remains bounded so a parser error cannot black out most of a page unnoticed.

The app should continue to tell the user that automatic redaction is a first pass and requires visual review.

## 16. Suggested implementation architecture

### A. One authoritative per-file result

Return a structured object rather than loose text plus optional layout:

```js
{
  fileName,
  status: 'complete' | 'rejected' | 'failed',
  pageCount,
  pages: [
    {
      pageNumber,
      route: 'digital' | 'ocr',
      status: 'complete' | 'failed',
      text,
      confidence,
      layout,
      warnings: []
    }
  ],
  redactedText,
  redactionSpans,
  warnings: []
}
```

Only `status: complete` may enable save/export.

### B. Avoid approximate security metadata where practical

`findRedactedSpans` currently reconstructs removed originals by diffing original and redacted text. The current implementation is now tested and green, but this remains an inferred security boundary.

Preferred durable direction: have the shared platform redactor emit structured redaction metadata directly, including raw range, normalized value, and type. Then sync that authoritative output into this app. Keep the diff path only if it remains necessary and adversarially tested.

Typed spans would also let the exporter safely treat a two-character surname differently from a common two-letter prose token.

### C. Fail closed

If any page is truncated, skipped, unreadable, over-limit, missing layout, or fails export preparation:

- mark the entire file incomplete;
- do not show a generic success state;
- do not enable original-layout export;
- explain what the user can do next.

## 17. Proportional verification plan

### Focused unit tests

- redaction rules and false-positive guards;
- character-limit rejection;
- page-limit rejection;
- per-page classification;
- per-page confidence;
- WinAnsi/control-character handling;
- input schemas and limits;
- trusted IPC sender helper.

### Integration tests

- paste, dialog, and drag/drop paths;
- digital, scanned, and mixed PDFs;
- photo input;
- multi-file batch;
- text, plain-PDF, and original-layout PDF saves;
- failed input after prior success;
- failed save followed by retry.

### Adversarial output tests

For synthetic fixtures, re-open and OCR the finished original-layout PDF. Assert:

- all synthetic PII is absent;
- all pages are present and ordered;
- ordinary prose survives;
- no text layer exists;
- public VA URLs survive unless manually removed;
- QR payloads are no longer decodable where boxing succeeded.

### Packaged Windows smoke test

After the separate installer/dependency phase:

- fresh NSIS install in a non-default location;
- portable executable;
- launch under a standard user account;
- offline first launch;
- open, OCR, review, tap-remove, and all save modes;
- restart and uninstall;
- no unexpected network request;
- no console error or unhandled promise rejection.

## 18. Acceptance criteria

The handback may say PASS only when all are true:

1. No input is silently truncated.
2. No PDF page is silently skipped.
3. Mixed PDFs process every page.
4. One good OCR page cannot conceal one failed page.
5. No incomplete file enables export.
6. Input and IPC payloads have explicit limits and visible failures.
7. First launch is blocked by an unchecked terms checkbox, affirmative acceptance, a Decline-and-exit path, versioned local persistence, and main-process IPC enforcement.
8. The review reminder remains visible beside all save/export modes after acceptance.
9. Renderer process sandbox is actually enabled and runtime-proven.
10. Every privileged IPC handler validates sender and arguments.
11. The five confirmed C1 characters cannot crash PDF export.
12. Save failures are visible and recoverable.
13. Phone/email/short-name scope is either implemented with false-positive guards or explicitly disclosed by owner decision.
14. Offline copy matches enforcement and runtime evidence.
15. Current 74 tests remain green, plus the new pins.
16. Synthetic round-trip tests prove PII absence in the exported PDF.
17. Installer/dependency work has its own evidence and no unresolved critical/high shipped vulnerability.

## 19. Required handback

Claude's handback must include:

1. Exact commit/Git state used as the starting point.
2. Exact files changed, grouped as core, renderer, tests, docs, and installer/package.
3. Every owner decision and the behavior selected.
4. Before/after reproduction for each confirmed finding.
5. Full test commands and exact pass/fail counts.
6. Synthetic fixture inventory.
7. Packaged smoke-test evidence if packaging was in scope.
8. `npm audit` and dependency-path results if packaging was in scope.
9. Any remaining limitation, especially unsupported page counts, file sizes, phone/email rules, short names, QR detection, or OCR confidence.
10. Confirmation that unrelated dirty and untracked files were untouched.
11. Confirmation that nothing was staged, committed, pushed, or distributed unless Eric separately approved that exact action.
12. Screenshot and behavior proof of the first-launch terms gate, persisted acceptance, version re-prompt, Decline-and-exit path, and the persistent save-area review reminder.

## 20. Three decisions to surface to Eric only if not already locked

Use these recommended defaults if Eric says to proceed without further narrowing:

1. **Oversize files:** reject the entire file with a clear limit; never return a partial result.
2. **Phone/email/short names:** add conservative automatic coverage in trusted contexts, platform-first.
3. **Offline wording:** use precise no-upload/no-cloud/no-telemetry wording unless main-process egress is mechanically blocked and runtime-proven.
