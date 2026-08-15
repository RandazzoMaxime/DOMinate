#!/usr/bin/env node
// Local-only dataset bench. HTML lives in example/ (gitignored) and is never
// published as images. Times DOMinate htmlToPdf vs Chromium page.pdf on at
// least 10 varied documents, including a long (~50 page) book.

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pdfPageCount } from './pdf-to-png.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'benchmark');
const A4 = { width: 794, height: 1123 };
const ITER_SMALL = Math.max(3, Number.parseInt(process.env.BENCH_ITERATIONS || '5', 10));
const ITER_LARGE = 3;

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
};

const EXISTING = [
  {
    id: 'landing',
    rel: 'example/templatemo_550_diagoona/index.html',
    viewport: { width: 1280, height: 800 },
    kind: 'existing-landing',
    source: 'local template (already used in README)',
  },
  {
    id: 'invoice',
    rel: 'example/Ivonne - Template/hotel-booking-invoice.html',
    viewport: { width: 794, height: 1200 },
    kind: 'existing-invoice',
    source: 'local template (already used in README)',
  },
  {
    id: 'sow',
    rel: 'example/dominate-sow.html',
    viewport: A4,
    kind: 'existing-sow',
    source: 'local 4-page SOW fixture',
  },
];

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))];
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
  await new Promise(ready => server.listen(0, '127.0.0.1', ready));
  return { server, port: server.address().port };
}

function withBase(html, baseUrl) {
  if (!baseUrl || /<base\s/i.test(html)) return html;
  const href = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const tag = `<base href="${href}">`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, m => `${m}${tag}`);
  return `${tag}${html}`;
}

async function loadFixtures() {
  const fixtures = [];
  for (const row of EXISTING) {
    try {
      await stat(resolve(ROOT, row.rel));
      fixtures.push(row);
    } catch {
      console.error(`skip missing ${row.id}: ${row.rel}`);
    }
  }
  try {
    const manifest = JSON.parse(await readFile(resolve(ROOT, 'example/dataset/manifest.json'), 'utf8'));
    for (const row of manifest) {
      fixtures.push({
        id: row.id,
        rel: row.file,
        viewport: A4,
        kind: row.kind,
        source: row.url,
        bytes: row.bytes,
      });
    }
  } catch {
    console.error('example/dataset/manifest.json missing — run: node scripts/fetch-dataset.mjs');
  }
  return fixtures;
}

async function main() {
  const fixtures = await loadFixtures();
  if (fixtures.length < 10) {
    console.error(`need ≥10 fixtures, have ${fixtures.length}. Run node scripts/fetch-dataset.mjs`);
    process.exitCode = 1;
    return;
  }

  await mkdir(OUT, { recursive: true });
  const { server, port } = await startServer();
  const origin = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch({ args: ['--disable-lcd-text'] });
  const rows = [];
  try {
  const runner = await browser.newPage({ viewport: { width: 1400, height: 1200 }, deviceScaleFactor: 1 });
  await runner.goto(`${origin}/demo/run.html`, { waitUntil: 'domcontentloaded' });
  await runner.evaluate(() => import('/src/index.js'));
    for (const fx of fixtures) {
      const raw = await readFile(resolve(ROOT, fx.rel), 'utf8');
      const dir = dirname(fx.rel).replace(/\\/g, '/');
      const html = withBase(raw, `${origin}/${dir}/`);
      const large = (fx.bytes || Buffer.byteLength(raw)) > 280_000 || fx.kind === 'book' || fx.kind === 'spec';
      const iters = large ? ITER_LARGE : ITER_SMALL;

      async function dominateOnce() {
        return runner.evaluate(async ({ htmlString, viewport, baseUrl }) => {
          const { htmlToPdf } = await import('/src/index.js');
          const t0 = performance.now();
          const bytes = await htmlToPdf(htmlString, { viewport, baseUrl });
          const elapsed = performance.now() - t0;
          let binary = '';
          for (let offset = 0; offset < bytes.length; offset += 0x8000) {
            binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
          }
          return { elapsed, base64: btoa(binary) };
        }, { htmlString: html, viewport: fx.viewport, baseUrl: `${origin}/${dir}/` });
      }

      process.stderr.write(`  ${fx.id} dominate warmup…\n`);
      let lastDom;
      try {
        lastDom = await dominateOnce();
      } catch (error) {
        console.error(`  ${fx.id} FAIL dominate: ${error.message}`);
        rows.push({ id: fx.id, kind: fx.kind, source: fx.source, error: error.message });
        continue;
      }

      const dTimes = [];
      for (let i = 0; i < iters; i++) {
        lastDom = await dominateOnce();
        dTimes.push(lastDom.elapsed);
      }
      const pdfBytes = Buffer.from(lastDom.base64, 'base64');
      const magic = pdfBytes.subarray(0, 5).toString('latin1');
      let pages = 0;
      try {
        pages = await pdfPageCount(pdfBytes);
      } catch (error) {
        console.error(`  ${fx.id} page-count failed: ${error.message}`);
      }

      let pwMedian = null;
      let pwPages = null;
      try {
        const shot = await browser.newPage({ viewport: fx.viewport, deviceScaleFactor: 1 });
        await shot.goto(`${origin}/${fx.rel.replace(/\\/g, '/')}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await shot.evaluate(() => document.fonts?.ready).catch(() => {});
        const pdfOpts = fx.id === 'landing'
          ? {
            width: `${fx.viewport.width}px`,
            height: `${fx.viewport.height}px`,
            printBackground: true,
            margin: { top: '0', right: '0', bottom: '0', left: '0' },
          }
          : { format: 'A4', printBackground: true, margin: { top: '0', right: '0', bottom: '0', left: '0' } };
        await shot.pdf(pdfOpts);
        const pwTimes = [];
        let lastPw;
        for (let i = 0; i < iters; i++) {
          const t0 = performance.now();
          lastPw = await shot.pdf(pdfOpts);
          pwTimes.push(performance.now() - t0);
        }
        pwMedian = Number(percentile(pwTimes, 0.5).toFixed(1));
        try { pwPages = await pdfPageCount(lastPw); } catch { pwPages = null; }
        await shot.close();
      } catch (error) {
        console.error(`  ${fx.id} playwright skip: ${error.message}`);
      }

      const row = {
        id: fx.id,
        kind: fx.kind,
        source: fx.source,
        htmlKiB: Number((Buffer.byteLength(raw) / 1024).toFixed(1)),
        iterations: iters,
        dominateMs: Number(percentile(dTimes, 0.5).toFixed(1)),
        dominateMinMs: Number(Math.min(...dTimes).toFixed(1)),
        playwrightMs: pwMedian,
        dominatePages: pages,
        playwrightPages: pwPages,
        pdfKiB: Number((pdfBytes.length / 1024).toFixed(1)),
        validPdf: magic === '%PDF-',
      };
      rows.push(row);
      const pw = pwMedian == null ? 'n/a' : `${pwMedian.toFixed(1)} ms`;
      console.log(
        `${fx.id.padEnd(22)}  ${row.dominateMs.toFixed(1).padStart(8)} ms  `
        + `${String(pages).padStart(4)}p  ${row.pdfKiB.toFixed(0).padStart(6)} KiB  `
        + `pw ${pw.padStart(10)}  ${row.validPdf ? 'ok' : 'BAD'}`,
      );
    }
  } finally {
    await browser.close();
    await new Promise(done => server.close(done));
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    note: 'Local web-HTML dataset. Source HTML and rasters are not published.',
    fixtures: rows,
  };
  await writeFile(resolve(OUT, 'dataset.json'), `${JSON.stringify(payload, null, 2)}\n`);

  const ok = rows.filter(r => r.validPdf);
  const long = ok.filter(r => (r.dominatePages || 0) >= 40);
  console.log('');
  console.log(`${ok.length}/${rows.length} converted. ≥40-page docs: ${long.map(r => `${r.id} ${r.dominatePages}p ${r.dominateMs}ms`).join(', ') || 'none'}`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
