# Contributing to DOMinate

Thanks for helping make browser-side PDF generation more accurate and useful.
Bug reports, reduced HTML fixtures, documentation improvements and code changes
are all welcome.

## Before opening an issue

1. Search existing issues and discussions.
2. Reduce the problem to the smallest HTML/CSS document that still reproduces it.
3. Confirm it on the latest `main` branch.
4. Include the browser/OS, expected behavior, actual PDF, and whether text, links
   or fonts are affected in addition to appearance.

Security vulnerabilities should follow [SECURITY.md](SECURITY.md), not a public issue.

## Development setup

```bash
git clone https://github.com/RandazzoMaxime/DOMinate.git
cd DOMinate
npm install
npx playwright install chromium
npm test
npm run loop
```

Node 20 or newer is required. Runtime code belongs in `src/`; dependencies used
only for the test and measurement harness belong in `devDependencies`.

## Pull requests

- Keep each pull request focused on one behavior.
- Add or reduce a fixture under `reference/` for rendering changes.
- Do not replace vector output with a rasterized page or fake links with painted text.
- Do not add a third-party PDF generator to runtime code.
- Run `npm test` and `npm run loop` before submitting.
- Report before/after pixel difference for visual changes.
- Update public documentation when the API or support matrix changes.

For a new visual fixture, add matching `.html`, `.png` and `.audit.json` files.
Generate the browser reference with `node scripts/make-reference.mjs`, then verify
that text extraction, links and embedded fonts still pass.

## Commit style

Use a short imperative subject, for example:

```text
fix: preserve nested SVG clip transforms
docs: clarify public font asset setup
test: add reduced grid overflow fixture
```

By contributing, you agree that your contribution may be distributed under the
project's Apache License 2.0.
