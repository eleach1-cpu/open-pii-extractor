// QR-code boxing (owner decision 2026-08-29): VA letters carry a QR on most
// pages that encodes a document/claim identifier no text rule can see, so
// every DECODED code gets a black box like any other identifier. Detection
// is jsQR (pure JS, offline). A code too damaged for jsQR to decode is not
// found; the veteran's visual check remains the last line, as everywhere.
//
// Dual-use file like layout-boxes.js: Node requires 'jsqr'; the renderer
// loads renderer/vendor-jsqr.js first, which defines the global jsQR.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('jsqr'));
  else root.QrBoxes = factory(root.jsQR);
})(typeof self !== 'undefined' ? self : this, function (jsQR) {
  'use strict';

  const PAD = 10;
  const MAX_CODES_PER_PAGE = 6;

  function rectFromLocation(L, ox, oy, width, height) {
    const xs = [L.topLeftCorner, L.topRightCorner, L.bottomLeftCorner, L.bottomRightCorner].map((c) => c.x + ox);
    const ys = [L.topLeftCorner, L.topRightCorner, L.bottomLeftCorner, L.bottomRightCorner].map((c) => c.y + oy);
    const x0 = Math.max(0, Math.min.apply(null, xs) - PAD);
    const y0 = Math.max(0, Math.min.apply(null, ys) - PAD);
    const x1 = Math.min(width, Math.max.apply(null, xs) + PAD);
    const y1 = Math.min(height, Math.max.apply(null, ys) + PAD);
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  function blank(data, width, r) {
    for (let y = Math.floor(r.y); y < Math.ceil(r.y + r.h); y++) {
      for (let x = Math.floor(r.x); x < Math.ceil(r.x + r.w); x++) {
        const o = (y * width + x) * 4;
        data[o] = 255; data[o + 1] = 255; data[o + 2] = 255;
      }
    }
  }

  function crop(data, width, tx, ty, tw, th) {
    const out = new Uint8ClampedArray(tw * th * 4);
    for (let y = 0; y < th; y++) {
      const srcRow = ((ty + y) * width + tx) * 4;
      out.set(data.subarray(srcRow, srcRow + tw * 4), y * tw * 4);
    }
    return out;
  }

  function overlaps(a, b) {
    return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  }

  // pixels: Uint8ClampedArray (RGBA), width, height. Returns rects in the
  // same pixel space. Each found code is boxed and blanked, then the scan
  // repeats. jsQR locks onto at most one code per frame and can lock onto
  // NEITHER when two share a frame (proven by the two-code test), so after
  // the full-frame passes an overlapping 2x2 tile grid is scanned too.
  function qrRects(pixels, width, height) {
    const data = new Uint8ClampedArray(pixels); // work on a copy
    const rects = [];
    const found = (r) => {
      if (rects.some((o) => overlaps(o, r))) return;
      rects.push(r);
      blank(data, width, r);
    };
    for (let i = 0; i < MAX_CODES_PER_PAGE; i++) {
      let code = null;
      try { code = jsQR(data, width, height); } catch (e) { break; }
      if (!code || !code.location) break;
      found(rectFromLocation(code.location, 0, 0, width, height));
    }
    // Overlapping tiles: 2x2 grid, each tile 60% of the page, so a code on
    // any edge or center falls wholly inside at least one tile.
    const tw = Math.floor(width * 0.6), th = Math.floor(height * 0.6);
    const xs = [0, width - tw], ys = [0, height - th];
    for (const ty of ys) {
      for (const tx of xs) {
        for (let i = 0; i < MAX_CODES_PER_PAGE; i++) {
          let code = null;
          try { code = jsQR(crop(data, width, tx, ty, tw, th), tw, th); } catch (e) { break; }
          if (!code || !code.location) break;
          found(rectFromLocation(code.location, tx, ty, width, height));
        }
      }
    }
    return rects;
  }

  return { qrRects };
});
