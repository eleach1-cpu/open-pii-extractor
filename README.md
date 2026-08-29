# Open PII Extractor

An offline desktop app by RateMyVSO.net that redacts personal information
from VA letters: SSN, date of birth, file numbers, names, addresses, and IDs.
Open a PDF, a photo, or paste text; the app auto-redacts, shows you the
result with "Removed X" labels, lets you tap any additional word to remove
every copy of it, then saves or copies the redacted text.

**Everything happens on your computer.** No uploads, no account, no
telemetry. The app blocks its own network access (`main.js` cancels every
outbound request and denies every permission), and the OCR language data is
bundled so nothing is downloaded at first run.

Auto-redaction is a first pass, not a guarantee: always check the result
yourself before sharing a redacted copy.

## Run from source

```
npm install
node scripts/fetch-tessdata.js   # one-time: bundles the OCR language data
npm start
```

`npm test` runs the redaction-engine suite (plain Node, no Electron needed).

## Build the Windows installer

```
npm run dist
```

Produces an NSIS installer and a portable .exe under `dist/`. Unsigned:
Windows SmartScreen will warn on first run; the download page publishes the
SHA-256 checksum to verify.

## How it decides text vs OCR

Digital PDFs (any VA-portal letter) carry their text; pdf.js extracts it
locally in under a second. A PDF averaging under 80 characters per page is
treated as an image-only scan and rasterized for Tesseract OCR, as are
photos. Same thresholds as the RateMyVSO.net Letter Interpreter.

## Rule sync

The redaction rules are copied from RateMyVSO_Platform and recorded in
`SYNC.md` with source commit hashes. Improvements land there first.

## Versioning (owner rule, 2026-08-29)

Version 1.0.0 lands with the post-Codex fixes. After that, EVERY commit bumps
the version by 0.1 (1.0 -> 1.1 -> 1.2 ...) in package.json, in the same
commit. No exceptions, no batching several commits under one version.
