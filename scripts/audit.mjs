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
  const buf = await readFile(pdfPath);
  // pdfjsLib transfers ownership of the input buffer (sets length to 0 after
  // promise resolves). Make a defensive COPY for our raw byte scan, which runs
  // after the pdfjs document has been parsed.
  const dataForPdfjs = new Uint8Array(buf);
  const dataForScan = new Uint8Array(buf);  // separate copy
  const pdf = await pdfjsLib.getDocument({
    data: dataForPdfjs,
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
  // PDF extractors (pdfjs included) interpret wide TJ-array spacing as inter-letter
  // spaces. CSS `letter-spacing: 0.12em` thus comes back as "F I C H E" not "FICHE".
  // Match each fragment with whitespace-tolerant regex so audit accepts either form.
  const missing = expectations.expectedTextFragments.filter(f => {
    if (fullText.includes(f)) return false;
    // Build a regex from the fragment that allows arbitrary whitespace between any
    // two adjacent characters. Escape regex metacharacters in the fragment first.
    const pattern = f.split('').map(c => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*');
    return !new RegExp(pattern).test(fullText);
  });

  // Use a typed-array search instead of regex on the whole buffer — easier to reason about.
  const sig = (s) => {
    const u = new TextEncoder().encode(s);
    outer: for (let i = 0; i + u.length <= dataForScan.byteLength; i++) {
      for (let j = 0; j < u.length; j++) {
        if (dataForScan[i + j] !== u[j]) continue outer;
      }
      return true;
    }
    return false;
  };
  const hasFontFile2 = sig('/FontFile2');
  const hasInter = sig('Inter');
  const hasCIDFontType2 = sig('CIDFontType2');
  const fontsOk = hasFontFile2 && (hasInter || hasCIDFontType2);
  if (process.env.DEBUG_AUDIT) {
    console.error('[audit]', pdfPath, { len: dataForScan.byteLength, hasFontFile2, hasInter, hasCIDFontType2, fontsOk });
  }

  return {
    links: linkUris.length,
    expectedLinks: expectations.expectedLinks.length,
    linkUris,
    textOk: missing.length === 0,
    missingText: missing,
    fontsOk,
  };
}
