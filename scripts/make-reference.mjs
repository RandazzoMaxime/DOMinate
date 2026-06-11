#!/usr/bin/env node
// Generate Chromium ground-truth for a fixture: reference/<stem>.png + <stem>.audit.json.
//
// Usage: node scripts/make-reference.mjs <stem> [stem2 ...] [--viewport 1123x794]
//
// Renders reference/<stem>.html in headless Chromium (served over HTTP so that
// /assets/fonts/... @font-face URLs resolve exactly like they do for the lib's
// hidden-iframe walker), waits for fonts + layout to settle with the SAME wait
// sequence as src/dom/walker.js, then screenshots the viewport at dpr 1.
//
// The audit JSON is auto-generated: expectedLinks = every a[href]'s raw href,
// expectedTextFragments = headings/captions/th text (deduped, first 10).

import { chromium } from 'playwright';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { resolve, dirname, extname } from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff2': 'font/woff2',
};

function startServer() {
  return new Promise((resolveServer) => {
    const server = createServer(async (req, res) => {
      try {
        let p = decodeURIComponent(req.url.split('?')[0]);
        const full = resolve(ROOT, '.' + p);
        if (!full.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
        const s = await stat(full);
        if (s.isDirectory()) { res.writeHead(404); return res.end(); }
        const data = await readFile(full);
        res.writeHead(200, { 'Content-Type': MIME[extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
        res.end(data);
      } catch (e) { res.writeHead(404); res.end(String(e?.message || e)); }
    });
    server.listen(0, '127.0.0.1', () => resolveServer({ server, port: server.address().port }));
  });
}

async function main() {
  const args = process.argv.slice(2);
  let viewport = { width: 1123, height: 794 };
  const stems = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--viewport') {
      const [w, h] = args[++i].split('x').map(Number);
      viewport = { width: w, height: h };
    } else stems.push(args[i].replace(/\.html$/, ''));
  }
  if (!stems.length) { console.error('usage: make-reference.mjs <stem> [--viewport WxH]'); process.exit(1); }

  const { server, port } = await startServer();
  // --disable-lcd-text: capture with grayscale anti-aliasing. ClearType-style RGB
  // subpixel fringes are a display artifact (R/G/B-asymmetric edge pixels), not part
  // of the page's geometric rendering — and the loop's pdfjs rasterizer is grayscale,
  // so LCD fringes in the ground truth would only add irreducible noise.
  const browser = await chromium.launch({ args: ['--disable-lcd-text'] });
  try {
    for (const stem of stems) {
      const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
      await page.goto(`http://127.0.0.1:${port}/reference/${stem}.html`, { waitUntil: 'networkidle' });
      // Same settle sequence as the walker: fonts.ready, 2 rAF, 100 ms.
      await page.evaluate(async () => {
        if (document.fonts && document.fonts.ready) {
          await Promise.race([document.fonts.ready, new Promise(r => setTimeout(r, 3000))]);
        }
        await new Promise(r => requestAnimationFrame(() => r()));
        await new Promise(r => requestAnimationFrame(() => r()));
        await new Promise(r => setTimeout(r, 100));
      });
      await page.screenshot({ path: resolve(ROOT, 'reference', stem + '.png') });

      const audit = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a[href]')).map(a => a.getAttribute('href'));
        const frags = [];
        for (const el of document.querySelectorAll('h1,h2,h3,caption,th,figcaption,legend')) {
          const t = el.textContent.replace(/\s+/g, ' ').trim();
          if (t && t.length <= 40 && !frags.includes(t)) frags.push(t);
          if (frags.length >= 10) break;
        }
        return { links, frags };
      });
      await writeFile(
        resolve(ROOT, 'reference', stem + '.audit.json'),
        JSON.stringify({ viewport, screenshotScale: 1, expectedLinks: audit.links, expectedTextFragments: audit.frags }, null, 2),
      );
      console.log(`reference/${stem}.png + ${stem}.audit.json  (${audit.links.length} links, ${audit.frags.length} fragments)`);
      await page.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
