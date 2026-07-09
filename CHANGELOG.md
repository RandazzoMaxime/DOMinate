# Changelog

All notable changes to DOMinate are documented here. The project follows semantic
versioning from the first public release.

## [1.0.0] - 2026-07-10

### Added

- First public open-source release under the MIT License.
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

[1.0.0]: https://github.com/RandazzoMaxime/DOMinate/releases/tag/v1.0.0
