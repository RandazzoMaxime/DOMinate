# HTML_TO_PDF_CLIENT

A from-scratch, **client-side**, vector-fidelity HTML→PDF rendering library.

## Goal

Convert any HTML+CSS document into a PDF that is **pixel-identical** to what a Chromium-based browser (Playwright `page.pdf()`) would produce — but **entirely in the browser**, with **zero server**, **zero third-party PDF libraries**, and **zero canvas rasterization**.

Output PDFs MUST preserve:

- Real, selectable, vector text (with the original fonts subsetted and embedded)
- Real, clickable hyperlinks (PDF link annotations, not raster screenshots)
- Real vector geometry (rectangles, paths, gradients) — no flattening to bitmaps
- Real images (only true raster images get embedded as images)
- A4 landscape page geometry (297 × 210 mm)
- All visual details: colors, border-radius, padding/spacing, gradients, typography

## Reference target

The single test fixture against which we converge is:

- `reference/source.html` — a Topo.ninja "Fiche de contrôle" Business template (A4 landscape, real-world business document with header gradient, info grid, tables, SVG technical diagram, footer with mailto/href links)
- `reference/source.png` — Chromium-rendered PNG screenshot at 96 DPI (1123×794), the ground truth
- `reference/source@2x.png` — same at 192 DPI for fine typography diff

## Convergence criterion

The autonomous `/long-run` loop iterates until **pixel-diff against `reference/source.png` is below 0.1%** (≤ ~890 differing pixels out of 891K total) AND **all functional checks pass**:

- All hyperlinks present and clickable
- All text content extractable and selectable
- Page size is exactly 297 × 210 mm
- Font is Inter (the document's specified family) embedded in PDF

## Project layout

```
S:/HTML_TO_PDF_CLIENT/
├── README.md                 ← this file
├── SPEC.md                   ← architectural spec
├── CONSTRAINTS.md            ← what we may NOT use
├── SUCCESS_CRITERIA.md       ← convergence target
├── ITERATION_LOG.md          ← long-run journal (appended each iteration)
├── package.json              ← Node deps for the test loop only
├── reference/
│   ├── source.html           ← target HTML
│   ├── source.png            ← ground-truth screenshot 96 DPI
│   └── source@2x.png         ← ground-truth screenshot 192 DPI
├── specs/
│   ├── ISO_32000-2_*.pdf     ← PDF 2.0 ISO authoritative spec
│   ├── PDF-Declarations.pdf  ← PDF declarations spec
│   └── Well-Tagged-PDF-WTPDF-1.0.pdf ← Well-Tagged PDF spec
├── src/                      ← library source (browser ES modules)
│   ├── index.js              ← public API: htmlToPdf(html|node, opts) → Uint8Array
│   ├── core/                 ← PDF object model, encoding, fonts, images
│   ├── css/                  ← CSS parsing, selector matching, cascade
│   ├── layout/               ← box model, flow, inline (text wrap), flex, grid, table, pagination
│   ├── render/               ← walks layout tree → emits PDF content streams
│   └── dom/                  ← HTML parsing into a render tree
├── scripts/                  ← Node test-loop tooling
│   ├── loop.mjs              ← run one iteration: build → render → diff → report
│   ├── render-with-lib.mjs   ← spawn Chromium, load lib, get PDF bytes back
│   ├── pdf-to-png.mjs        ← rasterize the lib's PDF output for diff
│   └── diff.mjs              ← pixelmatch report
├── demo/
│   ├── index.html            ← live browser playground
│   └── run.html              ← used by render-with-lib.mjs
└── dist/
    ├── output.pdf            ← latest lib output
    └── output.png            ← latest lib output rasterized
```

## Running the loop

```bash
npm install
npm run loop      # one iteration
npm run watch     # rebuild + re-diff on file change
```

Each iteration prints:

```
[iter N] diff: 23456 px (0.34%) | links: 6/6 | text: 1234/1234 chars
```

Convergence stops when diff < 0.1%.

## How the long-run autonomous loop uses this

The `/long-run` skill iteratively:

1. Reads `reference/source.png` and the latest `dist/output.png`
2. Identifies the largest visual delta (e.g. "header gradient missing", "table rows mis-aligned by 2px", "border-radius not rendered")
3. Implements the smallest change in `src/` that closes that delta
4. Runs `npm run loop`
5. Commits if diff decreased, otherwise reverts
6. Updates `ITERATION_LOG.md`
7. Repeats until convergence
