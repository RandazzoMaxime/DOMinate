# Constraints — what we may NOT use

## Forbidden in `src/` (the lib itself)

The library is **from scratch**. Inside `src/` you may NOT depend on:

| Forbidden | Why |
|-----------|-----|
| `jspdf`, `pdfkit`, `pdf-lib`, `@pdf-lib/*`, `pdfmake` | Third-party PDF generators — we are writing our own |
| `html2canvas`, `html2pdf.js`, `dom-to-image` | Canvas-rasterization approaches — we want vector output |
| `puppeteer-core`, `playwright-core`, `chrome-headless-render-pdf` | Browser-driven generation — defeats the "no server / no browser dependency" goal |
| `paged.js`, `weasyprint-wasm`, `prince-wasm` | Third-party HTML→PDF engines |
| Any WASM-compiled C/C++ PDF lib (`mupdf-js`, `pdfium`) for **generation** | Same — it's a third-party generator |
| `opentype.js`, `fontkit` for **production embedding** | We write our own TTF parser + subsetter (allowed for verification of our parser only) |
| `canvas-to-pdf`, `svg2pdf.js` | Same family — fragmented PDF generators |

## Allowed in `src/`

- Native browser APIs: `DOMParser`, `getComputedStyle`, `Range`, `OffscreenCanvas` (only for image color-space conversion, NOT for rasterizing layout), `CompressionStream` (for FlateDecode)
- Native browser APIs to fetch fonts/images: `fetch`, `Response.arrayBuffer()`
- Pure helpers we write ourselves
- Tiny, **well-known**, format-only utilities IF we cannot reasonably reimplement them in scope. Each one needs a one-line justification in `ITERATION_LOG.md`. Examples that may be permissible if absolutely needed and only as a last resort:
  - A pure DEFLATE polyfill for browsers without `CompressionStream` (we should prefer the native API)

## Allowed in `scripts/` (the test loop only — not shipped to users)

The Node-side test loop is allowed to use third-party tooling because it never runs in the user's browser:

- `playwright` — for taking the reference screenshot once (already done)
- `pdfjs-dist` — for rasterizing the lib's OUTPUT to PNG so we can diff against `reference/source.png`. PDF.js is a renderer; it does not generate PDFs. Using it for verification is fine.
- `pixelmatch` + `pngjs` — for the diff
- `sharp` — image manipulation
- `chalk` / `kleur` — pretty CLI output (optional)

## Anti-cheat clauses

- No "raster the whole page to canvas, paste as PDF image". The PDF MUST contain real text operators (`BT...ET`).
- No "punt SVGs by `<image>`-embedding them". SVG content must be re-emitted as PDF path operators (or at minimum kept as SVG-rendered-to-PDF-vector).
- No "fake links by drawing underlines". Every `<a href>` must produce a real PDF `/Subtype /Link` annotation.
- No "skip border-radius by drawing rectangles". Rounded corners must use cubic Bezier curves.
- No "approximate gradients with mid-tone fills". Linear gradients must use PDF axial shading.

These are checked by post-render assertions (`scripts/assertions.mjs`), not just visual diff.
