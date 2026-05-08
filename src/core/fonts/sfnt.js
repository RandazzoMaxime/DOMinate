// Minimal SFNT (TTF/OTF) parser — only enough to embed a font into a PDF.
// Reads the table directory, extracts head / hhea / maxp / cmap, builds a
// Unicode-codepoint → glyph-index (GID) map using cmap format 4 (the most common
// Unicode encoding for TTF). Falls back to format 12 for codepoints > U+FFFF.

const SFNT_VERSION_TRUETYPE = 0x00010000;
const SFNT_VERSION_OTF      = 0x4F54544F;  // 'OTTO'

/**
 * Parse a TTF/OTF font.
 * @param {ArrayBuffer|Uint8Array} input
 * @returns {{
 *   bytes: Uint8Array,
 *   isOtf: boolean,
 *   unitsPerEm: number,
 *   ascent: number,
 *   descent: number,
 *   bbox: [number, number, number, number],
 *   numGlyphs: number,
 *   widths: number[],   // advance width in font units, indexed by GID
 *   unicodeToGid: Map<number, number>,
 * }}
 */
export function parseSfnt(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const sfntVer = dv.getUint32(0, false);
  const isOtf = sfntVer === SFNT_VERSION_OTF;
  if (sfntVer !== SFNT_VERSION_TRUETYPE && !isOtf) {
    throw new Error('Not a TTF/OTF font: SFNT version 0x' + sfntVer.toString(16));
  }
  const numTables = dv.getUint16(4, false);

  /** @type {Map<string, {offset: number, length: number}>} */
  const tables = new Map();
  for (let i = 0; i < numTables; i++) {
    const off = 12 + i * 16;
    const tag = String.fromCharCode(bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]);
    const offset = dv.getUint32(off + 8, false);
    const length = dv.getUint32(off + 12, false);
    tables.set(tag, { offset, length });
  }

  function readTable(name) {
    const t = tables.get(name);
    if (!t) throw new Error('TTF: missing table ' + name);
    return new DataView(bytes.buffer, bytes.byteOffset + t.offset, t.length);
  }

  // head
  const head = readTable('head');
  const unitsPerEm = head.getUint16(18, false);
  const xMin = signExtend16(head.getInt16(36, false));
  const yMin = signExtend16(head.getInt16(38, false));
  const xMax = signExtend16(head.getInt16(40, false));
  const yMax = signExtend16(head.getInt16(42, false));

  // hhea
  const hhea = readTable('hhea');
  const ascent = hhea.getInt16(4, false);
  const descent = hhea.getInt16(6, false);
  const numHMetrics = hhea.getUint16(34, false);

  // post (optional, but Inter has it) — underline position + thickness in font units
  let underlinePosition = -100;   // sensible defaults
  let underlineThickness = 50;
  try {
    const post = readTable('post');
    underlinePosition = post.getInt16(8, false);
    underlineThickness = post.getInt16(10, false);
  } catch { /* missing post table — keep defaults */ }

  // maxp
  const maxp = readTable('maxp');
  const numGlyphs = maxp.getUint16(4, false);

  // hmtx — read advance widths
  const hmtx = readTable('hmtx');
  const widths = new Array(numGlyphs);
  for (let i = 0; i < numGlyphs; i++) {
    if (i < numHMetrics) {
      widths[i] = hmtx.getUint16(i * 4, false);
    } else {
      // Glyphs beyond numHMetrics share the last advance width
      widths[i] = hmtx.getUint16((numHMetrics - 1) * 4, false);
    }
  }

  // cmap — find the best Unicode subtable (platformID=0 unicode, or 3/10 win-ucs4, or 3/1 win-ucs2)
  const cmap = readTable('cmap');
  const numSubtables = cmap.getUint16(2, false);
  let unicodeOffset = -1;
  let isUcs4 = false;
  for (let i = 0; i < numSubtables; i++) {
    const recOff = 4 + i * 8;
    const platformID = cmap.getUint16(recOff, false);
    const encodingID = cmap.getUint16(recOff + 2, false);
    const subtableOff = cmap.getUint32(recOff + 4, false);
    if (platformID === 0) {
      // Unicode platform; encodingIDs 3=BMP, 4=full
      unicodeOffset = subtableOff;
      isUcs4 = encodingID >= 4;
      break;
    }
    if (platformID === 3 && encodingID === 10) {
      unicodeOffset = subtableOff;
      isUcs4 = true;
      break;
    }
    if (platformID === 3 && encodingID === 1 && unicodeOffset < 0) {
      unicodeOffset = subtableOff;
    }
  }
  if (unicodeOffset < 0) throw new Error('TTF: no Unicode cmap subtable');

  const unicodeToGid = new Map();
  const subFormat = cmap.getUint16(unicodeOffset, false);
  if (subFormat === 4) parseCmapFormat4(cmap, unicodeOffset, unicodeToGid);
  else if (subFormat === 12) parseCmapFormat12(cmap, unicodeOffset, unicodeToGid);
  else throw new Error('TTF: unsupported cmap format ' + subFormat);

  return {
    bytes, isOtf, unitsPerEm, ascent, descent, bbox: [xMin, yMin, xMax, yMax],
    numGlyphs, widths, unicodeToGid,
    underlinePosition, underlineThickness,
  };
}

function signExtend16(n) { return n; }  // DataView.getInt16 already does it

function parseCmapFormat4(cmap, offset, out) {
  const segCountX2 = cmap.getUint16(offset + 6, false);
  const segCount = segCountX2 / 2;
  const endArr   = offset + 14;
  const startArr = endArr + segCountX2 + 2;       // +2 for reservedPad
  const idDeltaArr = startArr + segCountX2;
  const idRangeOffsetArr = idDeltaArr + segCountX2;

  for (let i = 0; i < segCount; i++) {
    const end   = cmap.getUint16(endArr + i * 2, false);
    const start = cmap.getUint16(startArr + i * 2, false);
    const delta = cmap.getInt16(idDeltaArr + i * 2, false);
    const rangeOffset = cmap.getUint16(idRangeOffsetArr + i * 2, false);
    if (start === 0xFFFF && end === 0xFFFF) break;

    for (let cp = start; cp <= end; cp++) {
      let gid;
      if (rangeOffset === 0) {
        gid = (cp + delta) & 0xFFFF;
      } else {
        // glyphIdArray indexing per spec
        const glyphIdOffset = idRangeOffsetArr + i * 2 + rangeOffset + (cp - start) * 2;
        gid = cmap.getUint16(glyphIdOffset, false);
        if (gid !== 0) gid = (gid + delta) & 0xFFFF;
      }
      if (gid !== 0) out.set(cp, gid);
    }
  }
}

function parseCmapFormat12(cmap, offset, out) {
  const numGroups = cmap.getUint32(offset + 12, false);
  let g = offset + 16;
  for (let i = 0; i < numGroups; i++) {
    const startCp = cmap.getUint32(g, false);
    const endCp   = cmap.getUint32(g + 4, false);
    const startGid = cmap.getUint32(g + 8, false);
    for (let cp = startCp; cp <= endCp; cp++) {
      out.set(cp, startGid + (cp - startCp));
    }
    g += 12;
  }
}
