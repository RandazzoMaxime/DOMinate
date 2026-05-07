// Inspect the lib's output PDF: count link annotations, extract text, check fonts.
// Used as functional gates by the convergence loop.
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');

const EXPECTED_LINKS = [
  'mailto:contact@topo.ninja',
  'https://topo.ninja',
  'mailto:contact@topo.ninja',
  '#sommaire',
];

const EXPECTED_TEXT_FRAGMENTS = [
  'FICHE DE CONTRÔLE',
  'Topo.ninja',
  'P001',
  'Client Démo',
  'DEMO-2026-001',
  'Site exemple',
  'Jean Dupont',
  '08/05/2026',
  'EPSG:3942',
  '2179485.989',
  'ΔX', 'ΔY', 'ΔZ',
  'Sommaire',
  '1 / 1',
];

export async function auditPdf(pdfPath) {
  const data = new Uint8Array(await readFile(pdfPath));
  const pdf = await pdfjsLib.getDocument({
    data,
    standardFontDataUrl: require.resolve('pdfjs-dist/package.json').replace(/package\.json$/, 'standard_fonts/'),
  }).promise;

  const page = await pdf.getPage(1);

  const annots = await page.getAnnotations();
  const linkUris = annots
    .filter(a => a.subtype === 'Link')
    .map(a => a.url || a.unsafeUrl || a.dest || '')
    .filter(Boolean);

  const textContent = await page.getTextContent();
  const fullText = textContent.items.map(i => i.str).join(' ');
  const missing = EXPECTED_TEXT_FRAGMENTS.filter(f => !fullText.includes(f));
  const textOk = missing.length === 0;

  // pdfjs commonObjs exposes embedded fonts after rendering. Without rendering we can
  // still introspect via the page operatorList — but a simpler proxy: scan raw bytes
  // for /FontFile2 markers (TTF embedding) and Inter/JetBrains in font names.
  const raw = Buffer.from(data);
  const rawStr = raw.toString('latin1');
  const fontsOk = /\/FontFile2\b/.test(rawStr)
    && /Inter/.test(rawStr);

  return {
    links: linkUris.length,
    expectedLinks: EXPECTED_LINKS.length,
    linkUris,
    textOk,
    missingText: missing,
    fontsOk,
  };
}
