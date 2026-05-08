// Embed a JPEG image into a PDF as a /Subtype /Image XObject with /Filter /DCTDecode.
// JPEG bytes are passed through as-is — PDF natively understands DCT.
//
// Caller must give: { bytes, width, height, colorSpace }.
// We don't decode the JPEG; we read width/height from the SOF marker.

import { name as pdfName, PdfStream } from '../pdf.js';

/**
 * @param {import('../pdf.js').PdfDocument} doc
 * @param {Uint8Array} jpegBytes
 * @returns {{ alias: string, objRef, kind: 'image', width: number, height: number }}
 */
export function embedJpeg(doc, jpegBytes) {
  const dims = readJpegSize(jpegBytes);
  if (!dims) throw new Error('JPEG: could not parse SOF marker');
  const alias = 'Im' + (doc._imageCounter = (doc._imageCounter || 0) + 1);
  const obj = doc._allocObject(new PdfStream(jpegBytes, {
    Type: pdfName('XObject'),
    Subtype: pdfName('Image'),
    Width: dims.width,
    Height: dims.height,
    ColorSpace: pdfName('DeviceRGB'),
    BitsPerComponent: 8,
    Filter: pdfName('DCTDecode'),
  }));
  return { alias, objRef: obj, kind: 'image', width: dims.width, height: dims.height };
}

function readJpegSize(bytes) {
  // Walk the JPEG markers looking for SOF0..SOF15 (except SOF4=DHT, SOF8=reserved, SOF12=DQT etc.)
  // Source: SOFn markers are 0xFFC0..0xFFC3, 0xFFC5..0xFFC7, 0xFFC9..0xFFCB, 0xFFCD..0xFFCF
  if (bytes[0] !== 0xFF || bytes[1] !== 0xD8) return null;  // not a JPEG SOI
  let i = 2;
  while (i < bytes.length) {
    if (bytes[i] !== 0xFF) return null;
    let marker = bytes[i + 1];
    while (marker === 0xFF && i + 2 < bytes.length) { i++; marker = bytes[i + 1]; }
    if (marker === 0xD9) return null;  // EOI
    if (marker >= 0xD0 && marker <= 0xD7) { i += 2; continue; }
    const segLen = (bytes[i + 2] << 8) | bytes[i + 3];
    if (isSofMarker(marker)) {
      const height = (bytes[i + 5] << 8) | bytes[i + 6];
      const width  = (bytes[i + 7] << 8) | bytes[i + 8];
      return { width, height };
    }
    i += 2 + segLen;
  }
  return null;
}

function isSofMarker(b) {
  return (b >= 0xC0 && b <= 0xC3) || (b >= 0xC5 && b <= 0xC7) || (b >= 0xC9 && b <= 0xCB) || (b >= 0xCD && b <= 0xCF);
}
