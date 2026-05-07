# Architectural Spec

## Operating model

The library is a **single ES module** loaded in the browser. Public API:

```js
import { htmlToPdf } from './src/index.js';
const pdfBytes = await htmlToPdf(htmlString, {
  pageSize: 'A4',
  orientation: 'landscape',
  margin: 0,
  fonts: { /* optional pre-fetched font ArrayBuffers */ },
});
// pdfBytes: Uint8Array — write to file, blob URL, or fetch upload
```

It must work in any modern Chromium/Firefox/Safari. No Node, no Web Worker required (but Worker-friendly).

## Pipeline

```
HTML string
  │
  ▼  [dom/parser.js]
DOM tree           (use browser's native DOMParser — that's not "third-party PDF code")
  │
  ▼  [css/parser.js, css/cascade.js, css/computed.js]
Render tree        (each node has computed style)
  │
  ▼  [layout/*]
Layout tree        (each node has absolute box: x, y, width, height in PDF user units = 1/72 inch)
  │
  ▼  [layout/pagination.js]
Page list          (one layout tree per PDF page after page-break handling)
  │
  ▼  [render/painter.js]
PDF content stream (one stream of PDF operators per page)
  │
  ▼  [core/pdf.js]
PDF document       (xref, catalog, pages, fonts, images, link annotations) → bytes
```

## Coordinate system

- Internal layout: CSS px, origin top-left (matches DOM coordinates)
- PDF output: PDF user units (1 unit = 1/72 inch), origin bottom-left
- Conversion: `pdfX = cssPx * 72/96`, `pdfY = pageHeight - (cssPxY * 72/96)`

A4 landscape:
- CSS px: 1123 × 794
- PDF user units: 842 × 595 (= 297 × 210 mm × 72/25.4)

## Module responsibilities

### `core/`
- `pdf.js` — PDF object writer: write `obj`/`endobj`, build xref, indirect references, content streams, catalog, page tree
- `encoding.js` — FlateDecode (via `pako` polyfill — but write our own DEFLATE if we want to be fully from-scratch; native `CompressionStream` API is allowed since it's a browser primitive), ASCII85, hex
- `fonts/` — TTF/OTF parser, font subsetting, ToUnicode CMap generation, CIDFontType2 wrapping
- `images/` — JPEG (DCTDecode passthrough), PNG (re-encode as FlateDecode + DeviceRGB or pass through with PNG predictor), embedded SVG (rasterize via OffscreenCanvas? NO — flatten to PDF path operators)
- `primitives.js` — emit PDF drawing ops: `m l c re f S B` etc., text operators `BT ET Tj Tf Td TJ`, graphics state `q Q cm w J j M d`

### `css/`
- `parser.js` — tokenizer + AST. Handle: `:root`, `--vars`, `var()`, `color-mix()`, `linear-gradient`, units (`px`, `mm`, `em`, `rem`, `%`, `vh`, `vw`), `@page`, `@font-face`, `@import`, `@media`
- `selector.js` — selector matching (we can use `element.matches()` from the browser since we have a real DOM)
- `cascade.js` — specificity, inheritance, computed values
- `computed.js` — produce final used-value tree

### `layout/`
- `box.js` — box model: content/padding/border/margin areas
- `flow.js` — block formatting context, vertical margin collapsing, floats (skip floats v1 unless needed)
- `inline.js` — line boxes, soft wrap with Unicode word-break, baselines, vertical-align
- `flex.js` — flexbox: full algorithm per CSS Flexbox L1
- `grid.js` — CSS Grid: `grid-template-columns`, `grid-template-rows`, gap, span
- `table.js` — table layout (auto + fixed)
- `pagination.js` — page-break-before/after/inside, breaking rules at block level

### `render/`
- `painter.js` — DFS traversal of layout tree. For each box, emit:
  - Background color/gradient → `f` (fill rectangle / clip path)
  - Border (with corner radius) → path operators
  - Inline text runs → `BT/ET` blocks
  - Images → `Do` with XObject ref
  - Link → record as link annotation on the page
- `text.js` — text positioning, kerning (use horizontal advances from font), ligature handling for Inter (via font's GSUB if needed)
- `borders.js` — `border-radius` corners as cubic Bezier `c` operators
- `backgrounds.js` — solid + linear-gradient (axial PDF shading dict, `sh` operator)
- `links.js` — `/Annot /Link /Subtype /URI` annotation dicts on each page

### `dom/`
- `parser.js` — uses `new DOMParser().parseFromString(html, 'text/html')`, then walks the document. CSS is collected from `<style>` blocks and `<link rel=stylesheet>` (fetch them).
- `builder.js` — produces our internal render tree from the DOM

## Key design rules

1. **Vector first.** Never rasterize unless the source is already a raster (img, video frames). SVGs are converted to PDF path ops.
2. **One PDF object per resource.** Fonts, images, gradients are indirect objects referenced from page resources.
3. **Text is text.** A `<p>Hello</p>` becomes a PDF text-showing operator referencing a font, never an image.
4. **Links are annotations.** Every `<a href>` in the HTML becomes a `/Subtype /Link` annotation in the page's `/Annots` array, with rect = the inline run's box.
5. **No third-party PDF generation libraries.** See CONSTRAINTS.md.
6. **Minimal surface, tested by convergence.** We only implement what `reference/source.html` exercises. Other features can be added later as new fixtures are added.

## Page model

Each page in the PDF document object stack:

```
<<
  /Type /Page
  /Parent <pages>
  /MediaBox [0 0 842 595]              % A4 landscape user units
  /Resources <<
    /Font <<
      /F1 <indirect ref to Inter-Regular>
      /F2 <indirect ref to Inter-Bold>
      /F3 <indirect ref to JetBrains-Mono-Regular>
    >>
    /XObject << ... images, form xobjects ... >>
    /Pattern << ... gradients ... >>
  >>
  /Contents <indirect ref to content stream>
  /Annots [ <link annotation refs ...> ]
>>
```

## Fonts (the hard part)

Inter is the document's font. The lib must:

1. Fetch the TTF (from `https://fonts.gstatic.com/...` or a bundled local copy)
2. Parse the TTF tables: `head`, `hhea`, `hmtx`, `cmap`, `glyf`, `loca`, `name`, `maxp`, `OS/2`, `post`
3. Subset: keep only glyphs used by the document
4. Re-emit as a valid TTF byte stream
5. Embed in PDF as a `CIDFontType2` font with `Encoding /Identity-H` and `ToUnicode` CMap
6. At text rendering time: each glyph runs is shown as a hex string of GIDs in big-endian

Same for JetBrains Mono (used by `.coord-mono`).

Reference: ISO 32000-2 §9.7 (Composite fonts), §9.10 (Extraction of text content), §14.3 (PDF Reference for fonts).

## Hyperlinks

Each `<a href>` produces a `/Annot` of `/Subtype /Link`:

```
<<
  /Type /Annot
  /Subtype /Link
  /Rect [llx lly urx ury]              % bounding box in user units
  /Border [0 0 0]                       % no visual border (CSS owns the underline)
  /A << /Type /Action /S /URI /URI (https://topo.ninja) >>
>>
```

For `mailto:` and `tel:` URIs the same `/A /S /URI` pattern works.

## Things we explicitly defer (post-convergence)

- Floats and float-cleared layout
- writing-mode vertical-rl / Asian text
- Filter effects (`filter: blur`, `drop-shadow`)
- 3D transforms
- `@font-face` with woff2 (we use Inter TTF directly)
- Embedded HTML videos or iframes
