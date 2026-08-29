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

  // pdf-lib's WinAnsi encoding rejects characters outside Latin-1; OCR can
  // emit them, so anything unencodable becomes '?' instead of a crash.
  const sanitize = (s) => s.replace(/[\t\v\f]/g, ' ').replace(/[^\x20-\x7E -ÿ]/g, '?');

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
