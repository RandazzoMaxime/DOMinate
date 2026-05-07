# Changelog — long-run iteration journal

Newest entries at the bottom. One section per accepted iteration.

Format:

```
## Iteration <N> — <ISO timestamp>

**Change:** <one-line summary>
**Files:** <comma-separated>
**Diff:** <before>% → <after>%   (✓ improved | ✗ regressed | = same)
**Gates:** links X/4 · text ok|FAIL · fonts ok|missing
**Notes:** <observations, next target>
```

---

## Iteration 0 — 2026-05-08T01:53:00Z (bootstrap)

**Change:** project skeleton + reference assets + ISO PDF specs + Node test harness
**Files:** README.md, SPEC.md, CONSTRAINTS.md, SUCCESS_CRITERIA.md, CLAUDE.md, package.json, scripts/loop.mjs, scripts/render-with-lib.mjs, scripts/pdf-to-png.mjs, scripts/diff.mjs, scripts/audit.mjs, scripts/serve-demo.mjs, demo/index.html, demo/run.html, src/index.js, .gitignore, assets/fonts/Inter-{Regular,SemiBold,Bold}.otf, assets/fonts/JetBrainsMono-Regular.ttf
**Diff:** n/a → 14.392% (12 8325 / 891 662 px)
**Gates:** links 0/4 · text FAIL · fonts missing
**Notes:** stub `htmlToPdf` returns minimal blank A4 landscape PDF (5 indirect objects, empty content stream). Harness end-to-end runs in ~0.8 s. First real iteration target: emit a header rectangle + the strings "FICHE DE CONTRÔLE", "Topo.ninja", "P001" using PDF base-14 Helvetica (no embedding required) so the diff drops below 14% and the audit's text gate flips to ok.
