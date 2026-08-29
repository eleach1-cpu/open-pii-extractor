// The single home for every input/processing limit (safety handoff §9).
// Renderer checks are convenience; main.js re-validates EVERYTHING here
// because the renderer is not a security boundary. Exceeding any limit is a
// WHOLE-INPUT rejection with a named reason, never a silent partial result
// (owner default 1: reject, don't truncate).
'use strict';

const LIMITS = {
  MAX_FILES: 5,
  MAX_FILE_BYTES: 30 * 1024 * 1024,        // 30 MB per file
  MAX_BATCH_BYTES: 80 * 1024 * 1024,       // 80 MB per batch
  MAX_OCR_PDF_PAGES: 10,                   // scanned/OCR-routed PDFs
  MAX_DIGITAL_PDF_PAGES: 60,               // digital PDFs (render + export)
  MAX_IMAGE_PIXELS: 40 * 1000 * 1000,      // 40 MP decoded
  MAX_CHARS: 120000,                       // total characters entering redaction
  MAX_LAYOUT_PAGES: 60,                    // original-layout export pages
  MAX_LAYOUT_TOTAL_BYTES: 300 * 1024 * 1024, // raster bytes across the export
};

// File signatures. A file whose bytes do not match its claimed kind is
// rejected before any heavy work (deceptive-extension guard).
function sniffKind(buf) {
  if (!buf || buf.length < 4) return null;
  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return 'pdf';   // %PDF
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image'; // PNG
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image';                                        // JPEG
  return null;
}

module.exports = { LIMITS, sniffKind };
