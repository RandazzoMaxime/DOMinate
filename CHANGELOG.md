# Changelog

All notable changes to DOMinate are documented here. The project follows semantic
versioning from the first public release.

## Unreleased

### Fixed

- Words laid out in condensed system fonts (Segoe, Bahnschrift, …) no longer
  overflow into the next word when painted with Inter — inter-word gaps stay.
- `html`/`body` canvas color is stamped on every PDF page, so leftover bands
  after a line-safe cut stay the page color instead of flashing white.
- Converter download uses a real filename (`*.pdf`) instead of the browser
  default `download`, and the button sits next to the file name.

### Changed

- Live converter defaults to A4 portrait. Importing HTML opens an accordion
  preview: first file expanded, HTML beside PDF, sized to the selected format.
  Clicking another row closes the previous preview.

## [1.1.0] - 2026-08-15

### Added

- Live GitHub Pages converter: drop one HTML file, a batch, or a folder, convert
  in the browser, download PDF or a zip. Nothing is uploaded.
- Competitive bench against html2canvas+jsPDF, html2pdf.js, html-to-image,
  jsPDF.html(), Playwright `page.pdf()` and Puppeteer `page.pdf()`.
- Local web-HTML dataset bench (`npm run dataset`) on 13 fixtures, including
  50+ page books. Source HTML stays gitignored and is never published.

### Changed

- Single-page documents skip unused pagination cuts.
- Public showcase invoice and SOW no longer mention other products.

[1.1.0]: https://github.com/RandazzoMaxime/DOMinate/releases/tag/v1.1.0

## [1.0.1] - 2026-07-10

### Changed

- Relicensed new distributions of DOMinate under Apache License 2.0.
- Added a `NOTICE` file so downstream distributions preserve project attribution.
- Updated package metadata and installation examples for `v1.0.1`.
- Replaced the converter comparison with a purpose-built DOMinate one-page
  showcase and a direct HTML-versus-DOMinate-PDF visual.

## [1.0.0] - 2026-07-10

### Added

- First public open-source release under the MIT License (superseded by the
  Apache-2.0 license for releases from v1.0.1 onward).
- Browser-side HTML to vector PDF conversion with zero runtime npm dependencies.
- Selectable/searchable text, lazy embedded fonts and `ToUnicode` maps.
- Clickable link annotations and vector CSS/SVG painting.
- Browser-native layout extraction across block, flex, grid, tables, floats,
  columns, positioning and multi-page documents.
- JPEG/PNG image support, gradients, borders, shadows, transforms, clipping,
  pseudo-elements and Material Symbols ligatures.
- Thirteen-fixture regression suite with 91 semantic/structural checks.
- Reproducible DOMinate vs Playwright benchmark and visual comparison.
- Contribution guide, security policy, issue templates and continuous integration.

### Known limitations

- No WOFF2 decoder, complex-script shaping, CSS filters/3D transforms or PDF-UA.
- Aggregate 96 DPI pixel difference across the 13 public reference fixtures is 0.643%;
  all text extraction, link and font-embedding checks pass.

[1.0.1]: https://github.com/RandazzoMaxime/DOMinate/releases/tag/v1.0.1
[1.0.0]: https://github.com/RandazzoMaxime/DOMinate/releases/tag/v1.0.0
