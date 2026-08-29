// Text-reconstruction PDF builder (owner decision 2026-08-29): a clean
// rebuilt PDF of the redacted TEXT. Deliberately NOT boxes drawn over the
// original, where text can survive underneath; every page carries a label
// saying it is a reconstruction. Pure Node so the test suite can run it
// without Electron.
'use strict';

const NOTE = 'Redacted text reconstruction made with Open PII Extractor (RateMyVSO.net). Not the original document layout.';

async function buildRedactedPdf(text) {
  const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const noteFont = await doc.embedFont(StandardFonts.HelveticaOblique);
  const PAGE_W = 612, PAGE_H = 792; // US Letter
  const MARGIN = 54, SIZE = 11, LEADING = 15;
  const maxWidth = PAGE_W - MARGIN * 2;

  // pdf-lib WinAnsi rejects characters outside Latin-1 AND five C1
  // controls INSIDE Latin-1 (0x81, 0x8D, 0x8F, 0x90, 0x9D all threw
  // "WinAnsi cannot encode" in direct probes, safety handoff section 11).
  // The allowlist is built NUMERICALLY, code point by code point, so no
  // editor, hook, or quoting layer can collapse an escape into a literal
  // control byte. Tab/VT/FF become spaces; everything not printable
  // WinAnsi becomes a question mark; line breaks are split by the caller.
  const C1_HOLES = new Set([0x81, 0x8d, 0x8f, 0x90, 0x9d]);
  const sanitize = (s) => {
    let out = '';
    for (const ch of String(s)) {
      const c = ch.codePointAt(0);
      if (c === 9 || c === 11 || c === 12) { out += ' '; continue; }
      if (c < 32 || c === 127 || C1_HOLES.has(c) || c > 255) { out += '?'; continue; }
      out += ch;
    }
    return out;
  };

  const wrap = (line) => {
    const words = sanitize(line).split(' ');
    const out = [];
    let cur = '';
    for (const w of words) {
      const probe = cur ? cur + ' ' + w : w;
      if (font.widthOfTextAtSize(probe, SIZE) <= maxWidth) { cur = probe; continue; }
      if (cur) out.push(cur);
      // A single unbroken run longer than the line is hard-cut.
      let rest = w;
      while (font.widthOfTextAtSize(rest, SIZE) > maxWidth) {
        let n = rest.length;
        while (n > 1 && font.widthOfTextAtSize(rest.slice(0, n), SIZE) > maxWidth) n--;
        out.push(rest.slice(0, n));
        rest = rest.slice(n);
      }
      cur = rest;
    }
    if (cur) out.push(cur);
    return out.length ? out : [''];
  };

  let page = null, y = 0;
  const newPage = () => {
    page = doc.addPage([PAGE_W, PAGE_H]);
    page.drawText(NOTE, { x: MARGIN, y: PAGE_H - 30, size: 8, font: noteFont, color: rgb(0.45, 0.45, 0.45) });
    y = PAGE_H - 60;
  };
  newPage();
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    for (const line of wrap(rawLine)) {
      if (y < MARGIN) newPage();
      page.drawText(line, { x: MARGIN, y, size: SIZE, font, color: rgb(0.1, 0.1, 0.1) });
      y -= LEADING;
    }
  }
  return doc.save();
}

module.exports = { buildRedactedPdf, NOTE };
