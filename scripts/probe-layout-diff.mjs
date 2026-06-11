#!/usr/bin/env node
// Compare element rects between a direct page load and the lib's document.write
// iframe for a fixture. Prints the first N elements whose rects differ > 0.5px.
// Usage: node scripts/probe-layout-diff.mjs <stem>
import { chromium } from 'playwright';
import { readFile, stat } from 'node:fs/promises';
import { resolve, dirname, extname } from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stem = process.argv[2] || 'report';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.ttf': 'font/ttf', '.png': 'image/png', '.jpg': 'image/jpeg' };

const server = await new Promise((res) => {
  const s = createServer(async (req, rsp) => {
    try {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/') p = '/demo/run.html';
      const data = await readFile(resolve(ROOT, '.' + p));
      rsp.writeHead(200, { 'Content-Type': MIME[extname(p)] || 'application/octet-stream' });
      rsp.end(data);
    } catch { rsp.writeHead(404); rsp.end(); }
  });
  s.listen(0, '127.0.0.1', () => res(s));
});
const port = server.address().port;

const html = await readFile(resolve(ROOT, 'reference', stem + '.html'), 'utf8');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1123, height: 794 }, deviceScaleFactor: 1 });

const SNAP = `(doc) => {
  const out = [];
  const walk = (el, path) => {
    if (!el || el.nodeType !== 1) return;
    const cs = doc.defaultView.getComputedStyle(el);
    if (cs.display === 'none') return;
    const r = el.getBoundingClientRect();
    out.push({ path, x: r.left, y: r.top, w: r.width, h: r.height });
    let i = 0;
    for (const c of el.children) walk(c, path + '>' + c.tagName.toLowerCase() + (i++));
  };
  walk(doc.body, 'body');
  return out;
}`;

await page.goto(`http://127.0.0.1:${port}/reference/${stem}.html`, { waitUntil: 'networkidle' });
const direct = await page.evaluate(`(async () => {
  await document.fonts.ready;
  await new Promise(r => requestAnimationFrame(() => r()));
  await new Promise(r => requestAnimationFrame(() => r()));
  await new Promise(r => setTimeout(r, 100));
  return (${SNAP})(document);
})()`);

await page.goto(`http://127.0.0.1:${port}/demo/run.html`, { waitUntil: 'networkidle' });
const inIframe = await page.evaluate(`(async () => {
  const html = ${JSON.stringify(html)};
  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'position:fixed;left:-10000px;top:0;width:1123px;height:794px;border:0;visibility:hidden;';
  document.body.appendChild(iframe);
  const idoc = iframe.contentDocument;
  idoc.open(); idoc.write(html); idoc.close();
  if (iframe.contentWindow.document.readyState !== 'complete') {
    await Promise.race([
      new Promise(r => iframe.addEventListener('load', r, { once: true })),
      new Promise(r => setTimeout(r, 4000)),
    ]);
  }
  await Promise.race([idoc.fonts.ready, new Promise(r => setTimeout(r, 3000))]);
  await new Promise(r => requestAnimationFrame(() => r()));
  await new Promise(r => requestAnimationFrame(() => r()));
  await new Promise(r => setTimeout(r, 100));
  return (${SNAP})(idoc);
})()`);

console.log(`direct: ${direct.length} els, iframe: ${inIframe.length} els`);
const byPath = new Map(direct.map(e => [e.path, e]));
let shown = 0, diffCount = 0;
for (const e of inIframe) {
  const d = byPath.get(e.path);
  if (!d) { if (shown < 5) console.log('MISSING in direct:', e.path); shown++; continue; }
  const dx = Math.abs(d.x - e.x), dy = Math.abs(d.y - e.y), dw = Math.abs(d.w - e.w), dh = Math.abs(d.h - e.h);
  if (dx > 0.5 || dy > 0.5 || dw > 0.5 || dh > 0.5) {
    diffCount++;
    if (shown < 25) {
      console.log(`DIFF ${e.path.slice(0, 60)}  direct(${d.x.toFixed(1)},${d.y.toFixed(1)} ${d.w.toFixed(1)}x${d.h.toFixed(1)}) iframe(${e.x.toFixed(1)},${e.y.toFixed(1)} ${e.w.toFixed(1)}x${e.h.toFixed(1)})`);
      shown++;
    }
  }
}
console.log(`${diffCount} differing rects`);
await browser.close();
server.close();
