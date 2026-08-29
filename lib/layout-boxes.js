// Pure geometry: given positioned words and the token lists to hide, return
// the rectangles to black out. Works for both lanes:
//   - digital PDFs: words built in the renderer from pdf.js text items,
//   - scans/photos: words from Tesseract bounding boxes.
// Word shape: { text, x, y, w, h } in any consistent pixel space (y = top).
// Matching is on normalized tokens (lowercase alphanumerics), multi-token
// spans must appear as CONSECUTIVE words, and every occurrence is boxed.
// Boxes are padded so descenders/antialiasing never leak an edge pixel.
//
// Loaded by BOTH Node (tests, main) and the renderer (via <script>, where it
// attaches to window.LayoutBoxes).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LayoutBoxes = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function normalizeToken(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  const PAD = 2;

  function pad(rect) {
    return { x: rect.x - PAD, y: rect.y - PAD, w: rect.w + PAD * 2, h: rect.h + PAD * 2 };
  }

  // words: [{text,x,y,w,h}], tokenLists: [["123","maple","street"],["smith"]]
  function boxesForWords(words, tokenLists) {
    const norm = words.map((w) => normalizeToken(w.text));
    const rects = [];
    for (const tokens of tokenLists) {
      if (!tokens.length) continue;
      for (let s = 0; s < norm.length; s++) {
        // A single PDF/OCR word can contain several span tokens fused
        // ("SMITH,JOHN"); a span token can also equal one word. Match a
        // window of words whose concatenated normal form equals the span's.
        let joined = '';
        let e = s;
        const target = tokens.join('');
        while (e < norm.length && joined.length < target.length) {
          joined += norm[e];
          e++;
        }
        if (joined !== target || joined === '') continue;
        for (let k = s; k < e; k++) {
          if (words[k].w > 0 && words[k].h > 0) rects.push(pad(words[k]));
        }
        s = e - 1;
      }
      // Also box any single word that CONTAINS a span token fused with other
      // characters (OCR glue like "ICN:123456789V123456", or a page-header
      // name run pdf.js hands over as one item). Threshold: 4 for a
      // STANDALONE token (a name token or a tapped word - "LEACH" is five
      // characters and leaked through the old 6 floor on a real letter,
      // 2026-08-29); 6 for tokens inside multi-token spans, which are
      // otherwise matched positionally and would over-box at 4.
      const containsFloor = tokens.length === 1 ? 4 : 6;
      for (const t of tokens) {
        if (t.length < containsFloor) continue;
        for (let k = 0; k < norm.length; k++) {
          if (norm[k] !== t && norm[k].includes(t)) rects.push(pad(words[k]));
        }
      }
    }
    return mergeOverlaps(rects);
  }

  function mergeOverlaps(rects) {
    // Cheap union: exact duplicates removed; overlapping boxes are fine to
    // draw twice, this only trims the pathological all-duplicates case.
    const seen = new Set();
    return rects.filter((r) => {
      const key = [r.x | 0, r.y | 0, r.w | 0, r.h | 0].join(',');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  return { boxesForWords, normalizeToken };
});
