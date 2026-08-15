#!/usr/bin/env node
// Convert local DOMinate-themed examples and validate visual parity.
// HTML fixtures stay in example/ (gitignored). Published artifacts are PNGs.
//
// Multi-page documents: rasterize every PDF page and pixel-diff it against
// the matching HTML band (same protocol as scripts/loop.mjs).

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, readFile, stat, writeFile, copyFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { rasterize, rasterizeAll } from './pdf-to-png.mjs';
import { diffPngs } from './diff.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = resolve(ROOT, 'docs', 'assets');
const OUT = resolve(ROOT, 'benchmark');
const MAX_DIFF_PCT = Number.parseFloat(process.env.EXAMPLE_MAX_DIFF || '12');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.eot': 'application/vnd.ms-fontobject',
  '.pdf': 'application/pdf',
};

const EXAMPLES = [
  {
    name: 'invoice',
    rel: 'example/Ivonne - Template/hotel-booking-invoice.html',
    viewport: { width: 794, height: 1200 },
  },
  {
    name: 'report',
    rel: 'example/dominate-sow.html',
    viewport: { width: 794, height: 1123 },
    multipage: true,
  },
];

function withBase(html, baseUrl) {
  if (!baseUrl) return html;
  const href = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const tag = `<base href="${href}">`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, m => `${m}${tag}`);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, m => `${m}<head>${tag}</head>`);
  return `${tag}${html}`;
}

async function startServer() {
  const server = createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      const full = resolve(ROOT, `.${pathname === '/' ? '/demo/run.html' : pathname}`);
      if (!full.startsWith(ROOT)) return res.writeHead(403).end();
      if (!(await stat(full)).isFile()) throw new Error('Not a file');
      res.writeHead(200, {
        'Content-Type': MIME[extname(full)] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(await readFile(full));
    } catch (error) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(error.message);
    }
  });
  await new Promise(resolveReady => server.listen(0, '127.0.0.1', resolveReady));
  return { server, port: server.address().port };
}

function stitchVertical(pngBuffers) {
  const decoded = pngBuffers.map(buf => PNG.sync.read(buf));
  const width = Math.max(...decoded.map(p => p.width));
  const gap = 16;
  const height = decoded.reduce((s, p) => s + p.height, 0) + gap * (decoded.length - 1);
  const out = new PNG({ width, height });
  out.data.fill(230);
  let y = 0;
  for (const p of decoded) {
    for (let row = 0; row < p.height; row++) {
      const src = row * p.width * 4;
      const dst = ((y + row) * width) * 4;
      p.data.copy(out.data, dst, src, src + p.width * 4);
    }
    y += p.height + gap;
  }
  return PNG.sync.write(out);
}

async function main() {
  await mkdir(ASSETS, { recursive: true });
  await mkdir(OUT, { recursive: true });

  const { server, port } = await startServer();
  const origin = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch({ args: ['--disable-lcd-text'] });
  const results = [];

  try {
    const runner = await browser.newPage({
      viewport: { width: 1280, height: 1123 },
      deviceScaleFactor: 1,
    });
    await runner.goto(`${origin}/demo/run.html`, { waitUntil: 'networkidle' });
    await runner.evaluate(() => import('/src/index.js'));

    for (const ex of EXAMPLES) {
      const htmlPath = resolve(ROOT, ex.rel);
      try {
        await stat(htmlPath);
      } catch {
        console.error(`skip ${ex.name}: ${ex.rel} not found (local-only fixture)`);
        continue;
      }

      const pageUrl = `${origin}/${ex.rel.replace(/\\/g, '/')}`;
      const shot = await browser.newPage({ viewport: ex.viewport, deviceScaleFactor: 1 });
      await shot.goto(pageUrl, { waitUntil: 'networkidle' });
      await shot.evaluate(() => document.fonts.ready);
      await new Promise(r => setTimeout(r, 150));

      const htmlPng = resolve(ASSETS, `example-${ex.name}-html.png`);
      await shot.screenshot({ path: htmlPng, fullPage: false });

      const raw = await readFile(htmlPath, 'utf8');
      const dir = dirname(ex.rel).replace(/\\/g, '/');
      const html = withBase(raw, `${origin}/${dir}/`);

      const generated = await runner.evaluate(async ({ htmlString, viewport, baseUrl }) => {
        const { htmlToPdf } = await import('/src/index.js');
        const started = performance.now();
        const bytes = await htmlToPdf(htmlString, { viewport, baseUrl });
        const elapsed = performance.now() - started;
        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
        }
        return { elapsed, base64: btoa(binary) };
      }, { htmlString: html, viewport: ex.viewport, baseUrl: `${origin}/${dir}/` });

      const pdfBytes = Buffer.from(generated.base64, 'base64');
      const pdfPath = resolve(OUT, `example-${ex.name}.pdf`);
      await writeFile(pdfPath, pdfBytes);

      const all = await rasterizeAll(pdfPath, { dpi: 96 });
      const pdfPng = resolve(ASSETS, `example-${ex.name}-pdf.png`);
      await writeFile(pdfPng, all.pages[0].png);

      const pageDiffs = [];
      if (ex.multipage && all.pages.length > 1) {
        const pagePngs = [];
        for (const page of all.pages) {
          const pagePdfPath = resolve(ASSETS, `example-${ex.name}-pdf-${page.index}.png`);
          await writeFile(pagePdfPath, page.png);
          pagePngs.push(page.png);

          const y = (page.index - 1) * ex.viewport.height;
          const htmlBand = resolve(OUT, `example-${ex.name}-html-p${page.index}.png`);
          await shot.screenshot({
            path: htmlBand,
            fullPage: true,
            clip: {
              x: 0,
              y,
              width: ex.viewport.width,
              height: ex.viewport.height,
            },
          });
          const diffPath = resolve(OUT, `example-${ex.name}-p${page.index}.diff.png`);
          const diff = await diffPngs(htmlBand, pagePdfPath, diffPath);
          pageDiffs.push({
            page: page.index,
            diffPercent: Number(diff.percent.toFixed(3)),
            diffPx: diff.diffPx,
            totalPx: diff.totalPx,
            pass: diff.percent < MAX_DIFF_PCT,
          });
          console.log(
            `${ex.name.padEnd(8)}  p${page.index}  diff ${diff.percent.toFixed(3).padStart(7)}%  `
            + `${diff.percent < MAX_DIFF_PCT ? 'PASS' : 'FAIL'}`,
          );
        }
        await writeFile(resolve(ASSETS, `example-${ex.name}-pages.png`), stitchVertical(pagePngs));
      } else {
        await rasterize(pdfPath, pdfPng, { dpi: 96 });
        const diffPath = resolve(OUT, `example-${ex.name}.diff.png`);
        const diff = await diffPngs(htmlPng, pdfPng, diffPath);
        await copyFile(diffPath, resolve(ASSETS, `example-${ex.name}-diff.png`));
        pageDiffs.push({
          page: 1,
          diffPercent: Number(diff.percent.toFixed(3)),
          diffPx: diff.diffPx,
          totalPx: diff.totalPx,
          pass: diff.percent < MAX_DIFF_PCT,
        });
      }

      await shot.close();

      const worst = pageDiffs.reduce((a, b) => (b.diffPercent > a.diffPercent ? b : a));
      const row = {
        name: ex.name,
        elapsedMs: Number(generated.elapsed.toFixed(1)),
        pdfBytes: pdfBytes.byteLength,
        pageCount: all.pageCount,
        diffPercent: worst.diffPercent,
        pages: pageDiffs,
        pass: pageDiffs.every(p => p.pass),
      };
      results.push(row);
      console.log(
        `${ex.name.padEnd(8)}  html→pdf ${row.elapsedMs.toFixed(1).padStart(7)} ms  `
        + `${row.pageCount}p  worst-diff ${row.diffPercent.toFixed(3)}%  ${row.pass ? 'PASS' : 'FAIL'}`,
      );
    }
  } finally {
    await browser.close();
    await new Promise(resolveClosed => server.close(resolveClosed));
  }

  if (!results.length) {
    console.error('no local examples to convert');
    process.exitCode = 1;
    return;
  }

  await writeFile(resolve(OUT, 'examples.json'), `${JSON.stringify({ maxDiffPct: MAX_DIFF_PCT, results }, null, 2)}\n`);
  const failed = results.filter(r => !r.pass);
  if (failed.length) {
    console.error(`visual parity failed for: ${failed.map(r => r.name).join(', ')}`);
    process.exitCode = 1;
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
