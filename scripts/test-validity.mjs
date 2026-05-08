// End-to-end test: every fixture's PDF must be valid (parsable by pdfjs), have the
// expected MediaBox dimensions, and contain at least one /Subtype /Link annotation.
// Run via: node scripts/test-validity.mjs

import { renderWithLib } from './render-with-lib.mjs';
import { auditPdf } from './audit.mjs';
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import kleur from 'kleur';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log(kleur.green('  ✓'), msg); }
  else { fail++; console.log(kleur.red('  ✗'), msg); }
}

async function testFixture(stem) {
  console.log(kleur.bold(`\n[${stem}]`));
  const htmlPath = resolve(ROOT, 'reference', stem + '.html');
  const auditPath = resolve(ROOT, 'reference', stem + '.audit.json');
  const exp = JSON.parse(await readFile(auditPath, 'utf8'));
  const vp = exp.viewport || { width: 1123, height: 794 };

  const t0 = Date.now();
  const pdf = await renderWithLib(htmlPath, vp);
  const dt = Date.now() - t0;

  // 1. PDF magic bytes
  const magic = String.fromCharCode(...pdf.slice(0, 5));
  assert(magic === '%PDF-', `magic bytes %PDF- (got ${magic})`);

  // 2. PDF size sane
  assert(pdf.byteLength > 1000, `size > 1 KB (got ${(pdf.byteLength / 1024).toFixed(1)} KB)`);
  assert(pdf.byteLength < 5_000_000, `size < 5 MB`);

  // 3. End marker
  const tail = String.fromCharCode(...pdf.slice(-7));
  assert(tail.includes('%%EOF'), `tail contains %%EOF`);

  // 4. Audit gates
  await mkdir(resolve(ROOT, 'dist'), { recursive: true });
  const pdfPath = resolve(ROOT, 'dist', stem + '.pdf');
  await writeFile(pdfPath, pdf);
  const audit = await auditPdf(pdfPath, exp);
  assert(audit.links === audit.expectedLinks, `links ${audit.links}/${audit.expectedLinks}`);
  assert(audit.textOk, `text fragments present (missing: ${audit.missingText.length})`);
  assert(audit.fontsOk, `fonts embedded (FontFile2 + Inter detected)`);

  console.log(kleur.dim(`  ${dt}ms · ${(pdf.byteLength / 1024).toFixed(1)} KB`));
}

const fixtures = (await readdir(resolve(ROOT, 'reference')))
  .filter(f => f.endsWith('.html'))
  .map(f => basename(f, '.html'))
  .sort();

for (const stem of fixtures) {
  try { await testFixture(stem); }
  catch (e) { fail++; console.error(kleur.red(`  ✗ threw: ${e.message}`)); }
}

console.log();
console.log(kleur.bold(`Total: ${pass} pass, ${fail} fail`));
process.exit(fail > 0 ? 1 : 0);
