// Minimal PDF object writer.
// Emits valid PDF 1.7 documents with indirect objects, content streams, and xref.
// All output is byte-precise: xref offsets must match exact byte positions.
//
// This file MUST NOT depend on any third-party PDF library (see CONSTRAINTS.md).
// Only uses TextEncoder + Uint8Array + the browser's CompressionStream for FlateDecode.

const ENCODER = new TextEncoder();

/**
 * Page sizes in PDF user units (1 unit = 1/72 inch).
 */
export const PAGE_SIZES = {
  A4: { width: 595.276, height: 841.890 },        // 210 × 297 mm portrait
  Letter: { width: 612, height: 792 },
};

/**
 * CSS px → PDF user units (96 DPI → 72 DPI).
 */
export const CSS_TO_PDF = 72 / 96;

/**
 * Convert a CSS-pixel Y coordinate (origin top-left) to a PDF Y coordinate
 * (origin bottom-left), given the page height in PDF user units.
 */
export function cssYToPdfY(cssY, pageHeightPdfUnits) {
  return pageHeightPdfUnits - cssY * CSS_TO_PDF;
}

/**
 * Class representing a PDF document under construction.
 *
 * Usage:
 *   const doc = new PdfDocument({ pageSize: 'A4', orientation: 'landscape' });
 *   const page = doc.addPage();
 *   const helv = doc.addStandardFont('Helvetica');
 *   page.beginText();
 *   page.setFont(helv, 12);
 *   page.moveText(100, 500);
 *   page.showText('Hello');
 *   page.endText();
 *   const bytes = doc.toBytes();
 */
export class PdfDocument {
  constructor({ pageSize = 'A4', orientation = 'portrait', margin = 0 } = {}) {
    const base = PAGE_SIZES[pageSize] || PAGE_SIZES.A4;
    this.pageWidth = orientation === 'landscape' ? base.height : base.width;
    this.pageHeight = orientation === 'landscape' ? base.width : base.height;
    this.margin = margin;

    /** @type {IndirectObject[]} */
    this.objects = [];
    /** @type {Page[]} */
    this.pages = [];
    /** @type {Map<string, IndirectObject>} */
    this.fontByAlias = new Map();
    this._fontAliasCounter = 0;
  }

  /** Allocate a new indirect-object id and append it. */
  _allocObject(value) {
    const obj = new IndirectObject(this.objects.length + 1, 0, value);
    this.objects.push(obj);
    return obj;
  }

  /** Reserve an empty indirect-object slot (forward reference). Use .set(value) later. */
  _reserveObject() {
    const obj = new IndirectObject(this.objects.length + 1, 0, null);
    this.objects.push(obj);
    return obj;
  }

  /**
   * Add one of the 14 PDF standard Type 1 fonts. No embedding needed.
   * Recognized BaseFonts: Helvetica, Helvetica-Bold, Helvetica-Oblique, Helvetica-BoldOblique,
   * Times-Roman, Times-Bold, Times-Italic, Times-BoldItalic, Courier, Courier-Bold,
   * Courier-Oblique, Courier-BoldOblique, Symbol, ZapfDingbats.
   *
   * Returns a font handle: { alias: 'F1', baseFont: 'Helvetica', objRef }
   */
  addStandardFont(baseFont) {
    if (this.fontByAlias.has(baseFont)) return this.fontByAlias.get(baseFont);
    const alias = 'F' + (++this._fontAliasCounter);
    const fontObj = this._allocObject({
      Type: name('Font'),
      Subtype: name('Type1'),
      BaseFont: name(baseFont),
      Encoding: name('WinAnsiEncoding'),
    });
    const handle = { alias, baseFont, objRef: fontObj, kind: 'standard' };
    this.fontByAlias.set(baseFont, handle);
    return handle;
  }

  /** Append a new page; returns a Page builder. */
  addPage() {
    const page = new Page(this);
    this.pages.push(page);
    return page;
  }

  /** Serialize the entire document to a Uint8Array. */
  toBytes() {
    // 1. Finalize Pages tree object
    const pagesObj = this._reserveObject();

    // 2. Finalize each Page object (its content stream + page dict)
    const pageObjRefs = [];
    for (const page of this.pages) {
      const pageRef = page._finalize(pagesObj);
      pageObjRefs.push(pageRef);
    }

    pagesObj.set({
      Type: name('Pages'),
      Kids: pageObjRefs.map(r => r),
      Count: pageObjRefs.length,
    });

    // 3. Catalog
    const catalog = this._allocObject({
      Type: name('Catalog'),
      Pages: pagesObj,
    });

    // 4. Serialize header + objects + xref + trailer
    const out = new BytesBuilder();
    out.pushString('%PDF-1.7\n%\xC2\xA5\xC2\xB1\xC3\xAB\n'); // binary marker

    /** @type {number[]} */ const offsets = new Array(this.objects.length + 1).fill(0);
    for (const obj of this.objects) {
      offsets[obj.id] = out.length;
      out.pushString(`${obj.id} ${obj.gen} obj\n`);
      writeValue(out, obj.value);
      out.pushString('\nendobj\n');
    }

    const xrefOffset = out.length;
    out.pushString(`xref\n0 ${this.objects.length + 1}\n`);
    out.pushString('0000000000 65535 f \n');
    for (let i = 1; i <= this.objects.length; i++) {
      const off = offsets[i].toString().padStart(10, '0');
      out.pushString(`${off} 00000 n \n`);
    }

    out.pushString('trailer\n');
    writeValue(out, { Size: this.objects.length + 1, Root: catalog });
    out.pushString(`\nstartxref\n${xrefOffset}\n%%EOF\n`);

    return out.toUint8Array();
  }
}

/** Indirect object container. */
class IndirectObject {
  constructor(id, gen, value) {
    this.id = id;
    this.gen = gen;
    this.value = value;
  }
  set(value) { this.value = value; }
  /** Marker so writeValue() emits "<id> <gen> R" when this object is referenced. */
  get _isIndirect() { return true; }
}

/** PDF name token wrapper. Use the helper `name('Foo')` to mark strings as PDF names. */
class PdfName { constructor(s) { this.s = s; } }
function name(s) { return new PdfName(s); }
export { name };

/** Stream wrapper. */
export class PdfStream {
  constructor(bytes, dict = {}) {
    this.bytes = bytes;        // Uint8Array (already encoded/compressed if Filter set)
    this.dict = { ...dict, Length: bytes.byteLength };
  }
}

/** Build a string of PDF bytes incrementally. */
class BytesBuilder {
  constructor() { this.parts = []; this.length = 0; }
  pushBytes(u8) { this.parts.push(u8); this.length += u8.byteLength; }
  pushString(s) { const u = ENCODER.encode(s); this.pushBytes(u); }
  toUint8Array() {
    const out = new Uint8Array(this.length);
    let off = 0;
    for (const p of this.parts) { out.set(p, off); off += p.byteLength; }
    return out;
  }
}

/** Page builder. Records content-stream ops and finalizes into indirect objects. */
class Page {
  constructor(doc) {
    this.doc = doc;
    this.width = doc.pageWidth;
    this.height = doc.pageHeight;
    /** raw content-stream bytes (latin1) */
    this.contentParts = [];
    /** font handles used on this page (so we know which to put in /Resources/Font) */
    this.fontsUsed = new Set();
    /** link annotations to be added to /Annots */
    this.annots = [];
  }

  _push(s) { this.contentParts.push(s); }

  /** Save graphics state. */
  saveState() { this._push('q\n'); }
  /** Restore graphics state. */
  restoreState() { this._push('Q\n'); }
  /** Set non-stroking (fill) color in DeviceRGB. r,g,b in 0..1. */
  setFillRgb(r, g, b) { this._push(`${num(r)} ${num(g)} ${num(b)} rg\n`); }
  /** Set stroking color in DeviceRGB. */
  setStrokeRgb(r, g, b) { this._push(`${num(r)} ${num(g)} ${num(b)} RG\n`); }
  /** Set line width (PDF user units). */
  setLineWidth(w) { this._push(`${num(w)} w\n`); }
  /**
   * Fill an axis-aligned rectangle. Coordinates are in PDF user units, origin bottom-left.
   * @param {number} x lower-left X
   * @param {number} y lower-left Y
   * @param {number} w width
   * @param {number} h height
   */
  fillRect(x, y, w, h) { this._push(`${num(x)} ${num(y)} ${num(w)} ${num(h)} re f\n`); }

  // ── text ──────────────────────────────────────────────────────────────────
  beginText() { this._push('BT\n'); }
  endText() { this._push('ET\n'); }
  /** Set font + size. font = handle returned by addStandardFont/embed. */
  setFont(font, size) {
    this.fontsUsed.add(font);
    this._push(`/${font.alias} ${num(size)} Tf\n`);
  }
  /** Set text matrix to a translated identity at (x, y) in PDF user units. */
  setTextPos(x, y) { this._push(`1 0 0 1 ${num(x)} ${num(y)} Tm\n`); }
  /** Show a string. The string is escaped as a PDF literal string. */
  showText(s) { this._push(`(${escapeLiteralString(s)}) Tj\n`); }

  /** Add a /Subtype /Link annotation. rect in [llx,lly,urx,ury] PDF units. */
  addLinkAnnot({ rect, uri }) {
    this.annots.push({ rect, uri });
  }

  /** Build content-stream + page dict + emit indirect objects. Returns the page indirect ref. */
  _finalize(pagesObjRef) {
    const contentBytes = ENCODER.encode(this.contentParts.join(''));
    const stream = new PdfStream(contentBytes);
    const contentObj = this.doc._allocObject(stream);

    // Build /Resources/Font dict
    const fontDict = {};
    for (const f of this.fontsUsed) fontDict[f.alias] = f.objRef;

    // Build annotations
    const annotRefs = [];
    for (const a of this.annots) {
      const annotObj = this.doc._allocObject({
        Type: name('Annot'),
        Subtype: name('Link'),
        Rect: a.rect,
        Border: [0, 0, 0],
        H: name('N'),
        A: { Type: name('Action'), S: name('URI'), URI: a.uri },
      });
      annotRefs.push(annotObj);
    }

    const pageDict = {
      Type: name('Page'),
      Parent: pagesObjRef,
      MediaBox: [0, 0, this.width, this.height],
      Resources: { Font: fontDict, ProcSet: [name('PDF'), name('Text'), name('ImageC')] },
      Contents: contentObj,
    };
    if (annotRefs.length) pageDict.Annots = annotRefs;

    return this.doc._allocObject(pageDict);
  }
}

// ── value writer ───────────────────────────────────────────────────────────────

function writeValue(out, v) {
  if (v === null || v === undefined) {
    out.pushString('null');
  } else if (v instanceof IndirectObject) {
    out.pushString(`${v.id} ${v.gen} R`);
  } else if (v instanceof PdfName) {
    out.pushString('/' + v.s);
  } else if (v instanceof PdfStream) {
    out.pushString('<<');
    let first = true;
    for (const [k, val] of Object.entries(v.dict)) {
      if (val === undefined) continue;
      out.pushString(first ? ' ' : ' ');
      first = false;
      out.pushString(`/${k} `);
      writeValue(out, val);
    }
    out.pushString(' >>\nstream\n');
    out.pushBytes(v.bytes);
    out.pushString('\nendstream');
  } else if (typeof v === 'string') {
    out.pushString(`(${escapeLiteralString(v)})`);
  } else if (typeof v === 'number') {
    out.pushString(num(v));
  } else if (typeof v === 'boolean') {
    out.pushString(v ? 'true' : 'false');
  } else if (Array.isArray(v)) {
    out.pushString('[');
    for (let i = 0; i < v.length; i++) {
      if (i > 0) out.pushString(' ');
      writeValue(out, v[i]);
    }
    out.pushString(']');
  } else if (typeof v === 'object') {
    out.pushString('<<');
    for (const [k, val] of Object.entries(v)) {
      if (val === undefined) continue;
      out.pushString(` /${k} `);
      writeValue(out, val);
    }
    out.pushString(' >>');
  } else {
    throw new Error('PDF: unsupported value type: ' + typeof v);
  }
}

/** Format a number for PDF: avoid exponential notation, max 5 fraction digits. */
function num(n) {
  if (!isFinite(n)) throw new Error('PDF: non-finite number ' + n);
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(5).replace(/0+$/, '').replace(/\.$/, '');
}

/** Escape a string as a PDF literal. Caller passes normal Unicode JS strings.
 *  - ASCII printable (0x20..0x7E except `(`, `)`, `\`) goes through as-is.
 *  - `(` `)` `\` are backslash-escaped.
 *  - Tab/LF/CR get short escapes for readability.
 *  - All other bytes (0x00..0x1F, 0x7F..0xFF) are emitted as 3-digit octal escapes (\NNN).
 *  - Non-Latin-1 codepoints (>0xFF) are replaced with '?' for now; real Unicode requires an
 *    embedded composite font (added in a later iteration's font subsystem). */
function escapeLiteralString(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    const c = s[i];
    if (c === '(' || c === ')' || c === '\\') { out += '\\' + c; continue; }
    if (ch === 0x09) { out += '\\t'; continue; }
    if (ch === 0x0a) { out += '\\n'; continue; }
    if (ch === 0x0d) { out += '\\r'; continue; }
    if (ch >= 0x20 && ch <= 0x7E) { out += c; continue; }
    if (ch <= 0xFF) {
      // Latin-1 — for Helvetica with /WinAnsiEncoding the byte values map to the right glyphs
      // for codepoints that are common in WinAnsi. For codepoints in 0x80..0x9F the WinAnsi
      // mapping differs from Latin-1; for now this is acceptable, glyph mismatches in that
      // narrow range will be revisited when we drop standard fonts in favor of embedded Inter.
      out += '\\' + ch.toString(8).padStart(3, '0');
      continue;
    }
    // > 0xFF — replace with '?' until the embedded font subsystem lands.
    out += '?';
  }
  return out;
}
