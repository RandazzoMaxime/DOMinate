// Inspect a generated PDF and a per-fixture audit JSON; return functional gate state.
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');

/**
 * @param {string} pdfPath
 * @param {{expectedLinks: string[], expectedTextFragments: string[]}} expectations
 */
export async function auditPdf(pdfPath, expectations) {
  const data = new Uint8Array(await readFile(pdfPath));
  const pdf = await pdfjsLib.getDocument({
    data,
    standardFontDataUrl: require.resolve('pdfjs-dist/package.json').replace(/package\.json$/, 'standard_fonts/'),
  }).promise;

  // For multi-page docs, we audit page 1 (where header/footer/main content lives in our test fixtures).
  const page = await pdf.getPage(1);

  const annots = await page.getAnnotations();
  const linkUris = annots
    .filter(a => a.subtype === 'Link')
    .map(a => a.url || a.unsafeUrl || a.dest || '')
    .filter(Boolean);

  const textContent = await page.getTextContent();
  const fullText = textContent.items.map(i => i.str).join(' ');
  const missing = expectations.expectedTextFragments.filter(f => !fullText.includes(f));

  const raw = Buffer.from(data).toString('latin1');
  const fontsOk = /\/FontFile2\b/.test(raw) && /Inter/.test(raw);

  return {
    links: linkUris.length,
    expectedLinks: expectations.expectedLinks.length,
    linkUris,
    textOk: missing.length === 0,
    missingText: missing,
    fontsOk,
  };
}
