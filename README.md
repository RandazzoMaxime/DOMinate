# DOMinate

**From-scratch, client-side, vector-fidelity HTML → PDF.**
No jsPDF. No pdf-lib. No html2canvas. No headless browser at runtime. No server.

DOMinate runs entirely in the browser, uses the browser's own layout engine to
position every element exactly where Chromium would, and hand-writes a valid
PDF 1.7 document byte-by-byte: real selectable text, real embedded fonts, real
clickable links, real vector paths — never a rasterized screenshot glued onto
a page.

```js
import { htmlToPdf } from './src/index.js';

const bytes = await htmlToPdf(htmlString, {
  viewport: { width: 1123, height: 794 },  // A4 landscape, CSS px
});
// → Uint8Array, a valid PDF 1.7 document
```

## Why

Every existing "HTML to PDF in the browser" library either drags in a heavy
third-party PDF writer, or rasterizes the page to a `<canvas>` and embeds a
JPEG/PNG — which means no selectable text, no real hyperlinks, blurry output
at any zoom level, and a much larger file. DOMinate does neither: it reuses
the browser's CSS engine for layout (the same primitive as `fetch` or
`DOMParser` — not a dependency) and writes PDF objects itself.

## Quick start

```bash
npm install
npx playwright install chromium   # only needed for the test/dev tooling

npm run demo       # http://localhost:5173 — drag-and-drop playground
```

Or just double-click **`convert.bat`** — it starts the local server and opens
the drag-and-drop converter for you. No command line needed. Full walkthrough
in **[`documentation.html`](documentation.html)**.

## Features

- **Real text** — `BT … Tj ET` operators against embedded fonts, not pixels.
  Ctrl+F works in any PDF reader.
- **Real links** — `/Subtype /Link` annotations with `/A /URI`, positioned
  exactly over the source `<a>` element.
- **Real fonts** — TTF/OTF parsed and subset from scratch, embedded as
  `Type0`/`CIDFontType2` with `ToUnicode`, only the faces actually used.
- **Real vector geometry** — borders, shadows, gradients (linear + radial,
  multi-stop), SVG paths, transforms — all PDF path/shading operators.
- **Faithful layout** — flex, grid, tables, floats, columns, position,
  z-index/opacity stacking contexts, overflow clipping: whatever the browser
  computes, because the browser computes it.
- **Pagination** — content taller than one page slices automatically without
  ever cutting a text line in half, plus manual control:

  ```html
  <div class="page-break"></div>
  ```

  drops a page break wherever you put it (aliases: `pagebreak`, `break-page`,
  `data-page-break`, or standard `style="break-before: page"`).
- **Images** — JPEG passthrough, a from-scratch PNG decoder (palette/alpha →
  soft mask), `object-fit`.

See **[`USAGE.md`](USAGE.md)** for the full API and coverage list.

## Architecture

```
HTML string
  │
  ▼  dom/walker.js — hidden iframe, browser layout engine, deterministic settle
flat render boxes (style + geometry + paint order + clip/transform chains)
  │
  ▼  render/painter.js — stable-sorted single paint pass
PDF content stream (paths, shadings, text, images, link annotations)
  │
  ▼  core/pdf.js
PDF document bytes (xref, catalog, embedded fonts, images, shadings)
```

```
src/
├── index.js              public API — font selection, image prefetch, pagination
├── core/
│   ├── pdf.js             PDF object writer, xref, axial/radial shadings
│   ├── fonts/              sfnt.js (TTF/OTF parse) · embed.js (Type0/CIDFontType2)
│   └── images/             jpeg.js (passthrough) · png.js (from-scratch decoder)
├── dom/
│   ├── walker.js          layout extraction: per-character text measurement,
│   │                       stacking contexts, clips, transforms, page breaks
│   └── utils.js            color/length parsing
└── render/
    ├── painter.js          ordered paint pass: boxes, text, images, bullets
    └── svg.js               SVG → PDF path translation
```

Full rationale for "browser-as-layout-engine" in **[`CLAUDE.md`](CLAUDE.md)**.

## Testing

```bash
npm run loop      # renders every reference/*.html fixture, pixel-diffs vs
                   # Chromium ground truth, audits links/text/fonts
npm test           # validity suite: magic bytes, xref integrity, size sanity
```

`scripts/loop.mjs` is the convergence gate this project was built against —
see `CHANGELOG.md` for the full iteration journal (14 fixtures, 0.729% mean
pixel diff against native Chromium rendering, all functional gates green).

## Constraints

`src/` never imports a third-party PDF/canvas-rasterization library. The full
list of forbidden packages and disallowed shortcuts (e.g. "rasterize to
canvas and embed as image") is in **[`CONSTRAINTS.md`](CONSTRAINTS.md)**.

## License

Private project. No license granted for external use.
