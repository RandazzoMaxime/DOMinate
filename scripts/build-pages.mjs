#!/usr/bin/env node
// Bundle the library + fonts into docs/app/dominate.js for GitHub Pages.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FONT_DIR = join(ROOT, 'assets', 'fonts');
const OUT_DIR = join(ROOT, 'docs', 'app');
const SKIP = new Set(['MaterialSymbolsOutlined.ttf']);

const map = {};
for (const name of readdirSync(FONT_DIR)) {
  if (!name.endsWith('.ttf') || SKIP.has(name)) continue;
  const buf = await readFile(join(FONT_DIR, name));
  map[`/assets/fonts/${name}`] = buf.toString('base64');
}

await mkdir(OUT_DIR, { recursive: true });
const prelude = `globalThis.__DOMINATE_BUNDLED_FONTS__=${JSON.stringify(map)};`;
await esbuild.build({
  entryPoints: [join(ROOT, 'src', 'index.js')],
  bundle: true,
  format: 'esm',
  outfile: join(OUT_DIR, 'dominate.js'),
  banner: { js: prelude },
  logLevel: 'info',
});
await writeFile(join(ROOT, 'docs', '.nojekyll'), '');
const built = await readFile(join(OUT_DIR, 'dominate.js'));
console.log(`docs/app/dominate.js  ${(built.length / 1024).toFixed(0)} KiB  (${Object.keys(map).length} fonts)`);
