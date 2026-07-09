#!/usr/bin/env node

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { rasterize } from './pdf-to-png.mjs';
import { diffPngs } from './diff.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'benchmark');
const ASSETS = resolve(ROOT, 'docs', 'assets');
const ITERATIONS = Math.max(3, Number.parseInt(process.env.BENCH_ITERATIONS || '7', 10));
const VIEWPORT = { width: 1123, height: 794 };

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
  '.woff2': 'font/woff2',
  '.pdf': 'application/pdf',
};

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))];
}

function stats(values) {
  return {
    medianMs: Number(percentile(values, 0.5).toFixed(1)),
    p95Ms: Number(percentile(values, 0.95).toFixed(1)),
    minMs: Number(Math.min(...values).toFixed(1)),
    samplesMs: values.map(v => Number(v.toFixed(1))),
  };
}

async function startServer() {
  const server = createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      const relative = pathname === '/' ? '/demo/run.html' : pathname;
      const full = resolve(ROOT, `.${relative}`);
      if (!full.startsWith(ROOT)) {
        res.writeHead(403).end();
        return;
      }
      const info = await stat(full);
      if (!info.isFile()) throw new Error('Not a file');
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

async function main() {
  await mkdir(OUT, { recursive: true });
  await mkdir(ASSETS, { recursive: true });
  const html = await readFile(resolve(ROOT, 'reference', 'source.html'), 'utf8');
  const { server, port } = await startServer();
  const browser = await chromium.launch({ args: ['--disable-lcd-text'] });

  try {
    const referencePage = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    await referencePage.goto(`http://127.0.0.1:${port}/reference/source.html`, { waitUntil: 'networkidle' });
    await referencePage.evaluate(() => document.fonts.ready);
    await referencePage.screenshot({ path: resolve(ASSETS, 'html-reference.png') });
    await referencePage.emulateMedia({ media: 'screen' });

    const playwrightColdStarted = performance.now();
    let playwrightPdf = await referencePage.pdf({
      width: `${VIEWPORT.width}px`,
      height: `${VIEWPORT.height}px`,
      printBackground: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
    });
    const playwrightColdMs = performance.now() - playwrightColdStarted;
    const playwrightTimes = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const started = performance.now();
      playwrightPdf = await referencePage.pdf({
        width: `${VIEWPORT.width}px`,
        height: `${VIEWPORT.height}px`,
        printBackground: true,
        margin: { top: 0, right: 0, bottom: 0, left: 0 },
      });
      playwrightTimes.push(performance.now() - started);
    }
    await writeFile(resolve(OUT, 'playwright.pdf'), playwrightPdf);

    const runner = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    await runner.goto(`http://127.0.0.1:${port}/demo/run.html`, { waitUntil: 'networkidle' });
    await runner.evaluate(() => import('/src/index.js'));

    async function generateWithDominate() {
      return runner.evaluate(async ({ htmlString, viewport }) => {
        const { htmlToPdf } = await import('/src/index.js');
        const started = performance.now();
        const bytes = await htmlToPdf(htmlString, { viewport });
        const elapsed = performance.now() - started;
        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
        }
        return { elapsed, base64: btoa(binary) };
      }, { htmlString: html, viewport: VIEWPORT });
    }

    const dominateCold = await generateWithDominate();
    await generateWithDominate(); // Let font parsing/JIT caches settle before steady-state samples.
    const dominateTimes = [];
    let dominateBytes = Buffer.from(dominateCold.base64, 'base64');
    for (let i = 0; i < ITERATIONS; i++) {
      const result = await generateWithDominate();
      dominateTimes.push(result.elapsed);
      dominateBytes = Buffer.from(result.base64, 'base64');
    }
    await writeFile(resolve(OUT, 'dominate.pdf'), dominateBytes);

    await rasterize(resolve(OUT, 'dominate.pdf'), resolve(ASSETS, 'dominate-output.png'), { dpi: 96 });
    await rasterize(resolve(OUT, 'playwright.pdf'), resolve(ASSETS, 'playwright-output.png'), { dpi: 96 });
    const dominateDiff = await diffPngs(
      resolve(ASSETS, 'html-reference.png'),
      resolve(ASSETS, 'dominate-output.png'),
      resolve(OUT, 'dominate.diff.png'),
    );
    const playwrightDiff = await diffPngs(
      resolve(ASSETS, 'html-reference.png'),
      resolve(ASSETS, 'playwright-output.png'),
      resolve(OUT, 'playwright.diff.png'),
    );

    const results = {
      generatedAt: new Date().toISOString(),
      fixture: 'reference/source.html',
      viewport: VIEWPORT,
      iterations: ITERATIONS,
      environment: {
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        playwrightChromium: browser.version(),
      },
      dominate: {
        coldMs: Number(dominateCold.elapsed.toFixed(1)),
        ...stats(dominateTimes),
        pdfBytes: dominateBytes.byteLength,
        pixelDiffPercent: Number(dominateDiff.percent.toFixed(3)),
      },
      playwright: {
        coldMs: Number(playwrightColdMs.toFixed(1)),
        ...stats(playwrightTimes),
        pdfBytes: playwrightPdf.byteLength,
        pixelDiffPercent: Number(playwrightDiff.percent.toFixed(3)),
      },
      methodology: 'Loaded document and fonts, generation call only; one cold call, one unmeasured warm-up, then seven steady-state samples by default.',
    };
    await writeFile(resolve(OUT, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);

    console.log(JSON.stringify(results, null, 2));
  } finally {
    await browser.close();
    await new Promise(resolveClosed => server.close(resolveClosed));
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
