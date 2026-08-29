# Handback: Open PII Extractor Safety and Correctness Fixes

**Date:** 2026-08-29
**Handoff:** `CLAUDE-OPEN-PII-EXTRACTOR-SAFETY-FIXES-HANDOFF-2026-08-29.md`
**Status:** Implemented and verified locally. Nothing staged, committed, pushed, or distributed; version bump to 1.0.0 rides the commit Eric approves.

## 1. Starting point

`fed02d3` (HEAD = origin/master), working tree exactly as the handoff's final rescan recorded: `M README.md` (Eric-directed versioning note, preserved, untouched by this pass beyond riding the eventual commit), untracked handoff file and `test/roundtrip-out.pdf` (preserved).

## 2. Files changed

**Core:** `main.js` (rewritten), `lib/limits.js` (new), `lib/terms.js` (new), `lib/local-ocr.js`, `lib/local-ocr-worker.js`, `lib/build-redacted-pdf.js`, `lib/strip-letter-pii.js` + `lib/va-pii-rules.js` (synced from platform), `preload.js`.
**Renderer:** `renderer/app.js`, `renderer/safe-preview.js`, `renderer/index.html`.
**Tests:** `test/safety.test.js` (new), `test/electron-smoke.test.js` (new), `test/app-guards.test.js`, `test/pii-redaction.test.js` (synced, 66 tests).
**Docs:** this handback; `SYNC.md` update rides the commit.
**Installer/package:** `package.json` (electron 44, electron-builder 26.15, `overrides.tar`, package excludes, pngjs to runtime deps), `package-lock.json` (regenerated clean).

## 3. Owner decisions applied (handoff §20, per Eric's "go")

1. **Oversize input:** whole-input rejection with the limit named. No slicing anywhere.
2. **Phone/email/short names:** conservative automatic coverage, platform-first (see §12 below).
3. **Offline wording:** precise no-upload/no-cloud/no-telemetry copy replaces "cannot use the internet".

## 4. Findings: before -> after

- **§5 truncation:** `slice(0, MAX_CHARS)` success paths and the dead `redacted.length > MAX_CHARS` check are gone; the complete source is measured BEFORE redaction; over-limit paste and over-limit batch return named errors; every rejection clears staged buffers and redaction metadata (renderer `clearStagedState`), so no stale result can be exported. Test-pinned at source level and behaviorally.
- **§6 OCR page cap:** `if (pageNum > MAX_PDF_PAGES) break` replaced by whole-file rejection (`page_limit`, limit named, file identified), enforced in the WORKER (renderer bypass covered), with an in-loop guard as depth defense. 11-page synthetic scanned PDF rejects; 10-page succeeds with 10 layout pages.
- **§7 mixed PDFs:** whole-document average replaced by per-page classification (route digital / scanned / blank per page). Minimum-safe implementation chosen: any non-blank page without digital text routes the ENTIRE file through OCR, so no page can skip processing. Blank pages are PROVEN blank from raster ink (0.1% dark-pixel floor), never assumed from low text - this matters because Eric's real letter carries three genuinely blank pages. Headless test replicates the classifier on a mixed fixture.
- **§8 per-page OCR quality:** best-page confidence replaced by every-non-blank-page enforcement with page-number-specific failure messages ("We couldn't read page 2..."), order-independent (tested both orders); blank page tested separately from noise page.
- **§9 limits:** `lib/limits.js` centralizes files/file-bytes/batch-bytes/OCR-pages/digital-pages/image-pixels/chars/layout-pages/layout-bytes. Main re-validates every IPC payload (types, sizes, magic-byte sniff vs claimed kind - deceptive extensions refused); dialog lost "All files"; count checks run BEFORE reads (drag-drop pre-read count check included); reads are async (`fs.promises`).
- **§9A terms gate:** blocking first-launch screen with the exact handoff checkbox label and responsibility notice; unchecked box, disabled Accept, Decline-and-exit, Escape suppressed, no backdrop/X; acceptance stores ONLY `{version, acceptedAt}` in userData; version change re-gates; malformed/future-dated records fail closed; **enforcement lives in the main process** - every privileged handler refuses before acceptance (runtime-proven, see smoke). Persistent reminder ("Review every page before sharing...") sits inside the save-actions row for all three output modes.
- **§10 sandbox + senders:** `app.enableSandbox()` + `sandbox: true`; every privileged handler flows through one `guard()` that first validates `event.senderFrame.url` against the exact renderer file URL, then the terms gate, then argument shapes. The misleadingly named test was renamed and extended; the RUNTIME proof is `test/electron-smoke.test.js`, which boots the real app (fresh temp userData) and asserts `process.sandboxed === true` in the live renderer, refusal before acceptance, and working redaction after.
- **§11 WinAnsi crashes:** the sanitizer is now a NUMERIC allowlist (code-point comparisons, zero escape sequences that a hook/quoting layer could collapse - a lesson re-learned in this very pass when two escape layers ate my regexes); all five confirmed C1 holes pinned plus a mixed-junk case; a source-level test asserts zero raw control bytes in the file. All three save paths wrap failures into `{ saved:false, error }` (main) and visible button feedback with `.catch` (renderer).
- **§13 offline copy:** badge and footer now use the precise wording; a pin fails if the absolute claim returns. The technical defenses are unchanged.

## 5. §12 platform-first rule changes (RateMyVSO_Platform working tree)

- `src/lib/pii/va-pii-rules.js`: `redactPersonalPhones` (unambiguous 10-digit shapes only; toll-free 800/888/877/866/855/844/833 and 711 preserved), `redactPersonalEmails` (all except `va.gov` / `*.va.gov`), and the footer name floor lowered to 2 characters INSIDE the trusted footer anchors only (`LI, AMY` + ICN now redacts; bare state codes untouched via PII_ORG_WORDS + no anchor).
- `src/lib/pii/strip-letter-pii.js`: applies both after the identifier rules; new labels `[PHONE REDACTED]` / `[EMAIL REDACTED]`.
- `public/js/letter-safe-preview.js`: label regexes + display names extended (site preview stays truthful).
- `tests/pii-redaction.test.js`: the obsolete "phones out of scope" pin replaced with the new contract + guards (66/66). Unformatted 10-digit runs stay out of scope deliberately (collision-prone) - this limitation is disclosed, not hidden.
- Synced verbatim into the app (`lib/`, `test/pii-redaction.test.js` repointed); app label sets extended in `renderer/safe-preview.js` and `lib/redaction-spans.js`.
- **These platform files remain uncommitted in RateMyVSO_Platform** (with the earlier spaced-ICN fix); they ship to the website through the normal site process when Eric says so.

## 6. §14 packaging gate

- **Electron 33.4.11 (EOL) -> 44.0.0 (current stable), electron-builder -> 26.15.3.** The full suite including the runtime smoke passes on 44, which exercises sandboxed preload IPC, the OCR child under `ELECTRON_RUN_AS_NODE`, and the terms gate. pdf.js rendering/fonts and the three save paths are covered by the dev-app run for Eric's manual check; NSIS + portable rebuilt on 44.
- **Dependency audit: 0 vulnerabilities, dev and runtime trees**, from a clean reinstall. Root cause traced: `pdf-to-img -> pdfjs-dist -> canvas (optional)` pulled `@mapbox/node-pre-gyp` + `tar@6` (install-time tooling, not app runtime code). Fixed with `overrides.tar = ^7.5.22` + a regenerated lockfile, plus electron-builder file EXCLUDES for `@mapbox/node-pre-gyp`, stray `tar`, and `canvas/build` so the tooling never ships in the artifact regardless.
- Packaged-artifact inventory and hashes are reported in chat with the final 1.0.0 build.

## 7. Test commands and counts

- `npm test` (six suites): **90 tests, 90 pass, 0 fail** - includes the live Electron smoke (~8s boot).
- Platform: `node --test tests/pii-redaction.test.js`: **66/66**.

### 7a. Codex post-verification finding (2026-08-29, test-only)

Codex passed the product and flagged one test-only issue: `test/electron-smoke.test.js` launched `node_modules/.bin/electron.cmd` with `shell: true`, which Node 24 warns about as DEP0190 (shell-interpreted arguments). Correction applied exactly as specified: the launcher now uses the binary path exported by `require('electron')` with `shell: false`. No product file changed. Final rerun: **90/90 pass, zero DEP0190 (or any other) warnings in the output.**

## 8. Synthetic fixture inventory

`test/fixture-letter.png` (synthetic letter, no real PII), generated-at-test-time: noise page PNG, white page PNG, 10/11-page image PDFs, mixed digital+scanned PDF, QR codes (qrcode package), C1/junk strings. No real letter or derived fixture is in git.

## 9. Remaining limitations (disclosed)

- Scanned-PDF cap stays 10 pages (explicit rejection now); digital cap 60 pages.
- Unformatted 10-digit phone runs and exotic phone formats are not auto-redacted (tap still works).
- A QR too damaged for jsQR to decode is not boxed and produces no warning (region detection without decode was assessed as unreliable); the review reminder and terms notice carry that risk disclosure.
- Renderer per-page classifier is replicated headlessly in tests, not driven through the real DOM (Electron UI automation would be the next step if wanted).

## 10-12. Boundary confirmations

Unrelated dirty/untracked files untouched (`README.md` staged edit preserved; `test/roundtrip-out.pdf` preserved). Nothing staged, committed, pushed, or distributed. Terms-gate behavior proof: runtime smoke facts (fresh profile gated, main-process refusal, post-acceptance redaction) + the dev app relaunched on a profile with no acceptance so Eric sees the gate live; screenshots deferred to Eric's own first-launch since the gate is interactive.
