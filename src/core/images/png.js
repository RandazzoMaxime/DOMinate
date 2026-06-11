// From-scratch PNG decoder + PDF embedder. No third-party code: chunk walking,
// zlib inflate via the browser's DecompressionStream, scanline unfiltering
// (None/Sub/Up/Average/Paeth), palette + tRNS. Alpha lands in a /SMask (DeviceGray).
//
// Supported: 8-bit depth, color types 0 (gray), 2 (RGB), 3 (palette), 4 (gray+A),
// 6 (RGBA), non-interlaced. Anything else throws and the caller skips the image.

import { name as pdfName, PdfStream } from '../pdf.js';

/**
 * @param {import('../pdf.js').PdfDocument} doc
 * @param {Uint8Array} bytes
 * @returns {Promise<{ alias, objRef, kind: 'image', width, height }>}
 */
export async function embedPng(doc, bytes) {
  const png = await decodePng(bytes);
  const rgbDeflated = await deflate(png.rgb);
  const alias = 'Im' + (doc._imageCounter = (doc._imageCounter || 0) + 1);

  const dict = {
    Type: pdfName('XObject'),
    Subtype: pdfName('Image'),
    Width: png.width,
    Height: png.height,
    ColorSpace: pdfName('DeviceRGB'),
    BitsPerComponent: 8,
    Filter: pdfName('FlateDecode'),
  };
  if (png.alpha) {
    const alphaDeflated = await deflate(png.alpha);
    dict.SMask = doc._allocObject(new PdfStream(alphaDeflated, {
      Type: pdfName('XObject'),
      Subtype: pdfName('Image'),
      Width: png.width,
      Height: png.height,
      ColorSpace: pdfName('DeviceGray'),
      BitsPerComponent: 8,
      Filter: pdfName('FlateDecode'),
    }));
  }
  const obj = doc._allocObject(new PdfStream(rgbDeflated, dict));
  return { alias, objRef: obj, kind: 'image', width: png.width, height: png.height };
}

const SIG = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

/** @returns {Promise<{width, height, rgb: Uint8Array, alpha: Uint8Array|null}>} */
export async function decodePng(bytes) {
  for (let i = 0; i < 8; i++) if (bytes[i] !== SIG[i]) throw new Error('PNG: bad signature');

  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  let palette = null, trns = null;
  const idatParts = [];

  let p = 8;
  while (p + 8 <= bytes.length) {
    const len = (bytes[p] << 24 | bytes[p + 1] << 16 | bytes[p + 2] << 8 | bytes[p + 3]) >>> 0;
    const type = String.fromCharCode(bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7]);
    const data = bytes.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      width  = (data[0] << 24 | data[1] << 16 | data[2] << 8 | data[3]) >>> 0;
      height = (data[4] << 24 | data[5] << 16 | data[6] << 8 | data[7]) >>> 0;
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === 'PLTE') {
      palette = data.slice();
    } else if (type === 'tRNS') {
      trns = data.slice();
    } else if (type === 'IDAT') {
      idatParts.push(data);
    } else if (type === 'IEND') {
      break;
    }
    p += 12 + len;  // length + type + data + crc
  }

  if (bitDepth !== 8) throw new Error('PNG: only 8-bit depth supported (got ' + bitDepth + ')');
  if (interlace !== 0) throw new Error('PNG: interlaced images not supported');
  if (!width || !height) throw new Error('PNG: missing IHDR');

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error('PNG: unsupported color type ' + colorType);

  // Concatenate IDAT and inflate (zlib stream).
  let total = 0;
  for (const part of idatParts) total += part.byteLength;
  const compressed = new Uint8Array(total);
  let off = 0;
  for (const part of idatParts) { compressed.set(part, off); off += part.byteLength; }
  const raw = await inflate(compressed);

  // Unfilter scanlines.
  const stride = width * channels;
  if (raw.byteLength < height * (stride + 1)) throw new Error('PNG: truncated pixel data');
  const px = new Uint8Array(height * stride);
  const bpp = channels;
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    const prev = dst - stride;
    switch (filter) {
      case 0:
        px.set(raw.subarray(src, src + stride), dst);
        break;
      case 1:  // Sub
        for (let i = 0; i < stride; i++) {
          px[dst + i] = (raw[src + i] + (i >= bpp ? px[dst + i - bpp] : 0)) & 0xFF;
        }
        break;
      case 2:  // Up
        for (let i = 0; i < stride; i++) {
          px[dst + i] = (raw[src + i] + (y > 0 ? px[prev + i] : 0)) & 0xFF;
        }
        break;
      case 3:  // Average
        for (let i = 0; i < stride; i++) {
          const a = i >= bpp ? px[dst + i - bpp] : 0;
          const b = y > 0 ? px[prev + i] : 0;
          px[dst + i] = (raw[src + i] + ((a + b) >> 1)) & 0xFF;
        }
        break;
      case 4:  // Paeth
        for (let i = 0; i < stride; i++) {
          const a = i >= bpp ? px[dst + i - bpp] : 0;
          const b = y > 0 ? px[prev + i] : 0;
          const c = (y > 0 && i >= bpp) ? px[prev + i - bpp] : 0;
          const pp = a + b - c;
          const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
          const pred = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
          px[dst + i] = (raw[src + i] + pred) & 0xFF;
        }
        break;
      default:
        throw new Error('PNG: unknown filter ' + filter);
    }
  }

  // Expand to RGB (+ separate alpha plane).
  const n = width * height;
  const rgb = new Uint8Array(n * 3);
  let alpha = null;
  if (colorType === 6) {
    alpha = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      rgb[i * 3] = px[i * 4]; rgb[i * 3 + 1] = px[i * 4 + 1]; rgb[i * 3 + 2] = px[i * 4 + 2];
      alpha[i] = px[i * 4 + 3];
    }
  } else if (colorType === 2) {
    rgb.set(px);
  } else if (colorType === 0) {
    for (let i = 0; i < n; i++) { const g = px[i]; rgb[i * 3] = g; rgb[i * 3 + 1] = g; rgb[i * 3 + 2] = g; }
  } else if (colorType === 4) {
    alpha = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const g = px[i * 2]; rgb[i * 3] = g; rgb[i * 3 + 1] = g; rgb[i * 3 + 2] = g;
      alpha[i] = px[i * 2 + 1];
    }
  } else if (colorType === 3) {
    if (!palette) throw new Error('PNG: palette image without PLTE');
    if (trns) alpha = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const idx = px[i];
      rgb[i * 3] = palette[idx * 3]; rgb[i * 3 + 1] = palette[idx * 3 + 1]; rgb[i * 3 + 2] = palette[idx * 3 + 2];
      if (trns) alpha[i] = idx < trns.length ? trns[idx] : 255;
    }
    if (alpha && alpha.every(a => a === 255)) alpha = null;
  }

  return { width, height, rgb, alpha };
}

async function inflate(u8) {
  const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function deflate(u8) {
  const stream = new Blob([u8]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
