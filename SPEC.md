# Architecture

DOMinate is an ES module that runs in a browser. Its public API accepts an HTML
string or element and resolves to a `Uint8Array` containing a PDF 1.7 document.

## Pipeline

```text
HTML
  → hidden same-origin iframe
  → browser-computed layout and styles
  → flat paint list
  → PDF drawing/text operators and resource objects
  → xref, page tree and catalog
  → Uint8Array
```

### Layout extraction

`src/dom/walker.js` loads the input in a hidden iframe sized to the requested page.
It waits for fonts/resources and a stable layout, then records geometry from
`getBoundingClientRect`, `Range` and computed styles. The browser therefore owns
CSS layout behavior such as flexbox, grid, tables, wrapping and positioning.

### Painting

`src/render/painter.js` turns the ordered boxes into PDF content streams. It emits
text operators, paths, clipping, graphics states, gradients, images and link
annotations. `src/render/svg.js` translates supported SVG geometry to PDF paths.

### PDF writer

`src/core/pdf.js` creates indirect objects, resources, pages, annotations, xref and
the catalog directly. It does not call an external PDF generator.

### Fonts and images

- `src/core/fonts/` parses SFNT data, maps Unicode to glyph IDs and embeds composite
  fonts with `ToUnicode` maps.
- `src/core/images/jpeg.js` passes JPEG data through as `DCTDecode`.
- `src/core/images/png.js` decodes PNG filters and alpha before PDF embedding.

## Coordinates

Layout uses CSS pixels with a top-left origin. PDF uses 72-DPI user units with a
bottom-left origin. DOMinate maps 96 CSS pixels per inch to 72 PDF points per inch.

## Page model

Content higher than the viewport is divided into horizontal bands. Page cuts move
up when needed to keep text lines intact. Each page receives its own content stream
and annotations while sharing reusable font, image and shading resources.

## Design invariants

1. Text remains text.
2. Links remain annotations.
3. Vector source remains vector whenever the feature is supported.
4. The full page is never rasterized as a fallback.
5. Runtime code under `src/` has no third-party dependencies.
