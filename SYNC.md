# Rule-sync record

The redaction engine is copied from RateMyVSO_Platform and must NOT fork
silently. Rule improvements land in the platform repo FIRST, then sync here.

| File here | Source in RateMyVSO_Platform | Synced at commit | Local changes |
|---|---|---|---|
| lib/va-pii-rules.js | src/lib/pii/va-pii-rules.js | platform working tree 2026-08-29 | none (verbatim) |
| lib/strip-letter-pii.js | src/lib/pii/strip-letter-pii.js | platform working tree 2026-08-29 (spaced ICN + personal phone/email + 2-char trusted-footer names; uncommitted there, ships with the next site release) | none (verbatim) |
| lib/redact-pii.js | src/lib/grounding/redact-pii.js | ebd2ad5a | one require repointed to ./va-pii-rules |
| lib/local-ocr.js | src/lib/local-ocr.js | ebd2ad5a | spawn cwd = app root; ELECTRON_RUN_AS_NODE for the worker child |
| lib/local-ocr-worker.js | src/lib/local-ocr-worker.js | ebd2ad5a | CACHE_DIR = bundled tessdata dir (env-overridable); langPath+gzip pinned to it so no runtime download exists |
| renderer/safe-preview.js | public/js/letter-safe-preview.js | ebd2ad5a | fetch -> window.api.redact; Interpret button -> Save redacted copy |
| renderer/app.js | public/js/pdfjs-extract.js (extraction core) | ebd2ad5a | rewritten as ES module around the same pdf.js flow + 80 chars/page floor |
| renderer/pdfjs/ | public/js/vendor/pdfjs/ | ebd2ad5a | none (verbatim vendor copy) |
| test/pii-redaction.test.js | tests/pii-redaction.test.js | platform working tree 2026-08-29 (66 tests) | requires repointed to lib/; every assertion kept, 64/64 pass |

To sync: diff each source file against its copy, apply, update the commit
hash column, run `npm test`.
