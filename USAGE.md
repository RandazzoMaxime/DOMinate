# Usage

## Browser (in your app)

```html
<script type="module">
  import { htmlToPdf } from './node_modules/html-to-pdf-client/src/index.js';

  // Convert any HTML string into a PDF (Uint8Array).
  const html = document.getElementById('my-doc').outerHTML;
  const bytes = await htmlToPdf(html, {
    viewport: { width: 1123, height: 794 },  // A4 landscape in CSS px
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
- Loads the HTML into a hidden iframe at `viewport` size
- Walks every element, capturing computed styles + Range geometry
- Emits a vector-only PDF: real text (BT…ET ops with embedded Inter CIDFontType2),
  real link annotations (`/Subtype /Link`), real path geometry (rectangles, rounded
  corners, gradients, SVG shapes, dashed borders, transparency)

## What's supported

- Text: any Unicode in Inter Latin + Greek subsets (~250 glyphs incl. ΔΣΩ, accented Latin)
- CSS layout: anything the browser's own layout engine produces (block, flex, grid, table)
- CSS fill: solid colors, linear-gradient (axial PDF shading), opacity, color() / color-mix()
- CSS borders: solid, dashed, dotted, with per-corner border-radius
- CSS letter-spacing, text-transform, line-height
- SVG: `<rect>`, `<line>`, `<circle>`, `<ellipse>`, `<text>`, `<g transform>`
- Hyperlinks: `<a href>` becomes a `/Subtype /Link` annotation with `/A /URI`
- `<img>`: JPEG passthrough as `XObject /DCTDecode` (PNG decoding TODO)
- `<input>`/`<select>`/`<textarea>` placeholders + values

## What's not (yet)

- PNG image decoding (only JPEG works currently)
- Box-shadow, backdrop-filter, filter
- 3D transforms
- Icon fonts via OpenType ligatures (Material Symbols, Font Awesome)
- Multi-page output (currently emits single page sized to viewport)
- Custom @font-face from URL (only the bundled Inter + Greek subsets)

## Bundled fonts

Bundled in `assets/fonts/`:

| File | Size | Coverage |
|------|------|----------|
| `Inter-{400,500,600,700}.ttf` | ~68 KB each | Latin |
| `Inter-{400,500,600,700}-greek.ttf` | ~16 KB each | Greek (incl. Δ) |
| `JetBrainsMono-Regular.ttf` | 270 KB | Monospace fallback |

All TTFs are static instances from [fontsource](https://fontsource.org). Variable
fonts are NOT used — most PDF readers don't honor variable axes.

## Vector fidelity guarantee

The output PDF contains:

- **Real text** — `BT (Hello) Tj ET` operators referencing embedded fonts, NOT
  rasterized canvas pixels. Use Ctrl+F in a PDF reader to confirm.
- **Real link annotations** — clickable hyperlinks with `/Subtype /Link` + `/A /URI`.
  Try clicking them in Acrobat or any modern reader.
- **Real geometry** — rectangles, paths, gradients are PDF operators (`re`, `m`, `l`,
  `c`, `f`, `S`, `sh`), not embedded images.
- **Embedded fonts** — Inter is parsed (SFNT), shaped to GIDs via the cmap table,
  and embedded as `/CIDFontType2` with `/Identity-H` encoding and a `ToUnicode`
  CMap so text extraction recovers the original codepoints.

There is NO fallback to "rasterize the page to a canvas, embed as image". That's the
opposite of what this lib does.

## License / authorship

Built end-to-end in a 3-hour `/long-run` session (2026-05-08 02:13 → 05:15 UTC+1).
No third-party PDF libraries in `src/` — see `CONSTRAINTS.md` for the rules.
