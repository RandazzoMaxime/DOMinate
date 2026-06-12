# HTML_TO_PDF_CLIENT

A from-scratch, **client-side**, vector-fidelity HTML→PDF rendering library.

```js
import { htmlToPdf } from './src/index.js';
const bytes = await htmlToPdf(htmlString, {
  viewport: { width: 1123, height: 794 },  // A4 landscape in CSS px
});
// → Uint8Array of valid PDF 1.7
```

The PDF contains real selectable text, real clickable hyperlinks, embedded
fonts, vector geometry — no canvas rasterization, no third-party PDF
generators. See **CONSTRAINTS.md** for the no-dependency rules.

## Status (session 2026-06-11/12, closed at the 03:30 deadline — 14 fixtures)

| Fixture | Diff vs Chromium | What it exercises |
|---------|------------------|-------------------|
| `torture-image` | **0.125%** | PNG decode+alpha SMask, JPEG, object-fit, css backgrounds, tiling |
| `torture-svg` | **0.235%** | SVG paths M/L/H/V/C/S/Q/T/A/Z, polygons, dasharray, linecaps, rotated groups |
| `torture-pseudo` | **0.364%** | ::before/::after string/attr()/quote content, breadcrumbs, markers |
| `torture-transform` | **0.493%** | rotate/scale/translate/skew/matrix3d, nested, transform-origin |
| `torture-table` | **0.534%** | border-collapse, row/col spans, zebra, separate+spacing |
| `wizard` | **0.575%** | Tailwind dark theme, forms, gradients, Material Symbols icons, Manrope |
| `torture-box` | **0.678%** | per-side borders, multi-stop/radial gradients, box-shadows, z-index, overflow |
| `torture-effects` | **0.803%** | text-shadow, inset box-shadow, outline+offset, groove/ridge/inset/outset |
| `source` | **0.825%** | rounded cards, tables, flexbox, SVG scheme, links (LCD-AA reference kept) |
| `torture-semantic` | **0.829%** | dl/dt/dd, abbr/ins/del/kbd, colgroup, details, decoration styles/colors |
| `source-flat` | **0.888%** | flat business design, Arial/Helvetica mapping, tracked headers |
| `torture-text` | **0.905%** | justify, lists/markers, code blocks, sub/sup, decorations |
| `torture-flow` | **0.916%** | floats, CSS columns, text-indent, vertical-align, word-break, ellipsis |
| `report` | **2.242%** | dense 10-11px text, italics, inline code (glyph-AA dominated) |
| **overall** | **0.729%** | all functional gates green, validity 98/98, byte-stable across runs |

Session start was 5.885% over 4 fixtures; session end is 0.729% over 14.

The strict exit criterion is < 0.1% per fixture; the remaining diff is dominated
by per-glyph anti-aliasing differences between Chromium's text rasterizer and
pdf.js (the harness rasterizer). Word positions, baselines, geometry, colors and
effects are structurally exact; the PDFs are visually correct in real viewers.

## CSS / HTML coverage

- **Text**: per-word exact positions (character-level Range measurement), real
  font baselines from in-engine metrics, justify, letter/word-spacing,
  text-transform, underline/line-through with style/color/offset
  (solid/double/dotted/dashed/wavy, bridged across spaces), synthetic
  italics, text-shadow (multi, blurred), `white-space: pre`, ellipsis truncation,
  sub/sup, css-fonts-4 weight resolution against the page's loaded faces
- **Fonts**: TTF/OTF parse + Type0/CIDFontType2 embedding with ToUnicode, lazy
  per-document face selection, Latin+Greek fallback chains, JetBrains Mono
  400/500/700, base-14 mapping for Arial/Helvetica
- **Boxes**: per-side borders (solid/dashed/dotted/double/groove/ridge/inset/outset
  with Chromium dash fitting), border-radius incl. per-corner, outline +
  outline-offset, box-shadow outer+inset (erfc-matched gaussian rings),
  pixel-grid snapping, border-collapse aware strokes
- **Backgrounds**: solid, multi-stop linear gradients (FunctionType 3 stitching),
  radial gradients (circle/ellipse, all CSS extent keywords),
  `background-image: url()` with size/position/repeat
- **Images**: JPEG passthrough, from-scratch PNG decoder (palette/gray/alpha →
  SMask), object-fit cover/contain/none/scale-down, border-radius clipping
- **Layout** (via browser engine): flex, grid, tables, floats, CSS columns,
  inline-block, position absolute/relative/sticky, vertical-align, word-break
- **Paint model**: CSS 2.1 Appendix E stacking contexts (z-index, opacity,
  transforms), overflow clipping to the padding box, CSS transforms replayed as
  PDF matrices (measure-untransformed technique)
- **SVG**: paths with arcs→Béziers, polygons/polylines, dasharray, caps/joins,
  fill-rule, per-element getScreenCTM transforms, text
- **Interactive**: link annotations, form-control placeholder/value rendering

- **Icon fonts**: Material Symbols glyph names resolved through the font's GSUB
  ligature table (LookupType 4 + Extension), GIDs emitted directly via Identity-H
- **Multi-page**: content taller than the viewport paginates with line-level
  break avoidance (straddling text lines move whole to the next page)
- **Pseudo-elements**: ::before/::after with string, attr() or open/close-quote
  content, synthesized from the pseudo's computed style and anchored to the
  element's first/last word

Known gaps: CSS counters in pseudo content, WOFF2, variable-font axis
instancing (icons render at the default wght/FILL/opsz), paragraph-level
break-inside control, bidi/RTL shaping, column-rule.

## Running

```bash
npm install
npx playwright install chromium

npm run loop      # diff iteration over all reference/*.html fixtures
npm test          # validity suite (magic bytes, links, text, fonts, size)
npm run demo      # http://localhost:5173/ — drag-drop HTML→PDF playground
node scripts/make-reference.mjs <stem>   # (re)generate Chromium ground truth
node scripts/diff-regions.mjs <stem>     # cluster the diff into regions
node scripts/inspect-patch.mjs <stem> x y w h  # ASCII ref/dist patch compare
```

## Architecture

The lib uses the **host browser's native layout engine** (`getBoundingClientRect`,
`getComputedStyle`, `Range` character rects, `getScreenCTM`, `document.fonts`,
canvas `measureText` on a hidden iframe) rather than reimplementing CSS layout.
See **CLAUDE.md "Architectural decision"**.

```
HTML string
  │
  ▼  walker.js (hidden iframe, browser layout, deterministic settle loop)
flat render boxes (style + geometry + sortKey + clip chain + transform chain)
  │
  ▼  painter.js (stable sort by Appendix-E key → single paint pass)
PDF content stream (paths, shadings, text Tj/TJ, images, annotations)
  │
  ▼  core/pdf.js
PDF document bytes (xref, catalog, fonts, images, shadings, ExtGState)
```

### Modules (`src/`, ≈ 3.4 K LOC)

```
src/
├── index.js                  → public API, lazy font selection, image prefetch
├── core/
│   ├── pdf.js                → PDF writer + axial/radial stitched shadings
│   ├── fonts/ sfnt.js, embed.js → TTF/OTF parse, Type0/CIDFontType2 + ToUnicode
│   └── images/ jpeg.js, png.js  → DCT passthrough; from-scratch PNG inflate/unfilter
├── dom/
│   ├── walker.js             → layout extraction: per-char text measurement, stacking
│   │                           keys, clips, transforms, markers, ellipsis, metrics
│   └── utils.js              → parseColor, parsePx
└── render/
    ├── painter.js            → ordered paint pass: boxes, borders, shadows, gradients,
    │                           text (+shadows/decorations/italics), images, bullets
    └── svg.js                → SVG walker: paths/shapes/text via getScreenCTM
```

### Test loop (`scripts/`)

`loop.mjs` renders every `reference/*.html` through the lib in headless Chromium,
rasterizes at 96 dpi (pdfjs + canvas), pixelmatches against the Chromium
ground-truth PNG and audits links/text/fonts. `make-reference.mjs` regenerates
ground truth with the same settle protocol the walker uses.

## License / authorship

Built autonomously across two `/long-run` sessions (2026-05-08 and 2026-06-11/12).
No third-party PDF libraries in `src/`. Full iteration journal in **CHANGELOG.md**.
