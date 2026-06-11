#!/usr/bin/env node
// Print a small patch of reference/<stem>.png and dist/<stem>.png side by side as
// ASCII luminance art. For micro-tuning positions (bullets, baselines, borders).
//
// Usage: node scripts/inspect-patch.mjs <stem> <x> <y> <w> <h>

import { readFile } from 'node:fs/promises';
import { PNG } from 'pngjs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [stem, X, Y, W, H] = process.argv.slice(2);
const x0 = +X, y0 = +Y, w = Math.min(+W || 40, 110), h = +H || 20;

const ref = PNG.sync.read(await readFile(resolve(ROOT, 'reference', stem + '.png')));
const out = PNG.sync.read(await readFile(resolve(ROOT, 'dist', stem + '.png')));

const RAMP = ' .:-=+*#%@';
function row(png, y) {
  let s = '';
  for (let x = x0; x < x0 + w; x++) {
    if (x < 0 || x >= png.width || y < 0 || y >= png.height) { s += '?'; continue; }
    const i = (y * png.width + x) * 4;
    const lum = 0.299 * png.data[i] + 0.587 * png.data[i + 1] + 0.114 * png.data[i + 2];
    s += RAMP[Math.min(9, Math.floor((255 - lum) / 25.6))];
  }
  return s;
}

console.log(`patch ${stem} @ (${x0},${y0}) ${w}x${h} — REF | DIST`);
for (let y = y0; y < y0 + h; y++) {
  console.log(row(ref, y) + ' | ' + row(out, y));
}
