// Embed an SFNT font as a PDF Type 0 (composite) font with CIDFontType2 descendant.
// Encoding is /Identity-H — text strings are sequences of 16-bit big-endian CIDs (which
// equal GIDs because CIDToGIDMap is /Identity).
//
// Returns a font handle compatible with what addStandardFont returns:
//   { alias, baseFont, objRef, kind: 'embeddedTrueType', font: <parsed sfnt>, ... }

import { parseSfnt } from './sfnt.js';
import { name as pdfName, PdfStream, raw } from '../pdf.js';

const FLATE_DECODE = 'FlateDecode';

/**
 * @param {import('../pdf.js').PdfDocument} doc
 * @param {ArrayBuffer|Uint8Array} fontBytes
 * @param {string} baseFontName  — used as /BaseFont and /FontName (must be a valid PDF name)
 * @returns {Promise<{alias, baseFont, objRef, kind, font}>}
 */
const _preparedFonts = new Map();

function preparedFontKey(bytes, baseFontName) {
  const n = bytes.byteLength;
  let h = n * 2654435761 >>> 0;
  const step = Math.max(1, (n / 64) | 0);
  for (let i = 0; i < n; i += step) h = (Math.imul(h, 16777619) ^ bytes[i]) >>> 0;
  h = (Math.imul(h, 16777619) ^ bytes[n - 1]) >>> 0;
  return `${baseFontName}:${n}:${h.toString(16)}`;
}

export async function embedTrueTypeFont(doc, fontBytes, baseFontName) {
  const bytes = fontBytes instanceof Uint8Array ? fontBytes : new Uint8Array(fontBytes);
  const cacheKey = preparedFontKey(bytes, baseFontName);
  let prepared = _preparedFonts.get(cacheKey);
  if (!prepared) {
    const parsed = parseSfnt(bytes);
    const compressed = await deflate(parsed.bytes);
    const upe = parsed.unitsPerEm;
    const scale = 1000 / upe;
    const widthsArr = [];
    let runStart = -1;
    let runWidths = [];
    for (let g = 0; g < parsed.numGlyphs; g++) {
      const w = parsed.widths[g] * scale;
      const wRounded = Math.round(w * 10000) / 10000;
      if (runStart < 0) { runStart = g; runWidths = [wRounded]; }
      else runWidths.push(wRounded);
    }
    if (runStart >= 0) widthsArr.push(runStart, runWidths);
    let wPdf = '[';
    for (let i = 0; i < widthsArr.length; i++) {
      if (i) wPdf += ' ';
      const item = widthsArr[i];
      if (Array.isArray(item)) {
        wPdf += '[';
        for (let j = 0; j < item.length; j++) {
          if (j) wPdf += ' ';
          wPdf += item[j];
        }
        wPdf += ']';
      } else wPdf += item;
    }
    wPdf += ']';
    prepared = {
      parsed,
      compressed,
      scale,
      widthsArr: raw(wPdf),
      dw: Math.round(parsed.widths[0] * scale) || 500,
      toUnicode: buildToUnicodeCMap(parsed.unicodeToGid),
      bbox: parsed.bbox.map(v => Math.round(v * scale)),
      ascent: Math.round(parsed.ascent * scale),
      descent: Math.round(parsed.descent * scale),
    };
    _preparedFonts.set(cacheKey, prepared);
  }
  const { parsed, compressed } = prepared;

  const fontFile = doc._allocObject(new PdfStream(
    compressed,
    {
      Length1: parsed.bytes.byteLength,
      Filter: pdfName(FLATE_DECODE),
    },
  ));

  const fontDescriptor = doc._allocObject({
    Type: pdfName('FontDescriptor'),
    FontName: pdfName(baseFontName),
    Flags: 32,
    FontBBox: prepared.bbox,
    ItalicAngle: 0,
    Ascent: prepared.ascent,
    Descent: prepared.descent,
    CapHeight: Math.round(prepared.ascent * 0.7),
    StemV: 80,
    FontFile2: fontFile,
  });

  const widthsArr = prepared.widthsArr;

  // CIDFont (descendant)
  const cidFont = doc._allocObject({
    Type: pdfName('Font'),
    Subtype: pdfName('CIDFontType2'),
    BaseFont: pdfName(baseFontName),
    CIDSystemInfo: {
      Registry: 'Adobe',
      Ordering: 'Identity',
      Supplement: 0,
    },
    FontDescriptor: fontDescriptor,
    CIDToGIDMap: pdfName('Identity'),
    W: widthsArr,
    DW: prepared.dw,
  });

  if (!prepared.toUnicodeBytes) {
    prepared.toUnicodeBytes = new TextEncoder().encode(prepared.toUnicode);
  }
  const toUnicodeStream = doc._allocObject(new PdfStream(prepared.toUnicodeBytes, {}));

  // Type 0 font (the public face of the font)
  const alias = 'F' + (++doc._fontAliasCounter);
  const fontObj = doc._allocObject({
    Type: pdfName('Font'),
    Subtype: pdfName('Type0'),
    BaseFont: pdfName(baseFontName),
    Encoding: pdfName('Identity-H'),
    DescendantFonts: [cidFont],
    ToUnicode: toUnicodeStream,
  });

  return {
    alias, baseFont: baseFontName, objRef: fontObj,
    kind: 'embeddedTrueType',
    font: parsed,
  };
}

/**
 * Encode a JS string as a PDF hex string of 16-bit big-endian CIDs (= GIDs since
 * CIDToGIDMap is Identity). Returns a string like "<00480065006C006C006F>".
 */
const _hexByParsed = new WeakMap();

export function encodeTextAsHex(font, str) {
  const parsed = font.font;
  let byStr = _hexByParsed.get(parsed);
  if (!byStr) { byStr = new Map(); _hexByParsed.set(parsed, byStr); }
  const hit = byStr.get(str);
  if (hit) return hit;
  const map = parsed.unicodeToGid;
  let out = '<';
  for (let i = 0; i < str.length; i++) {
    let cp = str.codePointAt(i);
    // Surrogate pair: codePointAt returns the full codepoint; advance i by one extra
    if (cp > 0xFFFF) i++;
    let gid = map.get(cp) ?? 0;
    if (gid === 0) {
      // Try mapping common substitutions: NBSP→space, smart quotes, etc.
      if (cp === 0x00A0) gid = map.get(0x20) ?? 0;
    }
    out += hex16(gid);
  }
  out += '>';
  byStr.set(str, out);
  return out;
}

/** Compute an advance width (in PDF text-space units, where font size is 1) for a string. */
export function measureText(font, str, sizePt) {
  const map = font.font.unicodeToGid;
  const widths = font.font.widths;
  const upe = font.font.unitsPerEm;
  let w = 0;
  for (let i = 0; i < str.length; i++) {
    let cp = str.codePointAt(i);
    if (cp > 0xFFFF) i++;
    const gid = map.get(cp) ?? 0;
    w += widths[gid] || 0;
  }
  return (w / upe) * sizePt;
}

function hex16(n) {
  return ((n >>> 8) & 0xff).toString(16).padStart(2, '0') + (n & 0xff).toString(16).padStart(2, '0');
}

async function deflate(u8) {
  // Native CompressionStream is allowed: it's a browser primitive, not a third-party PDF lib.
  if (typeof CompressionStream === 'function') {
    const cs = new CompressionStream('deflate');
    const stream = new Blob([u8]).stream().pipeThrough(cs);
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }
  // Fallback: emit uncompressed (callers must NOT set Filter in that case)
  return u8;
}

/**
 * Build a ToUnicode CMap stream (PDF spec §9.10.3) from a Unicode→GID map.
 * Lets text extraction (Ctrl+F, copy-paste) recover the original codepoints.
 */
function buildToUnicodeCMap(uniToGid) {
  const lines = [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<0000> <FFFF>',
    'endcodespacerange',
  ];

  // bfchar entries: <gidHex> <unicodeHex>
  // PDF spec: at most 100 entries per bfchar group.
  const entries = [];
  for (const [cp, gid] of uniToGid) {
    if (cp > 0xFFFF) continue;  // skip BMP-supplementary for now
    entries.push([gid, cp]);
  }
  for (let i = 0; i < entries.length; i += 100) {
    const chunk = entries.slice(i, i + 100);
    lines.push(chunk.length + ' beginbfchar');
    for (const [gid, cp] of chunk) {
      lines.push(`<${hex16(gid)}> <${hex16(cp)}>`);
    }
    lines.push('endbfchar');
  }

  lines.push('endcmap');
  lines.push('CMapName currentdict /CMap defineresource pop');
  lines.push('end');
  lines.push('end');
  return lines.join('\n');
}
