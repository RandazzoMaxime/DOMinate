# CLAUDE.md — Long-run loop rule book

> Authoritative spec for every iteration of the autonomous loop.
> Read this BEFORE every iteration.
> Companion files: README.md (overview), SPEC.md (architecture), CONSTRAINTS.md (forbidden libs), SUCCESS_CRITERIA.md (exit), CHANGELOG.md (iteration journal).

## Mode

**STANDARD** — we have a reference (`reference/source.png`, Chromium ground-truth at 96 DPI) and a measurable convergence criterion (pixel-diff < 0.1%).

## Objective (one line)

Build, in `src/`, a from-scratch client-side library that converts `reference/source.html` into a PDF whose 96 DPI rasterization is pixel-identical to `reference/source.png`, while preserving real vector text, embedded subsetted fonts, and clickable link annotations.

## Exit criterion (the only one that closes the loop)

```
npm run loop
# must print: diff <0.100% | links 4/4 | text ok | fonts ok | ✓ PASS
```

`scripts/loop.mjs` is the gate. It runs in ~1 second:
1. Spawns headless Chromium via Playwright
2. Loads `demo/run.html`, dynamically imports `src/index.js`
3. Calls `htmlToPdf(reference/source.html)` → `Uint8Array`
4. Writes `dist/output.pdf`
5. Rasterizes to `dist/output.png` (96 DPI, pdfjs-dist + @napi-rs/canvas)
6. Pixel-diff vs `reference/source.png` (pixelmatch, threshold 0.1)
7. Audit annotations (4 expected URIs), text content, font embedding
8. Reports a one-line score

## How each iteration MUST work

1. **Read CHANGELOG.md** — note current diff %, identify the next biggest visual delta from `dist/diff.png`
2. **Read the relevant ISO spec section** for the operator/object you need (`specs/ISO_32000-2_sponsored-ec2.pdf`)
3. **Implement the smallest code change** that closes that delta
4. **Run** `npm run loop` and capture before/after diff
5. **Commit ONLY if diff strictly decreased OR a functional gate flipped fail→pass**
6. **Append** to CHANGELOG.md a section with: change summary, files touched, diff before/after, functional gates state, next-target note
7. **Repeat**

If `npm run loop` errors (not just iterates), fix the error first — that is the iteration.

## Suggested iteration order (high-leverage first)

1. **Iter 1** — minimal valid PDF: catalog + 1 page + content stream + a single `BT (Hello) Tj ET` using Helvetica (PDF base 14 font, no embedding needed). Establishes the writer.
2. **Iter 2** — DOM walker + computed style: build a render tree from `reference/source.html` exposing each element's used color/border/padding/font.
3. **Iter 3** — block layout (vertical flow): compute box positions for the document's outer flex container.
4. **Iter 4** — solid backgrounds + rounded corners: paint `.page-inner`, `.card`, `.info-field` etc. with `border-radius: 2-3 mm`.
5. **Iter 5** — flexbox horizontal: solve `.body-wrap` (left-cont:5 / right-cont:4).
6. **Iter 6** — text rendering with Helvetica baseline (still no Inter): get all visible text laid out, even with wrong typography.
7. **Iter 7** — font embedding: parse Inter-Regular.otf, subset, embed as CIDFontType2, switch text from Helvetica to Inter.
8. **Iter 8** — bold + semibold variants + JetBrains Mono for `.coord-mono`.
9. **Iter 9** — header gradient (axial PDF shading) + `.axis-id` solid fill block.
10. **Iter 10** — table layout (header row + body rows for `.coords-table`, `.deltas-table`).
11. **Iter 11** — CSS Grid for `.project-info` 4-column.
12. **Iter 12** — link annotations: 4 `/Subtype /Link` rects on the right boxes.
13. **Iter 13** — SVG → PDF path translation (the surveying scheme).
14. **Iter ≥14** — diff-driven cleanup: read `dist/diff.png`, fix the largest red region.

This order is a suggestion, not a contract. The loop's real target is `npm run loop ✓ PASS`.

## Hard constraints (CONSTRAINTS.md, summarized)

In `src/`:
- ❌ `jspdf`, `pdfkit`, `pdf-lib`, `html2canvas`, `html2pdf`, `paged.js`, `weasyprint*`, `puppeteer*`, `playwright*`, `opentype.js`, `fontkit`, `mupdf*`, `pdfium*`
- ❌ Rasterizing the layout to a canvas image and embedding that
- ❌ Producing fake links by drawing underlines

In `scripts/` (test loop only): `playwright`, `pdfjs-dist`, `pixelmatch`, `pngjs`, `@napi-rs/canvas`, `kleur` are allowed.

## Out-of-scope (do not do these unless the loop demands it)

- CSS floats, multi-column, vertical-rl writing-mode
- `filter:`, `backdrop-filter:`, 3D transforms
- WOFF2 decoder (we ship local Inter as OTF, JetBrains Mono as TTF)
- HTML video, iframe, form elements
- PDF/A or WTPDF tagging beyond what the audit requires

## Git discipline

- One commit per accepted iteration.
- Commit subject: `iter <N>: <one-line summary> — diff <before>%→<after>%`
- Body: bullet list of files touched + functional gate transitions
- NEVER commit a regression. Revert and try a different angle.

## File map (the long-run code lives here)

```
src/
├── index.js              ← public entry. Replace stub.
├── core/
│   ├── pdf.js            ← writer: objects, xref, content streams
│   ├── encoding.js       ← FlateDecode (CompressionStream), Ascii85
│   ├── primitives.js     ← drawing/text op emitters
│   ├── fonts/
│   │   ├── sfnt.js       ← TTF/OTF parser (head, hhea, hmtx, cmap, glyf, loca, name, OS/2, post)
│   │   ├── subset.js     ← keep used glyphs, rewrite tables
│   │   └── embed.js      ← emit Type0/CIDFontType2 + ToUnicode CMap
│   └── images/           ← jpeg passthrough, png re-encode
├── css/
│   ├── parser.js         ← tokenizer + AST
│   ├── selector.js       ← uses Element.matches()
│   ├── cascade.js        ← specificity, inheritance
│   └── computed.js       ← used values per node
├── layout/
│   ├── box.js            ← content/padding/border/margin
│   ├── flow.js           ← block formatting context
│   ├── inline.js         ← line boxes, soft-wrap
│   ├── flex.js           ← flexbox
│   ├── grid.js           ← grid
│   ├── table.js          ← table
│   └── pagination.js     ← page-break
├── render/
│   ├── painter.js        ← walks layout tree → PDF ops
│   ├── text.js           ← BT/ET, glyph advances, kerning
│   ├── borders.js        ← border + radius (cubic Bezier corners)
│   ├── backgrounds.js    ← solid + linear-gradient (axial shading)
│   └── links.js          ← /Annot /Link annotations
└── dom/
    ├── parser.js         ← uses DOMParser
    └── builder.js        ← DOM → render tree
```

## Reading the diff image

`dist/diff.png` overlays differing pixels in red on a faded version of the candidate.
- A red region in the header → gradient or text rendering broken there
- Red along card edges → border-radius missing/wrong
- Red inside cells → font/baseline/positioning off
- Red rectangles where links should be → that's just the diff being unhelpful, the link annotation isn't visible — check `audit.linkUris`

## Stop conditions

- `✓ PASS` printed by `npm run loop` → declare convergence, write a final summary in CHANGELOG.md, exit.
- Same approach attempted twice with no progress → step back, read SPEC.md, pick a different attack.
- Test loop itself is broken → fix that first; do not touch `src/` while the harness is red.

## Never

- Reduce or weaken the exit criterion
- Modify the audit thresholds in `scripts/audit.mjs` to make a check pass
- Modify `reference/source.html` or `reference/source.png` to make the diff smaller
- Add `// TODO` placeholders that produce wrong output silently
