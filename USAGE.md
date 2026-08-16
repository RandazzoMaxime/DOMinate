# Usage

## Install from the v1 GitHub release

```bash
npm install github:RandazzoMaxime/DOMinate#v1.1.1
```

DOMinate v1 loads its bundled fonts from `/assets/fonts`. Copy
`node_modules/@randazzomaxime/dominate/assets` into the public root of your app so
those URLs are served from the same origin.

For local development of DOMinate itself:

```bash
npm install
npx playwright install chromium
npm run demo
```

## Convert and download

```js
import { htmlToPdf } from '@randazzomaxime/dominate';

const html = `<!doctype html>
<html>
  <head>
    <style>
      body { font-family: Inter, sans-serif; padding: 32px; }
      h1 { color: #166534; }
    </style>
  </head>
  <body>
    <h1>Invoice #1042</h1>
    <a href="https://example.com/invoices/1042">Open online</a>
  </body>
</html>`;

const bytes = await htmlToPdf(html, {
  pageSize: 'A4',
  orientation: 'portrait',
});

const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
const anchor = Object.assign(document.createElement('a'), {
  href: url,
  download: 'invoice-1042.pdf',
});
anchor.click();
setTimeout(() => URL.revokeObjectURL(url), 1000);
```

The function resolves to a `Uint8Array` containing a PDF 1.7 document.

## API

```ts
htmlToPdf(
  input: string | HTMLElement,
  options?: {
    viewport?: { width: number; height: number };
    pageSize?: 'A4';
    orientation?: 'portrait' | 'landscape';
    colorScheme?: 'dark' | 'light';
  }
): Promise<Uint8Array>
```

- `input`: a complete HTML string is recommended because it can include styles,
  font declarations and document metadata. An `HTMLElement` is converted through
  its `outerHTML`.
- `viewport`: explicit page dimensions in CSS pixels. This takes precedence over
  `pageSize` and `orientation`.
- `pageSize`: currently `A4`; defaults to A4 landscape when no size is provided.
- `orientation`: `portrait` or `landscape` for A4.
- `colorScheme`: `'dark'` or `'light'` to force the layout iframe's preferred
  scheme (so `@media (prefers-color-scheme: dark)` and `data-theme="dark"`
  documents paint that canvas). When omitted, follows the host page / OS.

CSS pixels are mapped to PDF points at 96 CSS DPI → 72 PDF DPI.

## Pagination

Content taller than the selected viewport is split across pages. DOMinate moves a
cut upward when necessary to avoid slicing through a text line.

Use an explicit page-break marker when the document needs author-controlled cuts:

```html
<section>Page one</section>
<div class="page-break"></div>
<section>Page two</section>
```

The aliases `pagebreak`, `break-page`, `[data-page-break]`, inline
`break-before: page` and inline `page-break-before: always` are also recognized.

## Supported in v1

- Browser-computed block, flex, grid, table, float, columns and positioned layout.
- Real text, font weights, common Latin/Greek coverage, monospace/display faces,
  Material Symbols ligatures, decorations and basic synthetic oblique text.
- CSS paint order, z-index, opacity, overflow clips and 2D transforms.
- Per-side borders, common border styles, rounded corners, shadows and outlines.
- Solid, multi-stop linear/radial and image backgrounds.
- JPEG, PNG with alpha, `object-fit` and repeated backgrounds.
- SVG shapes and paths (`M/L/H/V/C/S/Q/T/A/Z`), transforms and stroke styles.
- `::before` / `::after` string, `attr()` and quote content; list markers; common
  form values and placeholders.
- URI/mail links as real PDF annotations.

## Known limits

- WOFF2 decoding and variable-font axis instancing.
- BiDi/RTL shaping and complex scripts such as Arabic and Indic.
- CSS filters, backdrop filters, 3D transforms and `column-rule`.
- CSS counters in pseudo-content and full paragraph-level `break-inside` control.
- Full accessibility tagging / PDF-UA conformance.

There is intentionally no canvas/screenshot fallback. Unsupported paint is skipped
instead of silently flattening the whole document and losing text or links.
