#!/usr/bin/env node
// Cluster the differing pixels between reference/<stem>.png and dist/<stem>.png into
// connected components and print the top-N bounding boxes. Data-driven targeting:
// tells you WHERE the diff lives instead of eyeballing diff.png.
//
// Usage: node scripts/diff-regions.mjs <stem> [topN]

import { readFile } from 'node:fs/promises';
import { PNG } from 'pngjs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const stem = process.argv[2];
const topN = parseInt(process.argv[3] || '12', 10);
if (!stem) { console.error('usage: diff-regions.mjs <stem> [topN]'); process.exit(1); }

const ref = PNG.sync.read(await readFile(resolve(ROOT, 'reference', stem + '.png')));
const out = PNG.sync.read(await readFile(resolve(ROOT, 'dist', stem + '.png')));
const W = Math.min(ref.width, out.width), H = Math.min(ref.height, out.height);

// Mismatch mask (rough approximation of pixelmatch's threshold 0.1: max channel delta > 25).
const mask = new Uint8Array(W * H);
let total = 0;
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const ir = (y * ref.width + x) * 4, io = (y * out.width + x) * 4;
    const d = Math.max(
      Math.abs(ref.data[ir] - out.data[io]),
      Math.abs(ref.data[ir + 1] - out.data[io + 1]),
      Math.abs(ref.data[ir + 2] - out.data[io + 2]),
    );
    if (d > 25) { mask[y * W + x] = 1; total++; }
  }
}

// Connected components with a tolerance gap of 3px (dilate clustering): use BFS over
// cells of a coarse grid so nearby glyph-level specks merge into one logical region.
const CELL = 4;
const GW = Math.ceil(W / CELL), GH = Math.ceil(H / CELL);
const grid = new Uint32Array(GW * GH);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    if (mask[y * W + x]) grid[Math.floor(y / CELL) * GW + Math.floor(x / CELL)]++;
  }
}
const compId = new Int32Array(GW * GH).fill(-1);
const comps = [];
for (let gy = 0; gy < GH; gy++) {
  for (let gx = 0; gx < GW; gx++) {
    const gi = gy * GW + gx;
    if (!grid[gi] || compId[gi] !== -1) continue;
    const comp = { px: 0, minX: GW, minY: GH, maxX: 0, maxY: 0 };
    const stack = [gi];
    compId[gi] = comps.length;
    while (stack.length) {
      const ci = stack.pop();
      const cy = Math.floor(ci / GW), cx = ci % GW;
      comp.px += grid[ci];
      if (cx < comp.minX) comp.minX = cx;
      if (cx > comp.maxX) comp.maxX = cx;
      if (cy < comp.minY) comp.minY = cy;
      if (cy > comp.maxY) comp.maxY = cy;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const ny = cy + dy, nx = cx + dx;
          if (ny < 0 || ny >= GH || nx < 0 || nx >= GW) continue;
          const ni = ny * GW + nx;
          if (grid[ni] && compId[ni] === -1) { compId[ni] = comps.length; stack.push(ni); }
        }
      }
    }
    comps.push(comp);
  }
}

comps.sort((a, b) => b.px - a.px);
console.log(`${stem}: ${total} differing px (${(total / (W * H) * 100).toFixed(3)}%), ${comps.length} regions`);
for (const c of comps.slice(0, topN)) {
  const x = c.minX * CELL, y = c.minY * CELL;
  const w = (c.maxX - c.minX + 1) * CELL, h = (c.maxY - c.minY + 1) * CELL;
  console.log(`  ${String(c.px).padStart(7)} px  @ x=${x}..${x + w} y=${y}..${y + h}  (${w}x${h})`);
}
