# Iteration Log

The `/long-run` autonomous loop appends one section per iteration. Newest entries at the bottom.

Each entry must include:

```
## Iteration <N> — <ISO timestamp>
- Change: <one-line summary of what was modified>
- Files: <list>
- Diff before: <X.XX%>
- Diff after:  <Y.YY%>  ✓/✗
- Functional gates: links X/Y, text X/Y, fonts ok/missing
- Notes: <short observations or next target>
```

---

## Iteration 0 — 2026-05-08 (bootstrap)

- Change: project skeleton, reference assets, ISO PDF specs imported, scripts scaffolded
- Files: README.md, SPEC.md, CONSTRAINTS.md, SUCCESS_CRITERIA.md, package.json, scripts/*, src/index.js (stub), demo/*
- Diff before: n/a (no output yet)
- Diff after:  100% (lib produces empty/placeholder PDF)
- Functional gates: links 0/4, text 0/N, fonts missing
- Notes: starting point. First real iteration must produce ANY valid one-page PDF that opens in Acrobat, even if blank — that gives the loop a baseline to subtract from.
