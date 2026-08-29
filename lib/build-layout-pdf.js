// Assemble the original-layout redacted PDF: each page is the ORIGINAL page
// rasterized (or the original photo), embedded image-only, with pdf-lib-drawn
// solid black rectangles on top. Because the output contains no text objects
// at all, the classic redaction failure (text surviving under a drawn box)
// is impossible by construction.
//
// pages: [{ imgBase64, scale, rects: [{x,y,w,h}] }]
//   - imgBase64: PNG or JPEG bytes (sniffed by magic number),
//   - scale: raster pixels per PDF point (2 for our pdf rasters, 1 for photos),
//   - rects: top-origin rectangles in the IMAGE's pixel space.
'use strict';

async function buildLayoutPdf(pages) {
  const { PDFDocument, rgb } = require('pdf-lib');
  const doc = await PDFDocument.create();
  for (const p of pages) {
    const buf = Buffer.from(p.imgBase64, 'base64');
    const isPng = buf.length > 4 && buf[0] === 0x89 && buf[1] === 0x50;
    const img = isPng ? await doc.embedPng(buf) : await doc.embedJpg(buf);
    const scale = p.scale || 1;
    const wPt = img.width / scale;
    const hPt = img.height / scale;
    const page = doc.addPage([wPt, hPt]);
    page.drawImage(img, { x: 0, y: 0, width: wPt, height: hPt });
    for (const r of p.rects || []) {
      // Convert top-origin pixel rect to bottom-origin points.
      page.drawRectangle({
        x: r.x / scale,
        y: hPt - (r.y + r.h) / scale,
        width: r.w / scale,
        height: r.h / scale,
        color: rgb(0, 0, 0),
      });
    }
  }
  return doc.save();
}

module.exports = { buildLayoutPdf };
