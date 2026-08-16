#!/usr/bin/env node
// Drives shipped htmlToPdf: a document whose dark paper is only selected by
// `@media (prefers-color-scheme: dark)` must paint #090D11 when the host (or
// opts.colorScheme) prefers dark, and the light :root paper when it prefers light.
// Does not use the operator's private Downloads HTML.

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const walkerSrc = await readFile(resolve(ROOT, 'src/dom/walker.js'), 'utf8');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.ttf': 'font/ttf',
};

const FIXTURE = `<!doctype html>
<html><head><meta charset="utf-8">
<meta name="color-scheme" content="light dark">
<style>
:root { --paper:#E8ECEF; --ink:#0C1418; }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { --paper:#090D11; --ink:#E3EBF1; }
}
:root[data-theme="dark"] { --paper:#090D11; --ink:#E3EBF1; }
body { margin:0; background:var(--paper); color:var(--ink); }
</style></head>
<body><p>scheme-probe</p></body></html>`;

const DARK = [9, 13, 17];
const LIGHT = [232, 236, 239];

function cornerAvg(pngBytes) {
  const img = PNG.sync.read(pngBytes);
  const at = (x, y) => {
    const i = (y * img.width + x) * 4;
    return [img.data[i], img.data[i + 1], img.data[i + 2]];
  };
  const pts = [at(4, 4), at(12, 8), at(24, 6), at(Math.max(4, img.width - 8), 6)];
  return pts.reduce((a, p) => [a[0] + p[0], a[1] + p[1], a[2] + p[2]], [0, 0, 0])
    .map((v) => Math.round(v / pts.length));
}

function near(got, want, tol = 18) {
  return Math.abs(got[0] - want[0]) <= tol
    && Math.abs(got[1] - want[1]) <= tol
    && Math.abs(got[2] - want[2]) <= tol;
}

let pass = 0;
let fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.log('  ✗', msg); }
}

assert(!/color-scheme:\s*light\s*;/.test(walkerSrc), 'layout iframe does not pin color-scheme: light');

const { server, port } = await new Promise((ok) => {
  const s = createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/' || p === '') p = '/demo/run.html';
      const full = resolve(ROOT, '.' + p);
      if (!full.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
      const st = await stat(full);
      if (st.isDirectory()) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': MIME[extname(full)] || 'application/octet-stream' });
      res.end(await readFile(full));
    } catch (e) {
      res.writeHead(404); res.end(String(e));
    }
  });
  s.listen(0, '127.0.0.1', () => ok({ server: s, port: s.address().port }));
});

const browser = await chromium.launch();
const { rasterizeAll } = await import('./pdf-to-png.mjs');
await mkdir(resolve(ROOT, 'dist'), { recursive: true });

async function convert(pageColorScheme, optsColorScheme) {
  const page = await browser.newPage({
    viewport: { width: 900, height: 700 },
    colorScheme: pageColorScheme,
    deviceScaleFactor: 1,
  });
  try {
    await page.goto(`http://127.0.0.1:${port}/demo/run.html`, { waitUntil: 'networkidle' });
    const b64 = await page.evaluate(async ({ html, colorScheme }) => {
      const { htmlToPdf } = await import('/src/index.js');
      const bytes = await htmlToPdf(html, {
        pageSize: 'A4',
        orientation: 'portrait',
        ...(colorScheme ? { colorScheme } : {}),
      });
      let bin = '';
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      return btoa(bin);
    }, { html: FIXTURE, colorScheme: optsColorScheme || null });
    return Buffer.from(b64, 'base64');
  } finally {
    await page.close();
  }
}

async function paperOf(pdfBuf, name) {
  const pdfPath = resolve(ROOT, 'dist', `color-scheme-${name}.pdf`);
  await writeFile(pdfPath, pdfBuf);
  const { pages } = await rasterizeAll(pdfPath, { dpi: 72 });
  return cornerAvg(pages[0].png);
}

try {
  const darkHost = await convert('dark', null);
  const darkAvg = await paperOf(darkHost, 'host-dark');
  assert(near(darkAvg, DARK), `host dark → paper near ${DARK} (got ${darkAvg})`);
  assert(!near(darkAvg, LIGHT), `host dark → paper is not light ${LIGHT}`);

  const lightHost = await convert('light', null);
  const lightAvg = await paperOf(lightHost, 'host-light');
  assert(near(lightAvg, LIGHT), `host light → paper near ${LIGHT} (got ${lightAvg})`);

  const forcedDark = await convert('light', 'dark');
  const forcedAvg = await paperOf(forcedDark, 'opts-dark');
  assert(near(forcedAvg, DARK), `opts.colorScheme=dark on light host → ${DARK} (got ${forcedAvg})`);
} finally {
  await browser.close();
  server.close();
}

console.log(`\ncolor-scheme: ${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
