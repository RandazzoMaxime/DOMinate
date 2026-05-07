#!/usr/bin/env node
// One iteration of the convergence loop:
//   1. spawn headless Chromium, load demo/run.html which imports src/index.js
//      and calls htmlToPdf(reference/source.html) → Uint8Array
//   2. write dist/output.pdf
//   3. rasterize page 1 → dist/output.png at 96 DPI
//   4. pixel-diff vs reference/source.png
//   5. extract annotations + text, count vs expected
//   6. print a one-line summary

import { renderWithLib } from './render-with-lib.mjs';
import { rasterize } from './pdf-to-png.mjs';
import { diffPngs } from './diff.mjs';
import { auditPdf } from './audit.mjs';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import kleur from 'kleur';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = resolve(ROOT, 'dist');
const REFERENCE_PNG = resolve(ROOT, 'reference', 'source.png');
const REFERENCE_HTML = resolve(ROOT, 'reference', 'source.html');

async function main() {
  await mkdir(DIST, { recursive: true });

  const t0 = Date.now();

  // 1. produce PDF
  const pdfBytes = await renderWithLib(REFERENCE_HTML);
  const pdfPath = resolve(DIST, 'output.pdf');
  await writeFile(pdfPath, pdfBytes);

  // 2. rasterize
  const pngPath = resolve(DIST, 'output.png');
  const { width, height } = await rasterize(pdfPath, pngPath, { dpi: 96 });

  // 3. pixel diff
  const diff = await diffPngs(REFERENCE_PNG, pngPath, resolve(DIST, 'diff.png'));

  // 4. audit (links, text, fonts)
  const audit = await auditPdf(pdfPath);

  const dt = ((Date.now() - t0) / 1000).toFixed(1);

  // 5. report
  const passed = diff.percent < 0.1
    && audit.links === audit.expectedLinks
    && audit.textOk
    && audit.fontsOk;

  const line = [
    kleur.bold(`[loop ${dt}s]`),
    `diff ${diff.percent.toFixed(3)}% (${diff.diffPx}/${diff.totalPx})`,
    `links ${audit.links}/${audit.expectedLinks}`,
    `text ${audit.textOk ? 'ok' : 'FAIL'}`,
    `fonts ${audit.fontsOk ? 'ok' : 'missing'}`,
    `pdf ${(pdfBytes.byteLength / 1024).toFixed(1)} KB`,
    `page ${width}x${height}`,
    passed ? kleur.green().bold('✓ PASS') : kleur.yellow('iterating'),
  ].join(' | ');

  console.log(line);
  return { passed, diff, audit };
}

main().catch(err => { console.error(err); process.exit(1); });
