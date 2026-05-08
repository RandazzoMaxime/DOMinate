#!/usr/bin/env node
// One iteration of the convergence loop.
//
// Runs the lib against EVERY HTML fixture in reference/ (matching reference/*.html)
// and reports per-fixture diff + overall pass. The lib must work for ALL fixtures
// (not just one), per the user's "fonctionnel pour tout html" requirement.

import { renderWithLib } from './render-with-lib.mjs';
import { rasterize } from './pdf-to-png.mjs';
import { diffPngs } from './diff.mjs';
import { auditPdf } from './audit.mjs';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import kleur from 'kleur';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = resolve(ROOT, 'dist');
const REFERENCE = resolve(ROOT, 'reference');

async function main() {
  await mkdir(DIST, { recursive: true });

  const fixtures = (await readdir(REFERENCE))
    .filter(f => f.endsWith('.html'))
    .sort();

  if (fixtures.length === 0) {
    console.error('no fixtures in reference/');
    process.exit(1);
  }

  const t0 = Date.now();
  const results = [];

  for (const f of fixtures) {
    const stem = basename(f, '.html');
    const htmlPath = resolve(REFERENCE, f);
    const refPng = resolve(REFERENCE, stem + '.png');
    const auditPath = resolve(REFERENCE, stem + '.audit.json');

    const expectations = JSON.parse(await readFile(auditPath, 'utf8'));
    const viewport = expectations.viewport || { width: 1123, height: 794 };
    const screenshotScale = expectations.screenshotScale || 1;

    const pdfBytes = await renderWithLib(htmlPath, viewport);
    const pdfPath = resolve(DIST, stem + '.pdf');
    await writeFile(pdfPath, pdfBytes);

    const pngPath = resolve(DIST, stem + '.png');
    const { width, height } = await rasterize(pdfPath, pngPath, { dpi: 96 * screenshotScale });

    const diff = await diffPngs(refPng, pngPath, resolve(DIST, stem + '.diff.png'));
    const audit = await auditPdf(pdfPath, expectations);

    const passed = diff.percent < 0.1
      && audit.links === audit.expectedLinks
      && audit.textOk
      && audit.fontsOk;

    results.push({ stem, diff, audit, pdfBytes, width, height, passed });
  }

  const dt = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(kleur.bold(`[loop ${dt}s — ${fixtures.length} fixtures]`));
  let allPassed = true;
  let totalDiffPx = 0;
  let totalPx = 0;
  for (const r of results) {
    totalDiffPx += r.diff.diffPx;
    totalPx += r.diff.totalPx;
    allPassed = allPassed && r.passed;
    const line = [
      `  ${r.stem.padEnd(16)}`,
      `diff ${r.diff.percent.toFixed(3).padStart(7)}% (${r.diff.diffPx}/${r.diff.totalPx})`,
      `links ${r.audit.links}/${r.audit.expectedLinks}`,
      `text ${r.audit.textOk ? 'ok' : 'FAIL'}`,
      `fonts ${r.audit.fontsOk ? 'ok' : 'missing'}`,
      `pdf ${(r.pdfBytes.byteLength / 1024).toFixed(1)} KB`,
      r.passed ? kleur.green().bold('✓') : kleur.yellow('·'),
    ].join(' | ');
    console.log(line);
  }
  const overallPct = (totalDiffPx / totalPx) * 100;
  console.log(kleur.bold(`  overall:          diff ${overallPct.toFixed(3).padStart(7)}% (${totalDiffPx}/${totalPx}) ${allPassed ? kleur.green().bold('✓ PASS') : kleur.yellow('iterating')}`));

  return { passed: allPassed, results };
}

main().catch(err => { console.error(err); process.exit(1); });
