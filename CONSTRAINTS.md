# Project principles

DOMinate exists to provide a vector-first, client-side alternative to HTML-to-PDF
pipelines that depend on a server or flatten the page into pixels.

## Runtime rules

Code under `src/` must not depend on:

- third-party PDF writers such as jsPDF, PDFKit, pdf-lib or pdfmake;
- page rasterizers such as html2canvas, html2pdf.js or dom-to-image;
- headless-browser clients such as Playwright or Puppeteer;
- native/WASM PDF engines used for generation;
- third-party font parsers used for production embedding.

Native browser primitives are expected: DOM APIs, computed styles, `Range`,
`fetch`, `CompressionStream` / `DecompressionStream` and typed arrays.

## Output invariants

- Text must use PDF text operators and remain selectable/searchable.
- HTML links must become `/Subtype /Link` annotations.
- SVG and CSS geometry should become PDF paths/shadings, not screenshots.
- Raster images may remain raster images; the document layout may not be flattened.
- Unsupported behavior must be documented and tested when practical.

## Development tools

The test harness under `scripts/` may use Playwright, PDF.js, pixelmatch, PNG tools
and canvas bindings. These dependencies verify output and never ship in runtime
code.
