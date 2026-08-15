#!/usr/bin/env node
// Honest live-path test: mutate a text node, convert again, PDF must change.
// Covers htmlToPdf(element) via outerHTML and htmlToPdf(element, { live: true }).

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.ttf': 'font/ttf',
};

const FIXTURE = `<!doctype html>
<html><head><meta charset="utf-8">
<style>
  @font-face { font-family: Inter; src: url('/assets/fonts/Inter-400.ttf'); font-weight: 400; }
  body { font-family: Inter, Arial, sans-serif; font-size: 24px; margin: 24px; }
</style></head>
<body><p id="msg">ALPHA-TOKEN</p></body></html>`;

async function pdfText(bytes) {
  const data = new Uint8Array(bytes);
  const pdf = await pdfjsLib.getDocument({
    data,
    standardFontDataUrl: require.resolve('pdfjs-dist/package.json').replace(/package.json$/, 'standard_fonts/'),
  }).promise;
  const page = await pdf.getPage(1);
  const content = await page.getTextContent();
  return content.items.map(i => i.str).join(' ');
}

async function main() {
  await mkdir(resolve(ROOT, 'dist'), { recursive: true });
  const tmpHtml = resolve(ROOT, 'dist', '_live-text.html');
  await writeFile(tmpHtml, FIXTURE);

  const server = createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      const full = resolve(ROOT, `.${pathname}`);
      if (!full.startsWith(ROOT)) return res.writeHead(403).end();
      if (!(await stat(full)).isFile()) throw new Error('nf');
      res.writeHead(200, { 'Content-Type': MIME[extname(full)] || 'application/octet-stream' });
      res.end(await readFile(full));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  const fails = [];

  try {
    const page = await browser.newPage({ viewport: { width: 400, height: 200 }, deviceScaleFactor: 1 });
    await page.goto(`${origin}/dist/_live-text.html`, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => import('/src/index.js'));

    async function convert(live) {
      const b64 = await page.evaluate(async (live) => {
        const { htmlToPdf } = await import('/src/index.js');
        const el = document.getElementById('msg');
        const bytes = await htmlToPdf(el, { viewport: { width: 400, height: 200 }, live });
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return btoa(bin);
      }, live);
      return Buffer.from(b64, 'base64');
    }

    for (const live of [false, true]) {
      await page.evaluate(() => { document.getElementById('msg').textContent = 'ALPHA-TOKEN'; });
      const before = await convert(live);
      const textBefore = await pdfText(before);
      if (!/ALPHA-TOKEN/i.test(textBefore.replace(/\s+/g, ''))) {
        fails.push(`live=${live} first convert missing ALPHA-TOKEN (got ${JSON.stringify(textBefore)})`);
      }
      if (/BRAVO-TOKEN/i.test(textBefore.replace(/\s+/g, ''))) {
        fails.push(`live=${live} first convert already has BRAVO-TOKEN`);
      }

      await page.evaluate(() => { document.getElementById('msg').textContent = 'BRAVO-TOKEN'; });
      const after = await convert(live);
      const textAfter = await pdfText(after);
      const compact = textAfter.replace(/\s+/g, '');
      if (!/BRAVO-TOKEN/i.test(compact)) {
        fails.push(`live=${live} after mutate missing BRAVO-TOKEN (got ${JSON.stringify(textAfter)})`);
      }
      if (/ALPHA-TOKEN/i.test(compact)) {
        fails.push(`live=${live} after mutate still has ALPHA-TOKEN (stale cache)`);
      }
    }
  } finally {
    await browser.close();
    await new Promise(r => server.close(r));
  }

  if (fails.length) {
    console.error('live-text FAIL');
    for (const f of fails) console.error('  -', f);
    process.exitCode = 1;
    return;
  }
  console.log('live-text: 2 paths × mutate ok');
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
