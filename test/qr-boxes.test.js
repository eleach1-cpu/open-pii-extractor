// QR boxing: generate real QR codes, place them on a page, and require the
// detector to box every one of them.
'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { qrRects } = require('../lib/qr-boxes');

async function qrPixels(text, scale = 4) {
  const QRCode = require('qrcode');
  const { PNG } = require('pngjs');
  const buf = await QRCode.toBuffer(text, { scale, margin: 2 });
  return PNG.sync.read(buf);
}

function blankPage(w, h) {
  const data = new Uint8ClampedArray(w * h * 4);
  data.fill(255);
  return data;
}

function paste(page, pw, qr, ox, oy) {
  for (let y = 0; y < qr.height; y++) {
    for (let x = 0; x < qr.width; x++) {
      const src = (y * qr.width + x) * 4;
      const dst = ((oy + y) * pw + (ox + x)) * 4;
      page[dst] = qr.data[src];
      page[dst + 1] = qr.data[src + 1];
      page[dst + 2] = qr.data[src + 2];
      page[dst + 3] = 255;
    }
  }
}

test('a QR code on a page is found and fully boxed', async () => {
  const W = 800, H = 1000;
  const page = blankPage(W, H);
  const qr = await qrPixels('https://example.va.gov/doc/ABC123456');
  const ox = W - qr.width - 40, oy = H - qr.height - 40; // bottom-right, like VA letters
  paste(page, W, qr, ox, oy);
  const rects = qrRects(page, W, H);
  assert.strictEqual(rects.length, 1, `expected 1 QR box, got ${rects.length}`);
  const r = rects[0];
  // The box must cover the code's dark modules (jsQR's location is the
  // finder-pattern extent; the quiet zone beyond it is white and harmless).
  assert.ok(r.x <= ox + 10 && r.y <= oy + 10, 'box misses the code top-left');
  assert.ok(r.x + r.w >= ox + qr.width - 10 && r.y + r.h >= oy + qr.height - 10, 'box misses the code bottom-right');
});

test('two QR codes on one page are both boxed', async () => {
  const W = 800, H = 1000;
  const page = blankPage(W, H);
  const a = await qrPixels('doc-one-11111111');
  const b = await qrPixels('doc-two-22222222');
  paste(page, W, a, 60, 60);
  paste(page, W, b, W - b.width - 60, H - b.height - 60);
  const rects = qrRects(page, W, H);
  assert.strictEqual(rects.length, 2, `expected 2 QR boxes, got ${rects.length}`);
});

test('a page with no QR yields no boxes', () => {
  const rects = qrRects(blankPage(400, 400), 400, 400);
  assert.strictEqual(rects.length, 0);
});
