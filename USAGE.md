# Usage

## Browser (in your app)

```html
<script type="module">
  import { htmlToPdf } from './node_modules/html-to-pdf-client/src/index.js';

  // Convert any HTML string into a PDF (Uint8Array).
  const html = document.getElementById('my-doc').outerHTML;
  const bytes = await htmlToPdf(html, {
    viewport: { width: 794, height: 1123 },  // A4 portrait in CSS px
  });

  // Download
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'output.pdf';
  a.click();
</script>
```

## Options

```typescript
htmlToPdf(input: string | HTMLElement, opts?: {
  viewport?: { width: number, height: number },  // CSS px; defaults to A4 landscape
  pageSize?: 'A4' | 'Letter',                     // alternative to viewport
  orientation?: 'portrait' | 'landscape',         // alternative to viewport
  margin?: number,                                // in mm; default 0
}): Promise<Uint8Array>
```

The lib:
- Loads the HTML into a hidden iframe at `viewport` size and waits for a
  deterministic settle (fonts loaded, no pending fetches, layout stable)
- Walks every element, capturing computed styles + per-character Range geometry
- Emits a vector-only PDF: real text (embedded CIDFontType2 fonts), real link
  annotations, real path geometry (gradients, shadows, transforms, SVG paths)
- **Paginates**: content taller than the viewport becomes multiple pages, with
  text lines never cut at a page boundary

## What's supported

See README.md for the full coverage list. Highlights:

- Text: word-exact positions, real baselines, justify, decorations with
  style/color/offset (solid/double/dotted/dashed/wavy), synthetic italics,
  text-shadow, `white-space: pre`, `text-overflow: ellipsis`, sub/sup
- Layout: anything the browser computes — block, flex, grid, table, floats,
  CSS columns, inline-block, position, vertical-align, word-break
- Paint: CSS 2.1 stacking contexts (z-index/opacity/transforms), overflow
  clipping, CSS transforms (rotate/scale/skew/matrix, nested, origin)
- Boxes: per-side borders (all styles incl. groove/ridge/inset/outset),
  %/elliptical border-radius, outer+inset box-shadow, outline+offset
- Backgrounds: multi-stop linear + radial gradients, `background-image: url()`
  with size/position/repeat
- Images: JPEG passthrough, full PNG decoder (palette/alpha → SMask), object-fit
- SVG: paths (M/L/H/V/C/S/Q/T/A/Z), polygons, dasharray, caps/joins, transforms
- Fonts: Inter, JetBrains Mono 400/500/700, Manrope 700/800, Arial/Helvetica →
  base-14 mapping, Material Symbols icons (GSUB ligatures), lazy embedding
- Pseudo-elements: ::before/::after with string / attr() / quote content
- `<input>`/`<select>`/`<textarea>` placeholders + values, list markers

## What's not (yet)

- CSS counters in pseudo content; paragraph-level break-inside control
- WOFF2 web fonts (bundle TTF/OTF instead); variable-font axis instancing
- bidi/RTL shaping, complex scripts (Arabic, Indic)
- `filter:`, `backdrop-filter:`, 3D transforms, `column-rule`

## Bundled fonts

| File | Size | Coverage |
|------|------|----------|
| `Inter-{400,500,600,700}.ttf` | ~68 KB each | Latin |
| `Inter-{400,500,600,700}-greek.ttf` | ~16 KB each | Greek (incl. Δ) |
| `JetBrainsMono-{Regular,500,700}.ttf` | 110–270 KB | Monospace |
| `Manrope-{700,800}.ttf` | ~95 KB each | Display headlines |
| `MaterialSymbolsOutlined.ttf` | 963 KB | Icon ligatures |

Faces are embedded lazily — a PDF only contains the faces its content uses.

## Vector fidelity guarantee

The output PDF contains:

- **Real text** — `BT … Tj ET` operators referencing embedded fonts, NOT
  rasterized canvas pixels. Use Ctrl+F in a PDF reader to confirm.
- **Real link annotations** — clickable hyperlinks with `/Subtype /Link` + `/A /URI`.
- **Real geometry** — rectangles, paths, gradients are PDF operators (`re`, `m`, `l`,
  `c`, `f`, `S`, `sh`), not embedded images.
- **Embedded fonts** — parsed (SFNT), mapped to GIDs via cmap (and GSUB ligatures
  for icon fonts), embedded as `/CIDFontType2` with `/Identity-H` + ToUnicode.

There is NO fallback to "rasterize the page to a canvas, embed as image". That's the
opposite of what this lib does.

## License / authorship

Built across two `/long-run` sessions (2026-05-08 and 2026-06-11/12).
No third-party PDF libraries in `src/` — see `CONSTRAINTS.md` for the rules.
