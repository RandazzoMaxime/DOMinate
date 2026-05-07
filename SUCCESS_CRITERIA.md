# Success Criteria — the convergence target

The `/long-run` loop terminates when **all** of these are simultaneously true on `reference/source.html`.

## Visual fidelity (primary)

| Criterion | Threshold | Tool |
|-----------|-----------|------|
| Pixel-diff vs `reference/source.png` (96 DPI) | < 0.1% (< 891 px out of 891 562) | `pixelmatch` (alpha threshold 0.1) |
| Pixel-diff vs `reference/source@2x.png` (192 DPI) | < 0.5% | same |
| Page size matches A4 landscape | exactly 842 × 595 PDF user units (297 × 210 mm) | `pdfjs-dist` page bounds |
| Border-radius corners visually round | yes (2 mm radius on all `.card`, `.info-field`, etc.) | visual diff in those regions |
| Header gradient `linear-gradient(135deg, #289e22, color-mix...)` | rendered as axial shading | visual diff over the header rect |
| Padding/spacing exactly match | yes (same gaps, same margins) | visual diff |

User clarification (verbatim, 2026-05-08): *"quand je dis exactement pareil c'est couleur, format a4 paysage, arrondi, espaces padding etc"* — colors, A4 landscape format, rounded corners, padding/spacing must all be identical.

## Functional fidelity (secondary, hard requirement)

| Criterion | Threshold | Tool |
|-----------|-----------|------|
| All hyperlinks present as PDF link annotations | 4/4 | `pdfjs-dist` `getAnnotations()` |
| All text content extractable | 100% of visible text matches `source.html` extracted text | `pdfjs-dist` `getTextContent()` |
| Inter font embedded (subset) | yes, font name `Inter-Regular`, `Inter-Bold` | inspect `/FontDescriptor /FontFile2` |
| JetBrains Mono embedded for `.coord-mono` runs | yes | same |
| No raster fallback for layout | output PDF page 1 contains zero `Do` of full-page-size XObject | inspect content stream |
| File size reasonable | < 500 KB for the 1-page Fiche de contrôle | filesystem |

## Conformance (quality gates)

| Criterion | Threshold | Tool |
|-----------|-----------|------|
| PDF is valid per Adobe Acrobat / qpdf | no errors | `qpdf --check` |
| PDF/A or WTPDF tagging (optional bonus) | not required for convergence | — |
| Acrobat Reader displays without errors | yes | manual spot-check |

## Expected hyperlinks in the source

From `reference/source.html`:

1. `mailto:contact@topo.ninja` (in `.info-field` "Contact")
2. `https://topo.ninja` (footer left link)
3. `mailto:contact@topo.ninja` (footer center link)
4. `#sommaire` (footer right "Sommaire" pill — internal anchor; counted as named-destination link)

Target: 4 link annotations on page 1, each with the correct `/A /URI` (or `/Dest` for the named destination).

## How the loop measures progress

After each iteration the loop appends to `ITERATION_LOG.md`:

```
## Iteration 47 — 2026-05-08T14:32:11Z
- Change: implemented border-radius via cubic Bezier in render/borders.js
- Diff before: 1.84% (16 412 px)
- Diff after:  1.21% (10 783 px)  ✓ improved
- Links: 4/4 ✓
- Text:  812/812 ✓
- Notes: scheme card corners now round; tolerance/contact card corners still square (need to also clip background to rounded path)
```

The loop only commits an iteration if **diff strictly decreased OR a functional check went from fail→pass**.
